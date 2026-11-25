import { Group, Mesh, type MeshBasicMaterial } from "three";
import { effectiveControl, kerbRadius, MAX_CORNER_RADIUS, roundaboutShape, signalLights } from "../core/junction";
import type { GraphEvent, NodeId, RoadGraph, RoadSegment, SegmentId } from "../core/roadGraph";
import { carriagewayWidth, FOOTPATH_WIDTH, roadWidth } from "../core/roadSpec";
import { flatMaterial } from "./flat";
import { FurnitureKit, type FurnitureSpot } from "./furniture";
import { buildJunctionParts, type JunctionArm } from "./junctionParts";
import { buildRoundaboutParts } from "./roundaboutParts";
import { buildRoadParts, ROAD_PART_STYLE, type RoadEnd, type RoadPart } from "./roadParts";

/** Clearance between a junction's crossing road and where markings stop. */
const JUNCTION_MARGIN = 2;
/** Roads meeting at less than ~20° to each other (sin < this) carry on rather than cross. */
const MIN_CLEARANCE_SINE = 0.35;
/** Signs stand this far outside a road without a footpath (on a footpath, they stand mid-path). */
const SIGN_SETBACK = 3;


/**
 * Renders the road graph. Each segment's meshes are built when it's added, and rebuilt only when
 * a road joins or leaves one of its ends (which decides whether markings stop short there).
 * All footpaths draw before all asphalt, which draws before all markings, so junctions stay clean.
 * Junction settings decide entry markings, corner radius, roundabouts and the signs or signals
 * standing at each approach; signals are switched every frame by `updateSignals`.
 */
export class RoadLayer extends Group {
  private materials = Object.fromEntries(
    Object.entries(ROAD_PART_STYLE).map(([part, style]) => [part, flatMaterial(style.color)]),
  ) as Record<RoadPart, MeshBasicMaterial>;
  private views = new Map<SegmentId, Mesh[]>();
  /** Rounded corners at each node where roads meet. */
  private junctions = new Map<NodeId, Mesh[]>();
  /** Per node, how far its paved corners reach along each road meeting there. */
  private cornerReach = new Map<NodeId, Map<SegmentId, number>>();
  private kit = new FurnitureKit();
  /** Signs and signals at each junction. */
  private furniture = new Map<NodeId, Group>();
  /** Signal lamps per junction, one set per approach in order around the junction. */
  private signals = new Map<NodeId, Mesh[][]>();
  /** Where each approach's yield sign stands at a roundabout (on its splitter island, or at the kerb). */
  private roundaboutSigns = new Map<NodeId, Map<SegmentId, FurnitureSpot>>();
  /** Per roundabout approach: where the road's own markings start, and whether it draws the give-way. */
  private roundaboutApproaches = new Map<NodeId, Map<SegmentId, { inset: number; giveWay: boolean }>>();
  private unsubscribe: () => void;

  constructor(private graph: RoadGraph) {
    super();
    this.unsubscribe = graph.subscribe(this.onGraphEvent);
    this.rebuild();
  }

  private onGraphEvent = (e: GraphEvent) => {
    switch (e.type) {
      case "segment-added":
        this.refreshNodes([e.segment.a, e.segment.b]);
        break;
      case "segment-removed":
        this.removeSegment(e.segment.id);
        this.refreshNodes([e.segment.a, e.segment.b]);
        break;
      case "junction-changed":
        this.refreshNodes([e.nodeId]);
        break;
      case "reset":
      case "settings":
        this.rebuild();
        break;
    }
  };

  private rebuild(): void {
    for (const id of [...this.views.keys()]) this.removeSegment(id);
    for (const id of [...this.junctions.keys()]) this.rebuildJunction(id);
    // Junctions first: roads read how far each junction's corners reach to place their markings.
    for (const id of this.graph.nodes.keys()) this.rebuildJunction(id);
    for (const segment of this.graph.segments.values()) this.addSegment(segment);
    for (const id of [...this.furniture.keys()]) this.rebuildFurniture(id);
    for (const id of this.graph.nodes.keys()) this.rebuildFurniture(id);
  }

  /** Switches every junction's signals to the lights for simulation time `time`. */
  updateSignals(time: number): void {
    for (const approaches of this.signals.values()) {
      const lights = signalLights(approaches.length, time);
      approaches.forEach((lamps, i) => this.kit.setLight(lamps, lights[i]));
    }
  }

