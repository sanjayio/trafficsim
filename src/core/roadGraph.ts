import { MIN_CROSSING_ANGLE, MIN_ROAD_LENGTH, NODE_MERGE_DIST, NODE_SNAP_RADIUS } from "./constants";
import { isStraight, SampledCurve, splitCurve, straightCurve, type Curve } from "./curve";
import { distance, pointInConvexPolygon, segmentsIntersect, type Vec2 } from "./geometry";
import {
  DEFAULT_JUNCTION,
  isDefaultJunction,
  parseJunctionSettings,
  roundaboutShape,
  type JunctionSettings,
} from "./junction";
import { carriagewayWidth, DEFAULT_ROAD_SPEC, normalizeRoadSpec, parseRoadSpec, roadWidth, type RoadSpec } from "./roadSpec";

export type NodeId = number;
export type SegmentId = number;

export interface RoadNode {
  id: NodeId;
  x: number;
  y: number;
}

export interface RoadSegment {
  id: SegmentId;
  /** Start node. One-way roads flow from `a` to `b`. */
  a: NodeId;
  b: NodeId;
  spec: RoadSpec;
  /** Bézier controls shaping the road between its nodes; absent for straight roads. */
  controls?: [Vec2, Vec2];
}

/** Which side of the road traffic keeps to. A property of the city, saved with the map. */
export type DrivingSide = "right" | "left";

/**
 * Version 1 maps predate road specs (segments load with `DEFAULT_ROAD_SPEC`);
 * versions 1–2 predate curves (every segment is straight).
 */
export interface SavedMap {
  version: 1 | 2 | 3;
  /** Absent in maps saved before it existed: right-hand. */
  drivingSide?: DrivingSide;
  /** Junctions with non-default settings (absent in older maps). */
  junctions?: ({ node: NodeId } & JunctionSettings)[];
  nodes: RoadNode[];
  segments: (Omit<RoadSegment, "spec"> & { spec?: RoadSpec })[];
}

/** Where a planned road meets the existing network, creating (or reusing) a junction. */
export interface Crossing {
  point: Vec2;
  /** Bézier parameter on the planned road. */
  t: number;
  /** The existing node the junction uses, if any... */
  node?: RoadNode;
  /** ...otherwise the existing segment that gets split here. */
  segment?: RoadSegment;
  /** Angle between the roads, 0–90 degrees. */
  angle: number;
}

export interface RoadPlan {
  crossings: Crossing[];
  valid: boolean;
}

/** A road endpoint this close to another road's centre line joins it (the tool snaps onto it exactly). */
const ON_ROAD_TOLERANCE = 0.5;

export type GraphEvent =
  | { type: "segment-added"; segment: RoadSegment }
  | { type: "segment-removed"; segment: RoadSegment }
  | { type: "reset" }
  /** A network-wide setting changed (e.g. driving side); everything may need redrawing. */
  | { type: "settings" }
  | { type: "junction-changed"; nodeId: NodeId };

/**
 * The road network: intersections/endpoints (nodes) joined by segments, each a straight or
 * curved (cubic Bézier) road. Pure data — renderers and the simulation subscribe to changes.
 */
export class RoadGraph {
  readonly nodes = new Map<NodeId, RoadNode>();
  readonly segments = new Map<SegmentId, RoadSegment>();
  private side: DrivingSide = "right";
  /** Settings of junctions that differ from `DEFAULT_JUNCTION`. */
  private junctionSettings = new Map<NodeId, JunctionSettings>();
  private nextId = 1;
  /** Sampled centre line per segment, built when the segment is added. */
  private sampled = new Map<SegmentId, SampledCurve>();
  private listeners = new Set<(e: GraphEvent) => void>();

