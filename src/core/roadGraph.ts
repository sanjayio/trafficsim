import { MIN_CROSSING_ANGLE, MIN_ROAD_LENGTH, NODE_MERGE_DIST, NODE_SNAP_RADIUS } from "./constants";
import { isStraight, rightNormal, SampledCurve, splitCurve, straightCurve, type Curve } from "./curve";
import { distance, pointInConvexPolygon, segmentsIntersect, type Vec2 } from "./geometry";
import {
  DEFAULT_JUNCTION,
  isDefaultJunction,
  parseJunctionSettings,
  roundaboutShape,
  type JunctionSettings,
} from "./junction";
import type { LaneRef } from "./lanes";
import { BUILDING_SIZE, LOT_SETBACK, parseTerminal, type Lot, type Terminal } from "./terminal";
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
  /** The map's name (absent in older maps). */
  name?: string;
  /** Junctions with non-default settings (absent in older maps). */
  junctions?: ({ node: NodeId } & JunctionSettings)[];
  /** Traffic sources and sinks (absent in older maps). */
  terminals?: ({ node: NodeId } & Terminal)[];
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

/** What a map is called if it wasn't given a name, and the longest name it can have. */
export const DEFAULT_MAP_NAME = "Untitled map";
export const MAX_MAP_NAME = 60;

/** A road endpoint this close to another road's centre line joins it (the tool snaps onto it exactly). */
const ON_ROAD_TOLERANCE = 0.5;

export type GraphEvent =
  | { type: "segment-added"; segment: RoadSegment }
  | { type: "segment-removed"; segment: RoadSegment }
  | { type: "reset" }
  /** A network-wide setting changed (e.g. driving side); everything may need redrawing. */
  | { type: "settings" }
  | { type: "junction-changed"; nodeId: NodeId }
  | { type: "terminal-changed"; nodeId: NodeId };

/**
 * The road network: intersections/endpoints (nodes) joined by segments, each a straight or
 * curved (cubic Bézier) road. Pure data — renderers and the simulation subscribe to changes.
 */
export class RoadGraph {
  readonly nodes = new Map<NodeId, RoadNode>();
  readonly segments = new Map<SegmentId, RoadSegment>();
  private side: DrivingSide = "right";
  private title = DEFAULT_MAP_NAME;
  /** Settings of junctions that differ from `DEFAULT_JUNCTION`. */
  private junctionSettings = new Map<NodeId, JunctionSettings>();
  /** Sources and sinks, each on a dead-end node (exactly one road). */
  private terminals = new Map<NodeId, Terminal>();
  private nextId = 1;
  /** Sampled centre line per segment, built when the segment is added. */
  private sampled = new Map<SegmentId, SampledCurve>();
  /** Segments meeting at each node, so finding a junction's roads doesn't scan the whole map. */
  private adjacent = new Map<NodeId, Set<SegmentId>>();
  private listeners = new Set<(e: GraphEvent) => void>();