  /**
   * A road joined or left these nodes: rebuild their junctions, then every road meeting there
   * (its markings depend on how many roads meet, at what angles, and how far the corners reach).
   */
  private refreshNodes(nodeIds: NodeId[]): void {
    for (const id of nodeIds) this.rebuildJunction(id);
    const affected = new Map<SegmentId, RoadSegment>();
    for (const id of nodeIds) {
      if (!this.graph.nodes.has(id)) continue;
      for (const segment of this.graph.segmentsAt(id)) affected.set(segment.id, segment);
    }
    for (const segment of affected.values()) {
      this.removeSegment(segment.id);
      this.addSegment(segment);
    }
    // Signs stand at where markings start, so they come last.
    for (const id of nodeIds) this.rebuildFurniture(id);
  }

  /** The road `segment` as seen leaving node `nodeId`. */
  private armOf(segment: RoadSegment, nodeId: NodeId): JunctionArm {
    const path = this.graph.path(segment);
    const leavesFromStart = segment.a === nodeId;
    return {
      dir: this.graph.directionAway(segment, nodeId),
      halfWidth: carriagewayWidth(segment.spec) / 2,
      footpath: segment.spec.footpath ? FOOTPATH_WIDTH : 0,
      length: path.length,
      // Walking away from the junction; "right" flips when the road runs towards it.
      edge: (offset: number, along: number) => {
        const f = path.at(leavesFromStart ? along : path.length - along);
        const side = leavesFromStart ? offset : -offset;
        return { x: f.p.x + f.normal.x * side, y: f.p.y + f.normal.y * side };
      },
    };
  }

  /** Rebuilds the signs or signals standing at each approach to a junction. */
  private rebuildFurniture(nodeId: NodeId): void {
    const old = this.furniture.get(nodeId);
    if (old) this.remove(old);
    this.furniture.delete(nodeId);
    this.signals.delete(nodeId);
    if (!this.graph.nodes.has(nodeId)) return;
    const meeting = this.graph.segmentsAt(nodeId);
    if (meeting.length < 3) return;

    const control = effectiveControl(this.graph.junction(nodeId));
    if (control === "none") return;

    const group = new Group();
    const lamps: { angle: number; lamps: Mesh[] }[] = [];
    // Approaching traffic drives on its own right (right-hand traffic), which is to the left of
    // the direction leaving the junction.
    const keep = this.graph.drivingSide === "right" ? -1 : 1;
    for (const segment of meeting) {
      // One-way roads leading away from the junction have no traffic entering here.
      if (segment.spec.oneWay && segment.b !== nodeId) continue;
      const arm = this.armOf(segment, nodeId);
      const setback = arm.footpath > 0 ? arm.footpath / 2 : SIGN_SETBACK;
      const along = this.endAt(segment, nodeId).inset + 1;
      const spot = this.roundaboutSigns.get(nodeId)?.get(segment.id) ?? {
        position: arm.edge(keep * (arm.halfWidth + setback), along),
        facing: arm.dir,
      };
      if (control === "stop") group.add(this.kit.stopSign(spot));
      else if (control === "yield") group.add(this.kit.yieldSign(spot));
      else {
        const signal = this.kit.signal(spot);
        group.add(signal.group);
        lamps.push({ angle: Math.atan2(arm.dir.y, arm.dir.x), lamps: signal.lamps });
      }
    }
    this.add(group);
    this.furniture.set(nodeId, group);
    if (lamps.length) this.signals.set(nodeId, lamps.sort((a, b) => a.angle - b.angle).map((l) => l.lamps));
  }