  subscribe(listener: (e: GraphEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get drivingSide(): DrivingSide {
    return this.side;
  }

  setDrivingSide(side: DrivingSide): void {
    if (side === this.side) return;
    this.side = side;
    this.emit({ type: "settings" });
  }

  junction(nodeId: NodeId): JunctionSettings {
    return this.junctionSettings.get(nodeId) ?? DEFAULT_JUNCTION;
  }

  setJunction(nodeId: NodeId, changes: Partial<JunctionSettings>): void {
    if (!this.nodes.has(nodeId)) return;
    const next = { ...this.junction(nodeId), ...changes };
    if (isDefaultJunction(next)) this.junctionSettings.delete(nodeId);
    else this.junctionSettings.set(nodeId, next);
    this.emit({ type: "junction-changed", nodeId });
  }

  /** A junction (three or more roads) whose paved area covers `p`, if any. */
  junctionAt(p: Vec2): RoadNode | undefined {
    let best: RoadNode | undefined;
    let bestDist = Infinity;
    for (const node of this.nodes.values()) {
      const meeting = this.segmentsAt(node.id);
      if (meeting.length < 3) continue;
      const d = distance(node, p);
      if (d < bestDist && d <= this.junctionRadius(node.id)) {
        best = node;
        bestDist = d;
      }
    }
    return best;
  }

  /** Rough radius of a junction's paved area (its roundabout, or its widest road). */
  junctionRadius(nodeId: NodeId): number {
    const specs = this.segmentsAt(nodeId).map((s) => s.spec);
    if (this.junction(nodeId).roundabout) return roundaboutShape(specs).outer;
    return Math.max(0, ...specs.map((s) => carriagewayWidth(s) / 2)) + 4;
  }

  node(id: NodeId): RoadNode {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`Unknown road node ${id}`);
    return node;
  }

  /** The segment's centre line, sampled by arc length. */
  path(segment: RoadSegment): SampledCurve {
    let sampled = this.sampled.get(segment.id);
    if (!sampled) {
      sampled = new SampledCurve(this.curveOf(segment));
      this.sampled.set(segment.id, sampled);
    }
    return sampled;
  }

  curveOf(segment: RoadSegment): Curve {
    const a = this.node(segment.a);
    const b = this.node(segment.b);
    if (!segment.controls) return straightCurve(a, b);
    return { a, c1: segment.controls[0], c2: segment.controls[1], b };
  }

  /**
   * Adds a road along `curve` as-is, reusing existing nodes at either end, without forming
   * junctions where it crosses other roads (see `buildRoad`). One-way roads flow a → b.
   */
  addRoad(curve: Curve, spec: RoadSpec): RoadSegment | null {
    if (distance(curve.a, curve.b) < NODE_MERGE_DIST) return null;
    const a = this.nodeAt(curve.a);
    const b = this.nodeAt(curve.b);
    if (this.findDuplicate(a.id, b.id, curve)) return null;
    return this.insertSegment(a.id, b.id, curve, normalizeRoadSpec(spec));
  }

  /**
   * Where a road along `curve` would meet the network, and whether it can be built: crossings
   * must not be too shallow, and no piece of either road may end up shorter than the minimum.
   */
  planRoad(curve: Curve): RoadPlan {
    const path = new SampledCurve(curve);
    const crossings: Crossing[] = [];
    const add = (c: Crossing) => {
      // Several hits at one spot (e.g. through an existing junction) are one crossing; prefer the node.
      const same = crossings.findIndex((o) => distance(o.point, c.point) < 1);
      if (same < 0) crossings.push(c);
      else if (c.node && !crossings[same].node) crossings[same] = c;
    };

    // Road ends that land on another road's centre line form T-junctions.
    for (const [end, t] of [[curve.a, 0], [curve.b, 1]] as const) {
      if (this.nodeNear(end, NODE_MERGE_DIST)) continue;
      for (const segment of this.segments.values()) {
        const nearest = this.path(segment).nearest(end);
        if (nearest.distance <= ON_ROAD_TOLERANCE) {
          add({ point: nearest.point, t, segment, angle: 90 });
          break;
        }
      }
    }

    // Crossings along the way.
    for (const segment of this.segments.values()) {
      for (const hit of path.intersections(this.path(segment))) {
        if (distance(hit.point, curve.a) < 1 || distance(hit.point, curve.b) < 1) continue;
        const angle = (Math.acos(Math.min(1, Math.abs(hit.tangentA.x * hit.tangentB.x + hit.tangentA.y * hit.tangentB.y))) * 180) / Math.PI;
        // Crossing right next to one of the segment's ends: use that junction instead of splitting.
        const end = [this.node(segment.a), this.node(segment.b)].find((n) => distance(n, hit.point) <= NODE_SNAP_RADIUS);
        add(end ? { point: { x: end.x, y: end.y }, t: hit.tA, node: end, angle } : { point: hit.point, t: hit.tA, segment, angle });
      }
    }
    crossings.sort((p, q) => p.t - q.t);

    let valid = true;
    // Pieces of the new road between consecutive junctions.
    const stations = [0, ...crossings.map((c) => path.nearest(c.point).s), path.length];
    for (let i = 1; i < stations.length; i++) {
      const piece = stations[i] - stations[i - 1];
      if (piece < MIN_ROAD_LENGTH && !(piece < 1e-6 && (i === 1 || i === stations.length - 1))) valid = false;
    }
    for (const c of crossings) {
      // Shallow crossings are refused through existing junctions too.
      if (c.angle < MIN_CROSSING_ANGLE) valid = false;
      if (c.node) continue;
      // Pieces of the existing road either side of the split.
      const segmentPath = this.path(c.segment!);
      const s = segmentPath.nearest(c.point).s;
      if (s < MIN_ROAD_LENGTH || segmentPath.length - s < MIN_ROAD_LENGTH) valid = false;
    }
    return { crossings, valid };
  }

  /**
   * Builds a road along `curve`, forming junctions wherever it crosses or ends on existing
   * roads: those roads are split there and the new road is added in pieces between junctions.
   * Returns the new segments (empty if the plan isn't valid).
   */
  buildRoad(curve: Curve, spec: RoadSpec): RoadSegment[] {
    const plan = this.planRoad(curve);
    if (!plan.valid) return [];

    const joints = plan.crossings.map((c) => ({ t: c.t, node: c.node ?? this.splitAt(c.point) }));
    const pieces: Curve[] = [];
    let rest = curve;
    let consumed = 0;
    for (const { t, node } of joints) {
      const at = { x: node.x, y: node.y };
      if (t <= 1e-6) rest = { ...rest, a: at };
      else if (t >= 1 - 1e-6) rest = { ...rest, b: at };
      else {
        const [piece, remainder] = splitCurve(rest, (t - consumed) / (1 - consumed));
        pieces.push({ ...piece, b: at });
        rest = { ...remainder, a: at };
        consumed = t;
      }
    }
    pieces.push(rest);
    return pieces.map((piece) => this.addRoad(piece, spec)).filter((s): s is RoadSegment => s !== null);
  }

  /** Splits whichever segment passes through `point` there, returning the new junction node. */
  private splitAt(point: Vec2): RoadNode {
    let best: { segment: RoadSegment; t: number; distance: number } | null = null;
    for (const segment of this.segments.values()) {
      const nearest = this.path(segment).nearest(point);
      if (!best || nearest.distance < best.distance) best = { segment, t: nearest.t, distance: nearest.distance };
    }
    if (!best) throw new Error("No road to split");
    const { segment, t } = best;
    const [first, second] = splitCurve(this.curveOf(segment), t);
    const mid: RoadNode = { id: this.nextId++, x: first.b.x, y: first.b.y };
    this.nodes.set(mid.id, mid);

    // Replace the segment without pruning its end nodes, which the halves keep using.
    this.segments.delete(segment.id);
    this.sampled.delete(segment.id);
    this.emit({ type: "segment-removed", segment });
    this.insertSegment(segment.a, mid.id, first, segment.spec);
    this.insertSegment(mid.id, segment.b, second, segment.spec);
    return mid;
  }

  private insertSegment(a: NodeId, b: NodeId, curve: Curve, spec: RoadSpec): RoadSegment {
    const segment: RoadSegment = { id: this.nextId++, a, b, spec };
    if (!isStraight(curve)) segment.controls = [{ ...curve.c1 }, { ...curve.c2 }];
    this.segments.set(segment.id, segment);
    this.emit({ type: "segment-added", segment });
    return segment;
  }

  /** Removes a segment and any nodes it leaves unconnected. */
  removeSegment(id: SegmentId): void {
    const segment = this.segments.get(id);
    if (!segment) return;
    this.segments.delete(id);
    this.sampled.delete(id);
    for (const nodeId of [segment.a, segment.b]) {
      if (!this.isConnected(nodeId)) {
        this.nodes.delete(nodeId);
        this.junctionSettings.delete(nodeId);
      }
    }
    this.emit({ type: "segment-removed", segment });
  }

  /** The node closest to `p`, if any lies within `radius`. */
  nodeNear(p: Vec2, radius: number): RoadNode | undefined {
    let best: RoadNode | undefined;
    let bestDist = radius;
    for (const node of this.nodes.values()) {
      const d = distance(node, p);
      if (d <= bestDist) {
        best = node;
        bestDist = d;
      }
    }
    return best;
  }

  /** The segment whose surface (its full width plus `margin`) covers `p`, nearest centre line first. */
  segmentAt(p: Vec2, margin = 0): RoadSegment | undefined {
    let best: RoadSegment | undefined;
    let bestDist = Infinity;
    for (const segment of this.segments.values()) {
      const reach = roadWidth(segment.spec) / 2 + margin;
      const path = this.path(segment);
      const { minX, minY, maxX, maxY } = path.bounds;
      if (p.x < minX - reach || p.x > maxX + reach || p.y < minY - reach || p.y > maxY + reach) continue;
      const d = path.distanceTo(p);
      if (d <= reach && d < bestDist) {
        best = segment;
        bestDist = d;
      }
    }
    return best;
  }

  /** Segments whose centre line enters a convex polygon (e.g. an area-bulldoze selection). */
  segmentsInPolygon(polygon: Vec2[]): RoadSegment[] {
    const xs = polygon.map((p) => p.x);
    const ys = polygon.map((p) => p.y);
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    return [...this.segments.values()].filter((segment) => {
      const path = this.path(segment);
      const b = path.bounds;
      if (b.maxX < minX || b.minX > maxX || b.maxY < minY || b.minY > maxY) return false;
      const points = path.samples.map((q) => q.p);
      if (points.some((p) => pointInConvexPolygon(p, polygon))) return true;
      // A road can cross the area without any sample landing inside it.
      for (let i = 1; i < points.length; i++) {
        for (let j = 0; j < polygon.length; j++) {
          if (segmentsIntersect(points[i - 1], points[i], polygon[j], polygon[(j + 1) % polygon.length])) return true;
        }
      }
      return false;
    });
  }

  toJSON(): SavedMap {
    return {
      version: 3,
      drivingSide: this.side,
      junctions: [...this.junctionSettings].map(([node, settings]) => ({ node, ...settings })),
      nodes: [...this.nodes.values()],
      segments: [...this.segments.values()],
    };
  }

  /** Replaces the whole network. Throws if the map is malformed. */
  load(map: SavedMap): void {
    if (![1, 2, 3].includes(map?.version) || !Array.isArray(map.nodes) || !Array.isArray(map.segments)) {
      throw new Error("Not a road map file (unsupported version or shape)");
    }
    if (map.drivingSide !== undefined && map.drivingSide !== "right" && map.drivingSide !== "left") {
      throw new Error("Invalid driving side in map file");
    }
    const nodes = new Map(map.nodes.map((n) => [n.id, { id: n.id, x: n.x, y: n.y }]));
    const segments = map.segments.map((s): RoadSegment => {
      if (!nodes.has(s.a) || !nodes.has(s.b)) {
        throw new Error(`Segment ${s.id} references a missing node`);
      }
      const spec = map.version === 1 ? { ...DEFAULT_ROAD_SPEC } : parseRoadSpec(s.spec);
      const segment: RoadSegment = { id: s.id, a: s.a, b: s.b, spec };
      if (s.controls) segment.controls = parseControls(s.controls, s.id);
      return segment;
    });

    const junctions = new Map<NodeId, JunctionSettings>();
    for (const j of map.junctions ?? []) {
      if (!nodes.has(j.node)) throw new Error(`Junction settings for missing node ${j.node}`);
      junctions.set(j.node, parseJunctionSettings(j));
    }

    this.side = map.drivingSide ?? "right";
    this.junctionSettings = junctions;
    this.nodes.clear();
    this.segments.clear();
    this.sampled.clear();
    for (const n of nodes.values()) this.nodes.set(n.id, n);
    for (const s of segments) this.segments.set(s.id, s);
    const ids = [...map.nodes.map((n) => n.id), ...map.segments.map((s) => s.id)];
    this.nextId = Math.max(0, ...ids) + 1;
    this.emit({ type: "reset" });
  }

  private nodeAt(p: Vec2): RoadNode {
    for (const node of this.nodes.values()) {
      if (distance(node, p) < NODE_MERGE_DIST) return node;
    }
    const node: RoadNode = { id: this.nextId++, x: p.x, y: p.y };
    this.nodes.set(node.id, node);
    return node;
  }

  /**
   * An existing segment between the same two nodes with the same shape. Different shapes between
   * one pair of nodes are fine (e.g. a curve and a straight road both joining two junctions).
   */
  private findDuplicate(a: NodeId, b: NodeId, curve: Curve): RoadSegment | undefined {
    const close = (p: Vec2, q: Vec2) => distance(p, q) < 1;
    for (const s of this.segments.values()) {
      if (!((s.a === a && s.b === b) || (s.a === b && s.b === a))) continue;
      const other = this.curveOf(s);
      const forward = close(other.c1, curve.c1) && close(other.c2, curve.c2);
      const backward = close(other.c1, curve.c2) && close(other.c2, curve.c1);
      if ((s.a === a && forward) || (s.a === b && backward)) return s;
    }
    return undefined;
  }

  /** Unit direction `segment` leaves node `nodeId` in. */
  directionAway(segment: RoadSegment, nodeId: NodeId): Vec2 {
    const path = this.path(segment);
    if (segment.a === nodeId) return path.at(0).tangent;
    const t = path.at(path.length).tangent;
    return { x: -t.x, y: -t.y };
  }

  /** Segments that start or end at a node. */
  segmentsAt(nodeId: NodeId): RoadSegment[] {
    return [...this.segments.values()].filter((s) => s.a === nodeId || s.b === nodeId);
  }

  private isConnected(nodeId: NodeId): boolean {
    for (const s of this.segments.values()) {
      if (s.a === nodeId || s.b === nodeId) return true;
    }
    return false;
  }

  private emit(e: GraphEvent): void {
    for (const listener of this.listeners) listener(e);
  }
}

function parseControls(raw: unknown, segmentId: number): [Vec2, Vec2] {
  const ok = (p: unknown): p is Vec2 =>
    !!p && Number.isFinite((p as Vec2).x) && Number.isFinite((p as Vec2).y);
  if (!Array.isArray(raw) || raw.length !== 2 || !ok(raw[0]) || !ok(raw[1])) {
    throw new Error(`Segment ${segmentId} has invalid curve controls`);
  }
  return [{ x: raw[0].x, y: raw[0].y }, { x: raw[1].x, y: raw[1].y }];
}