  subscribe(listener: (e: GraphEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The map's name, given when it's made. */
  get name(): string {
    return this.title;
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

  terminal(nodeId: NodeId): Terminal | undefined {
    return this.terminals.get(nodeId);
  }

  /** Every source or sink, by node. */
  allTerminals(): ReadonlyMap<NodeId, Terminal> {
    return this.terminals;
  }

  /** Makes a dead end, or a node along a road (two roads joining), a source or sink (null removes it). Ignored at junctions. */
  setTerminal(nodeId: NodeId, terminal: Terminal | null): void {
    if (!terminal) return this.dropTerminal(nodeId);
    const roads = this.segmentsAt(nodeId).length;
    if (roads < 1 || roads > 2) return;
    if (this.terminals.get(nodeId)?.kind === "sink" && terminal.kind !== "sink") this.dropTerminal(nodeId);
    this.terminals.set(nodeId, terminal);
    this.emit({ type: "terminal-changed", nodeId });
  }

  /** Road `from` at junction `nodeId` was replaced by `to` (the same lanes, the same way): its lane connections follow. */
  private renameInConnections(nodeId: NodeId, from: SegmentId, to: SegmentId): void {
    const connections = this.junctionSettings.get(nodeId)?.connections;
    if (!connections) return;
    const rename = (ref: LaneRef) => (ref.segment === from ? { ...ref, segment: to } : ref);
    this.setJunction(nodeId, { connections: connections.map((c) => ({ from: rename(c.from), to: rename(c.to) })) });
  }

  /** A junction's roads changed: lane connections set for the old roads no longer apply. */
  private forgetConnections(nodeIds: NodeId[]): void {
    for (const nodeId of nodeIds) {
      if (this.junctionSettings.get(nodeId)?.connections) this.setJunction(nodeId, { connections: undefined });
    }
  }

  private dropTerminal(nodeId: NodeId): void {
    const old = this.terminals.get(nodeId);
    if (!old) return;
    this.terminals.delete(nodeId);
    this.emit({ type: "terminal-changed", nodeId });
    if (old.kind !== "sink") return;
    // Sources that listed this sink stop sending cars to it.
    for (const [id, t] of this.terminals) {
      if (t.kind === "source" && t.sinks.includes(nodeId)) {
        this.terminals.set(id, { ...t, sinks: t.sinks.filter((s) => s !== nodeId) });
        this.emit({ type: "terminal-changed", nodeId: id });
      }
    }
  }

  /**
   * Where a source's or sink's building stands: beside its road end, on the side traffic leaving
   * (source) or arriving (sink) drives on, so cars turn straight in or out of it.
   */
  terminalLot(nodeId: NodeId): Lot | null {
    const terminal = this.terminals.get(nodeId);
    const roads = this.segmentsAt(nodeId);
    if (!terminal || !roads.length) return null;
    const node = this.node(nodeId);
    const along = this.terminalDirection(nodeId);
    // On a dead end: beside the road end, where leaving (source) or arriving (sink) traffic keeps
    // (to the right of `along` for a source under right-hand traffic). Along a road: the chosen side.
    const dead = roads.length === 1;
    const keep = dead ? (this.side === "right" ? 1 : -1) * (terminal.kind === "source" ? 1 : -1) : (terminal.side ?? 1);
    const right = rightNormal(along);
    const out = { x: right.x * keep, y: right.y * keep };
    const { length, depth } = BUILDING_SIZE[terminal.building];
    const front = Math.max(...roads.map((s) => roadWidth(s.spec))) / 2 + LOT_SETBACK;
    const back = front + depth / 2;
    // On a dead end the building stands beside the road end, its driveway in the middle; along a
    // road, the driveway is at the node and the building `offset` along from it.
    const at = dead ? length / 2 : 0;
    const centreAt = dead ? at : (terminal.offset ?? 0);
    return {
      building: terminal.building,
      centre: { x: node.x + along.x * centreAt + out.x * back, y: node.y + along.y * centreAt + out.y * back },
      door: { x: node.x + along.x * at + out.x * front, y: node.y + along.y * at + out.y * front },
      along,
      at,
      out,
      front,
      length,
      depth,
    };
  }

  /**
   * The direction a source's or sink's side is measured from: away from the node along its road
   * on a dead end; along a road, the way the road leaving the node (as its `a` end) runs.
   */
  terminalDirection(nodeId: NodeId): Vec2 {
    const roads = this.segmentsAt(nodeId);
    const leaving = roads.find((s) => s.a === nodeId) ?? roads[0];
    return this.directionAway(leaving, nodeId);
  }

  /**
   * A node on a road at `p` for a source or sink: the road is split there (unless a node is
   * already close by). Null where a road can't be split (the pieces would be too short).
   */
  nodeOnRoad(p: Vec2): RoadNode | null {
    const segment = this.segmentAt(p);
    if (!segment) return null;
    const path = this.path(segment);
    const { point, s } = path.nearest(p);
    for (const end of [segment.a, segment.b]) {
      const node = this.node(end);
      if (distance(node, point) < MIN_ROAD_LENGTH) return node;
    }
    if (s < MIN_ROAD_LENGTH || path.length - s < MIN_ROAD_LENGTH) return null;
    return this.splitAt(point);
  }



  /** The corners of a source's or sink's building. */
  lotCorners(nodeId: NodeId): Vec2[] {
    const lot = this.terminalLot(nodeId);
    if (!lot) return [];
    const { centre, along, out } = lot;
    const corner = (a: number, o: number) => ({
      x: centre.x + along.x * a * (lot.length / 2) + out.x * o * (lot.depth / 2),
      y: centre.y + along.y * a * (lot.length / 2) + out.y * o * (lot.depth / 2),
    });
    return [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
  }

  /** The source or sink whose building covers `p`, if any. */
  terminalAt(p: Vec2): NodeId | undefined {
    for (const id of this.terminals.keys()) if (pointInConvexPolygon(p, this.lotCorners(id))) return id;
    return undefined;
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
    const segment = this.insertSegment(a.id, b.id, curve, normalizeRoadSpec(spec));
    this.forgetConnections([a.id, b.id]);
    return segment;
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
    this.unlink(segment);
    this.emit({ type: "segment-removed", segment });
    const firstHalf = this.insertSegment(segment.a, mid.id, first, segment.spec);
    const secondHalf = this.insertSegment(mid.id, segment.b, second, segment.spec);
    // The junctions at either end keep their lane connections: the half meeting each takes the road's place.
    this.renameInConnections(segment.a, segment.id, firstHalf.id);
    this.renameInConnections(segment.b, segment.id, secondHalf.id);
    return mid;
  }

  private insertSegment(a: NodeId, b: NodeId, curve: Curve, spec: RoadSpec): RoadSegment {
    const segment: RoadSegment = { id: this.nextId++, a, b, spec };
    if (!isStraight(curve)) segment.controls = [{ ...curve.c1 }, { ...curve.c2 }];
    this.segments.set(segment.id, segment);
    this.link(segment);
    // A third road joining a source or sink makes it a junction, where they don't go.
    for (const nodeId of [a, b]) if (this.segmentsAt(nodeId).length > 2) this.dropTerminal(nodeId);
    this.emit({ type: "segment-added", segment });
    return segment;
  }

  private link(segment: RoadSegment): void {
    for (const nodeId of [segment.a, segment.b]) {
      let ids = this.adjacent.get(nodeId);
      if (!ids) this.adjacent.set(nodeId, (ids = new Set()));
      ids.add(segment.id);
    }
  }

  private unlink(segment: RoadSegment): void {
    for (const nodeId of [segment.a, segment.b]) {
      const ids = this.adjacent.get(nodeId);
      ids?.delete(segment.id);
      if (ids?.size === 0) this.adjacent.delete(nodeId);
    }
  }

  /** Removes a segment and any nodes it leaves unconnected. */
  removeSegment(id: SegmentId): void {
    const segment = this.segments.get(id);
    if (!segment) return;
    this.segments.delete(id);
    this.sampled.delete(id);
    this.unlink(segment);
    for (const nodeId of [segment.a, segment.b]) {
      const left = this.segmentsAt(nodeId).length;
      // Below three roads it's no junction: its settings would linger, unreachable from the panel.
      if (left < 3) this.junctionSettings.delete(nodeId);
      else this.forgetConnections([nodeId]);
      if (left === 0) this.dropTerminal(nodeId);
      if (left === 0) this.nodes.delete(nodeId);
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
      name: this.title,
      drivingSide: this.side,
      junctions: [...this.junctionSettings].map(([node, settings]) => ({ node, ...settings })),
      terminals: [...this.terminals].map(([node, terminal]) => ({ node, ...terminal })),
      nodes: [...this.nodes.values()],
      segments: [...this.segments.values()],
    };
  }

  /** Replaces the whole network. Throws if the map is malformed. */
  load(map: SavedMap): void {
    if (![1, 2, 3].includes(map?.version) || !Array.isArray(map.nodes) || !Array.isArray(map.segments)) {
      throw new Error("Not a road map file (unsupported version or shape)");
    }
    if (map.name !== undefined && (typeof map.name !== "string" || map.name.length > MAX_MAP_NAME)) {
      throw new Error("Invalid map name in map file");
    }
    if (map.drivingSide !== undefined && map.drivingSide !== "right" && map.drivingSide !== "left") {
      throw new Error("Invalid driving side in map file");
    }
    const nodes = new Map<NodeId, RoadNode>();
    for (const n of map.nodes) {
      if (!Number.isSafeInteger(n?.id) || nodes.has(n.id) || !Number.isFinite(n.x) || !Number.isFinite(n.y)) {
        throw new Error(`Invalid or duplicate node ${n?.id} in map file`);
      }
      nodes.set(n.id, { id: n.id, x: n.x, y: n.y });
    }
    const segmentIds = new Set<SegmentId>();
    const segments = map.segments.map((s): RoadSegment => {
      if (!Number.isSafeInteger(s?.id) || segmentIds.has(s.id)) throw new Error(`Invalid or duplicate road ${s?.id} in map file`);
      segmentIds.add(s.id);
      if (!nodes.has(s.a) || !nodes.has(s.b) || s.a === s.b) {
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
      const settings = parseJunctionSettings(j);
      // Lane connections join real lanes of roads meeting at this junction, the right way.
      const at = (ref: LaneRef, entering: boolean) => {
        const s = segments.find((seg) => seg.id === ref.segment);
        if (!s || (s.a !== j.node && s.b !== j.node) || ref.lane < 0 || ref.lane >= s.spec.lanes) return false;
        return !s.spec.oneWay || (entering ? s.b === j.node : s.a === j.node);
      };
      if (settings.connections?.some((c) => !at(c.from, true) || !at(c.to, false))) {
        throw new Error(`Invalid lane connections at junction ${j.node}`);
      }
      junctions.set(j.node, settings);
    }

    this.side = map.drivingSide ?? "right";
    this.title = map.name?.trim() || DEFAULT_MAP_NAME;
    // Sources and sinks sit on dead ends; sources only list real sinks.
    const ends = new Map<NodeId, number>();
    for (const s of segments) for (const n of [s.a, s.b]) ends.set(n, (ends.get(n) ?? 0) + 1);
    const terminals = new Map<NodeId, Terminal>();
    for (const t of map.terminals ?? []) {
      const roads = ends.get(t.node) ?? 0;
      if (roads < 1 || roads > 2 || terminals.has(t.node)) throw new Error(`Invalid source or sink at node ${t.node}`);
      terminals.set(t.node, parseTerminal(t));
    }
    for (const t of terminals.values()) {
      if (t.kind === "source" && t.sinks.some((id) => terminals.get(id)?.kind !== "sink")) {
        throw new Error("A source lists a missing sink");
      }
    }

    this.junctionSettings = junctions;
    this.terminals = terminals;
    this.nodes.clear();
    this.segments.clear();
    this.sampled.clear();
    this.adjacent.clear();
    for (const n of nodes.values()) this.nodes.set(n.id, n);
    for (const s of segments) {
      this.segments.set(s.id, s);
      this.link(s);
    }
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
    return [...(this.adjacent.get(nodeId) ?? [])].map((id) => this.segments.get(id)!);
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