  /** Rebuilds the rounded corners at a node (removing them if the node is gone). */
  private rebuildJunction(nodeId: NodeId): void {
    for (const mesh of this.junctions.get(nodeId) ?? []) {
      this.remove(mesh);
      mesh.geometry.dispose();
    }
    this.junctions.delete(nodeId);
    this.cornerReach.delete(nodeId);
    this.roundaboutSigns.delete(nodeId);
    this.roundaboutApproaches.delete(nodeId);
    if (!this.graph.nodes.has(nodeId)) return;

    const meeting = this.graph.segmentsAt(nodeId);
    const settings = this.graph.junction(nodeId);
    let meshes: Mesh[];
    if (settings.roundabout && meeting.length >= 3) {
      const shape = roundaboutShape(meeting.map((s) => s.spec));
      // Markings on the approaches start clear of the ring.
      this.cornerReach.set(nodeId, new Map(meeting.map((segment) => [segment.id, shape.outer])));
      const keep = this.graph.drivingSide === "right" ? -1 : 1;
      const layout = buildRoundaboutParts(
        this.graph.node(nodeId),
        shape,
        meeting.map((segment) => ({
          ...this.armOf(segment, nodeId),
          twoWay: !segment.spec.oneWay,
          lanes: segment.spec.lanes,
          median: segment.spec.median,
          keep,
        })),
        // At a roundabout the corner smoothness setting shapes the entry flares and splitter islands.
        settings.cornerRadius / MAX_CORNER_RADIUS,
      );
      this.roundaboutSigns.set(nodeId, new Map(meeting.map((segment, i) => [segment.id, layout.signs[i]])));
      this.roundaboutApproaches.set(nodeId, new Map(meeting.map((segment, i) => [segment.id, layout.approaches[i]])));
      meshes = layout.parts.map(({ part, order, geometry }) => {
        const mesh = new Mesh(geometry, this.materials[part]);
        mesh.renderOrder = order;
        return mesh;
      });
    } else {
      const { parts, reach } = buildJunctionParts(
        meeting.map((segment) => this.armOf(segment, nodeId)),
        kerbRadius(settings.cornerRadius),
      );
      this.cornerReach.set(nodeId, new Map(meeting.map((segment, i) => [segment.id, reach[i]])));
      meshes = parts.map(({ part, geometry }) => {
        const mesh = new Mesh(geometry, this.materials[part]);
        mesh.renderOrder = ROAD_PART_STYLE[part].layer;
        return mesh;
      });
    }
    if (meshes.length) {
      this.add(...meshes);
      this.junctions.set(nodeId, meshes);
    }
  }

  /**
   * How markings finish where `segment` meets node `nodeId`: straight through where exactly two
   * roads meet, at the road's own edge at a dead end, and at a junction behind its entry marking
   * (per the junction's control; give way at roundabouts) clear of every crossing road (further
   * back for oblique crossings) and of the junction's paved corners or ring.
   */
  private endAt(segment: RoadSegment, nodeId: NodeId): RoadEnd {
    const meeting = this.graph.segmentsAt(nodeId);
    if (meeting.length === 2) return { inset: 0, entry: "none" };
    if (meeting.length === 1) return { inset: carriagewayWidth(segment.spec) / 2, entry: "none", turnaround: true };

    // At a roundabout the ring (and any splitter island) decides where this road's markings start.
    const approach = this.roundaboutApproaches.get(nodeId)?.get(segment.id);
    if (approach) return { inset: approach.inset + JUNCTION_MARGIN, entry: approach.giveWay ? "yield" : "none" };

    const away = this.graph.directionAway(segment, nodeId);
    let inset = 0;
    for (const other of meeting) {
      if (other.id === segment.id) continue;
      const otherAway = this.graph.directionAway(other, nodeId);
      const sine = Math.abs(away.x * otherAway.y - away.y * otherAway.x);
      // A road carrying straight on (or merging at a shallow angle) doesn't cross these lanes.
      if (sine < MIN_CLEARANCE_SINE) continue;
      inset = Math.max(inset, roadWidth(other.spec) / 2 / sine + JUNCTION_MARGIN);
    }
    // Only roads carrying straight on: nothing crosses here, so markings run up to the road's own edge.
    if (inset === 0) inset = carriagewayWidth(segment.spec) / 2;
    const corners = this.cornerReach.get(nodeId)?.get(segment.id) ?? 0;
    if (corners > 0) inset = Math.max(inset, corners + JUNCTION_MARGIN);

    const control = effectiveControl(this.graph.junction(nodeId));
    const entry = control === "none" ? "none" : control === "yield" ? "yield" : "stop";
    return { inset, entry };
  }

  private addSegment(segment: RoadSegment): void {
    const ends = { start: this.endAt(segment, segment.a), end: this.endAt(segment, segment.b) };
    const meshes = buildRoadParts(this.graph.path(segment), segment.spec, ends, this.graph.drivingSide).map(
      ({ part, geometry }) => {
        const mesh = new Mesh(geometry, this.materials[part]);
        mesh.renderOrder = ROAD_PART_STYLE[part].layer;
        return mesh;
      },
    );
    this.add(...meshes);
    this.views.set(segment.id, meshes);
  }

  private removeSegment(id: SegmentId): void {
    for (const mesh of this.views.get(id) ?? []) {
      this.remove(mesh);
      mesh.geometry.dispose();
    }
    this.views.delete(id);
  }

  dispose(): void {
    this.unsubscribe();
    for (const id of [...this.views.keys()]) this.removeSegment(id);
    for (const meshes of this.junctions.values()) for (const mesh of meshes) mesh.geometry.dispose();
    this.junctions.clear();
    this.furniture.clear();
    this.signals.clear();
    this.kit.dispose();
    for (const material of Object.values(this.materials)) material.dispose();
  }
}
