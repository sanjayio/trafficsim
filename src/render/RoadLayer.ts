import { Group, Mesh, type BufferGeometry, type InstancedMesh, type MeshBasicMaterial, type Object3D } from "three";
import { effectiveControl, kerbRadius, minorRoads, slipControlAt, slipRoad, signalApproaches, MAX_CORNER_RADIUS, roundaboutShape, signalLights } from "../core/junction";
import type { GraphEvent, NodeId, RoadGraph, RoadSegment, SegmentId } from "../core/roadGraph";
import { connectionsAt, hasLaneConnector, turnAt, type Turn } from "../core/lanes";
import { carriagewayWidth, FOOTPATH_WIDTH, hasMedian, LANE_WIDTH, MEDIAN_WIDTH, roadWidth, type RoadSpec } from "../core/roadSpec";
import { carPark, defaultName, DRIVEWAY_WIDTH, isSourceBuilding, SIDE_PATH } from "../core/terminal";
import { bridge } from "../core/track";
import { BuildingKit } from "./buildings";
import { concreteMaterial, gradeStructure, liftGeometry, trenchMask } from "./grade";
import { FlatLayer, flatMaterial, KERB_HEIGHT, kerbColouring, pavedGeometry } from "./flat";
import { FurnitureKit, type FurnitureSpot } from "./furniture";
import { buildJunctionParts, type JunctionArm } from "./junctionParts";
import { buildRoundaboutParts } from "./roundaboutParts";
import { buildBendMarkings, buildBendSurface, buildRoadParts, CROSSING_ROOM, ROAD_PART_STYLE, type BendLine, type RoadEnd, type RoadPart } from "./roadParts";
import type { Curve, SampledCurve } from "../core/curve";

/** Roads meeting this close to straight on (radians short of 180°) just carry their markings through. */
const STRAIGHT_ENOUGH = (10 * Math.PI) / 180;
/** Clearance between a junction's crossing road and where markings stop. */
const JUNCTION_MARGIN = 2;
/** How far a driveway ramps down from the footpath to the road, across the footpath's edge. */
const DRIVEWAY_RAMP = 3.5;
/** A junction's arm follows its road this far at most (through splits, see `armOf`): further than any corner reaches. */
const ARM_REACH = 320;
/** Two road pieces meeting at less than this angle (cos of about 10°) carry on as one road. */
const SMOOTH_JOIN = Math.cos((10 * Math.PI) / 180);
/** Two pieces this close to straight on (cos of about 2°): a road split in two, its ends left square. */
const STRAIGHT_ON = Math.cos((2 * Math.PI) / 180);
/** Roads meeting at less than ~20° to each other (sin < this) carry on rather than cross. */
const MIN_CLEARANCE_SINE = 0.35;
/** Width of a source's or sink's driveway. */
/** Signs stand this far outside a road without a footpath (on a footpath, they stand mid-path). */
/** How far from a slip road's node its markings start (clear of the main road it overlaps there). */
const SLIP_CLEAR = 30;
/** Bridges and tunnels draw after the ground's road layers (and before cars and buildings). */
const GRADED_ORDER = 12;
/** A give way or stop line at a slip road's end stands this far back from where it meets the main road's kerb. */
const SLIP_LINE_GAP = 2;
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
    Object.entries(ROAD_PART_STYLE).map(([part, style]) => [part, textured(part as RoadPart, flatMaterial(style.color))]),
  ) as Record<RoadPart, MeshBasicMaterial>;
  private views = new Map<SegmentId, Mesh[]>();
  private graded = new Map<RoadPart, MeshBasicMaterial>();
  private over = new Map<RoadPart, MeshBasicMaterial>();
  private concrete = concreteMaterial();
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
  /** Source and sink buildings beside their roads, with their driveways. */
  private markers = new Map<NodeId, { driveway: Mesh; building: Group }>();
  private buildings = new BuildingKit();
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
      case "terminal-changed":
        this.rebuildMarker(e.nodeId);
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
    for (const id of [...this.markers.keys()]) this.rebuildMarker(id);
    for (const id of this.graph.allTerminals().keys()) this.rebuildMarker(id);
  }

  /**
   * Where cars stop before node `nodeId` on `segment`, as a distance from the node: the painted
   * stop or give-way line (at a roundabout, the give-way line just outside the ring).
   */
  stopLineAt(segment: RoadSegment, nodeId: NodeId): number {
    const meeting = this.graph.segmentsAt(nodeId);
    if (this.graph.junction(nodeId).roundabout && meeting.length >= 3) {
      return roundaboutShape(meeting.map((s) => s.spec)).outer + JUNCTION_MARGIN;
    }
    return this.endAt(segment, nodeId).inset;
  }

  /**
   * A source's or sink's building beside its road end (green roof for a source, red for a sink)
   * with a driveway to the road and a roof arrow showing whether cars come out or go in.
   */
  private rebuildMarker(nodeId: NodeId): void {
    const old = this.markers.get(nodeId);
    if (old) {
      this.remove(old.driveway, old.building);
      old.driveway.geometry.dispose();
      // Geometry and materials are the kit's, shared; instanced parts own their per-instance buffers.
      old.building.traverse((o) => {
        if ((o as InstancedMesh).isInstancedMesh) (o as InstancedMesh).dispose();
        // Name signs: their own texture and material.
        if (o.userData.own) {
          const material = (o as Mesh).material as MeshBasicMaterial;
          material.map?.dispose();
          material.dispose();
        }
      });
    }
    this.markers.delete(nodeId);
    const lot = this.graph.terminalLot(nodeId);
    const [segment] = this.graph.segmentsAt(nodeId);
    if (!lot || !segment) return;
    const { door, along, out, front } = lot;
    // At the door (where cars drive in and out, not always level with the building's middle),
    // from the building's front to the carriageway's edge, across any footpath.
    const at = (a: number, o: number) => ({ x: door.x + along.x * a - out.x * o, y: door.y + along.y * a - out.y * o });
    const toFront = front - carriagewayWidth(segment.spec) / 2;
    // Level with the footpath from the building to just short of the kerb, then a ramp down to the
    // road (a dropped kerb), as two pieces.
    const ramp = Math.min(DRIVEWAY_RAMP, toFront);
    const strip = (middle: number, width: number) => [
      [at(middle - width / 2, 0), at(middle + width / 2, 0), at(middle + width / 2, toFront - ramp), at(middle - width / 2, toFront - ramp)],
      [at(middle - width / 2, toFront - ramp), at(middle + width / 2, toFront - ramp), at(middle + width / 2, toFront), at(middle - width / 2, toFront)],
    ];
    // With a car park behind the building, the driveway is the side path to it instead.
    const { path } = isSourceBuilding(lot.building) ? { path: null } : carPark(lot);
    const doorAt = (door.x - lot.centre.x) * along.x + (door.y - lot.centre.y) * along.y;
    const drive = path === null ? strip(0, DRIVEWAY_WIDTH) : strip(path - doorAt, SIDE_PATH);
    const geometry = pavedGeometry(drive);
    // Each point's height: the footpath's, falling to the road's over the ramp by the kerb.
    const position = geometry.getAttribute("position");
    for (let i = 0; i < position.count; i++) {
      const o = -((position.getX(i) - door.x) * out.x + (position.getZ(i) - door.y) * out.y);
      position.setY(i, KERB_HEIGHT * Math.min(1, Math.max(0, (toFront - o) / ramp)));
    }
    const driveway = new Mesh(geometry, this.materials.footpath);
    // Paved like the footpath, and over the kerb.
    driveway.renderOrder = ROAD_PART_STYLE.asphalt.layer;
    const terminal = this.graph.terminal(nodeId)!;
    const name = terminal.kind === "sink" ? terminal.name || defaultName(terminal.building, nodeId) : undefined;
    const building = this.buildings.model(lot, { ...terminal, name });
    this.add(driveway, building);
    this.markers.set(nodeId, { driveway, building });
  }


  /** Lights the buildings' windows for the time of day (see BuildingKit.setLights). */
  setLights(exposure: number, night: number): void {
    this.buildings.setLights(exposure, night);
  }

  /** Source and sink buildings with their plots, by node, for picking with the pointer. */
  buildingGroups(): Map<Object3D, NodeId> {
    return new Map([...this.markers].map(([id, m]) => [m.building, id]));
  }

  /** Switches every junction's signals to the lights for simulation time `time`. */
  updateSignals(time: number): void {
    for (const [nodeId, approaches] of this.signals) {
      const lights = signalLights(approaches.length, time, this.graph.rules.signals);
      const freeTurn = !!this.graph.junction(nodeId).turnOnRed;
      approaches.forEach((lamps, i) => this.kit.setLight(lamps, lights[i], freeTurn));
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
    // Signs stand at where markings start, so they come last; source and sink buildings sit by their roads.
    for (const id of nodeIds) {
      this.rebuildFurniture(id);
      this.rebuildMarker(id);
    }
  }

  /** The road `segment` as seen leaving node `nodeId`. */
  private armOf(segment: RoadSegment, nodeId: NodeId): JunctionArm {
    // The road as it leaves, on through where it's only split (as for a building's driveway) and
    // carries on smoothly, the same width: a corner can round as far as the road really runs.
    const pieces: { path: SampledCurve; forward: boolean; start: number }[] = [];
    let length = 0;
    for (let piece: RoadSegment | undefined = segment, from: NodeId = nodeId; piece && length < ARM_REACH; ) {
      // As drawn (a slip road's end runs from the main road's outside lane).
      const path = this.graph.drawnPath(piece);
      const forward: boolean = piece.a === from;
      pieces.push({ path, forward, start: length });
      length += path.length;
      const node: NodeId = forward ? piece.b : piece.a;
      const on = this.graph.segmentsAt(node);
      const next = on.length === 2 ? on.find((s) => s !== piece) : undefined;
      const same = next && roadWidth(next.spec) === roadWidth(piece.spec) && carriagewayWidth(next.spec) === carriagewayWidth(piece.spec);
      const back = this.graph.directionAway(piece, node);
      const on2 = next && this.graph.directionAway(next, node);
      const smooth = on2 && -(back.x * on2.x + back.y * on2.y) > SMOOTH_JOIN;
      if (!same || !smooth || next === segment) break;
      [piece, from] = [next, node];
    }
    return {
      dir: this.graph.directionAway(segment, nodeId),
      halfWidth: carriagewayWidth(segment.spec) / 2,
      footpath: segment.spec.footpath ? FOOTPATH_WIDTH : 0,
      length,
      // Walking away from the junction; "right" flips where the road runs towards it.
      edge: (offset: number, along: number) => {
        const piece = pieces.find((p) => along < p.start + p.path.length) ?? pieces[pieces.length - 1];
        const s = Math.min(along - piece.start, piece.path.length);
        const f = piece.path.at(piece.forward ? s : piece.path.length - s);
        const side = piece.forward ? offset : -offset;
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

    // Where a slip road joins: its control (give way unless set otherwise); where one leaves, none.
    const slip = slipRoad(this.graph, nodeId);
    if (slip && !slip.merge) return;
    const control = slip ? slipControlAt(this.graph, nodeId) : effectiveControl(this.graph.junction(nodeId));
    if (control === "none") return;

    const group = new Group();
    const approaches = signalApproaches(this.graph, nodeId);
    // Stop and give way signs only where traffic stops or gives way: not on the main road.
    const minor = minorRoads(this.graph, nodeId);
    const lamps: Mesh[][] = [];
    // Approaching traffic drives on its own right (right-hand traffic), which is to the left of
    // the direction leaving the junction.
    const keep = this.graph.drivingSide === "right" ? -1 : 1;
    for (const segment of meeting) {
      if (!approaches.includes(segment.id)) continue;
      const arm = this.armOf(segment, nodeId);
      const setback = arm.footpath > 0 ? arm.footpath / 2 : SIGN_SETBACK;
      const along = this.endAt(segment, nodeId).inset + 1;
      const spot = this.roundaboutSigns.get(nodeId)?.get(segment.id) ?? {
        position: arm.edge(keep * (arm.halfWidth + setback), along),
        facing: arm.dir,
      };
      if ((control === "stop" || control === "yield") && !minor.has(segment.id)) continue;
      if (control === "stop") group.add(this.kit.stopSign(spot));
      else if (control === "yield") group.add(this.kit.yieldSign(spot));
      else {
        // Kerb-side is the driver's right in right-hand traffic.
        const signal = this.kit.signal(spot, this.graph.drivingSide === "right" ? 1 : -1);
        group.add(signal.group);
        lamps[approaches.indexOf(segment.id)] = signal.lamps;
      }
    }
    this.add(group);
    this.furniture.set(nodeId, group);
    if (lamps.length) this.signals.set(nodeId, lamps);
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
    // A slip road peels off or tapers in: the roads overlap, with no junction surface or corners.
    if (slipRoad(this.graph, nodeId)) return;
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
        // Footpaths and the islands (their kerbs and planting) stand above the road.
        if (part === "footpath" || part === "median") mesh.position.y = KERB_HEIGHT;
        return mesh;
      });
    } else {
      const { parts, reach } = buildJunctionParts(
        meeting.map((segment) => this.armOf(segment, nodeId)),
        kerbRadius(settings.cornerRadius),
      );
      this.cornerReach.set(nodeId, new Map(meeting.map((segment, i) => [segment.id, reach[i]])));
      const bend = this.bendLines(nodeId);
      // A paved bend: a curved stretch of road, the same width all the way round, instead of corners.
      const surface = this.pavedBend(nodeId) ? buildBendSurface(meeting[0].spec, this.bendEdge(nodeId)!) : parts;
      const all: { part: RoadPart; geometry: BufferGeometry }[] = [...surface, ...(bend ? buildBendMarkings(bend) : [])];
      // Where a bridge or tunnel meets a road round a bend, the markings carried round it go over the
      // bridge's (or tunnel's) surface, which is drawn after the ground's.
      const graded = meeting.some((s) => s.spec.level);
      meshes = all.map(({ part, geometry }, i) => {
        const over = graded && i >= surface.length;
        if (over) this.liftOntoGraded(geometry, meeting);
        const mesh = new Mesh(geometry, over ? this.overMaterial(part) : this.materials[part]);
        mesh.renderOrder = over ? GRADED_ORDER + ROAD_PART_STYLE[part].layer + 0.5 : ROAD_PART_STYLE[part].layer;
        if ((part === "footpath" || part === "median") && !over) mesh.position.y = KERB_HEIGHT;
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
    if (meeting.length === 2) {
      // Round a bend, markings stop where its paved corner starts and carry on along curves (see bendLines).
      return { inset: this.bendLines(nodeId) ? this.bendInset(segment, nodeId) : 0, entry: "none" };
    }
    if (meeting.length === 1) return { inset: carriagewayWidth(segment.spec) / 2, entry: "none", turnaround: true };
    // At a slip road the main road's markings run straight on; the slip road's start clear of it, with no line.
    const slip = slipRoad(this.graph, nodeId);
    if (slip) {
      // Where it joins: a line across the slip road (give way, or stop for a stop sign or signals);
      // under signals the main road stops too, a little back from where the slip road meets it.
      const control = slip.merge ? slipControlAt(this.graph, nodeId) : null;
      if (segment.id === slip.slip) {
        return { inset: this.slipClear(segment, nodeId, slip.through), entry: control === null ? "none" : control === "yield" ? "yield" : "stop" };
      }
      return control === "signals" ? { inset: SLIP_CLEAR / 2, entry: "stop" } : { inset: 0, entry: "none" };
    }

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
    // The main road under a stop or give-way control has no line: its traffic doesn't stop.
    const main = (control === "stop" || control === "yield") && !minorRoads(this.graph, nodeId).has(segment.id);
    const entry = control === "none" || main ? "none" : control === "yield" ? "yield" : "stop";
    // Where people walk, a zebra crossing between the stop line and the junction.
    const crossing = !!segment.spec.footpath;
    if (crossing) inset += CROSSING_ROOM;
    return { inset, entry, turns: this.laneTurns(segment, nodeId), crossing };
  }

  /**
   * How far along slip road `segment` from `nodeId` it's clear of the main road: where its whole
   * carriageway has left the main road's (so a line there is just before the lane it joins).
   */
  private slipClear(segment: RoadSegment, nodeId: NodeId, through: [SegmentId, SegmentId]): number {
    const path = this.graph.drawnPath(segment);
    const main = through.map((id) => this.graph.segments.get(id)!);
    const reach = Math.max(...main.map((m) => carriagewayWidth(m.spec) / 2)) + carriagewayWidth(segment.spec) / 2;
    const at = (d: number) => path.at(segment.a === nodeId ? d : path.length - d).p;
    const clear = (d: number) => main.every((m) => this.graph.path(m).distanceTo(at(d)) >= reach);
    for (let d = 0; d < path.length; d += 1) if (clear(d)) return d + SLIP_LINE_GAP;
    return SLIP_CLEAR;
  }

  /**
   * Where a road stops short of a bend (its markings, and its surface where the bend is paved as a
   * curve): where the corner's kerb meets it, and far enough out for the inside footpath to curve round.
   */
  private bendInset(segment: RoadSegment, nodeId: NodeId): number {
    const margin = roadWidth(segment.spec) / 2 + 2;
    // No more than half the road: the other end may stop short of a bend too.
    return Math.min(Math.max(this.cornerReach.get(nodeId)?.get(segment.id) ?? 0, margin), this.graph.path(segment).length / 2);
  }

  /** Whether the bend at `nodeId` is paved as a curve joining its two roads (not on a bridge or in a tunnel). */
  /** Whether `segment` carries straight on at `node` into the one other road there, the same layout. */
  private carriesOn(segment: RoadSegment, node: NodeId): boolean {
    const meeting = this.graph.segmentsAt(node);
    const other = meeting.length === 2 ? meeting.find((s) => s !== segment) : undefined;
    if (!other || roadWidth(other.spec) !== roadWidth(segment.spec) || carriagewayWidth(other.spec) !== carriagewayWidth(segment.spec)) return false;
    const [a, b] = [this.graph.directionAway(segment, node), this.graph.directionAway(other, node)];
    return a.x * b.x + a.y * b.y < -STRAIGHT_ON;
  }

  private pavedBend(nodeId: NodeId): boolean {
    return this.bendEdge(nodeId) !== null && !this.graph.segmentsAt(nodeId).some((s) => s.spec.level);
  }

  /**
   * The markings carried round a bend where two roads of the same layout join: the centre line
   * (or median) and each lane line, as curves from one road's markings to the other's. Null where
   * the roads carry straight on, or differ (their markings simply meet).
   */
  private bendLines(nodeId: NodeId): BendLine[] | null {
    const curve = this.bendEdge(nodeId);
    if (!curve) return null;
    const { spec } = this.graph.segmentsAt(nodeId)[0];
    const lines: BendLine[] = [];
    if (spec.oneWay) {
      const left = -carriagewayWidth(spec) / 2;
      for (let k = 1; k < spec.lanes; k++) lines.push({ kind: "laneLine", pieces: curve(left + k * LANE_WIDTH) });
    } else {
      lines.push({ kind: hasMedian(spec) ? "median" : "centerLine", pieces: curve(0) });
      const middle = hasMedian(spec) ? MEDIAN_WIDTH / 2 : 0;
      for (let k = 1; k < spec.lanes; k++) {
        for (const side of [1, -1]) lines.push({ kind: "laneLine", pieces: curve(side * (middle + k * LANE_WIDTH)) });
      }
    }
    return lines;
  }

  /**
   * Round a bend where two roads of the same layout join: the curve `offset` right of travel (from
   * the first road, round the bend, onto the other) from where one stops to where the other starts.
   * Null where the roads carry straight on, or differ.
   */
  private bendEdge(nodeId: NodeId): ((offset: number) => Curve[]) | null {
    const meeting = this.graph.segmentsAt(nodeId);
    if (meeting.length !== 2) return null;
    const [into, out] = meeting;
    const same = (p: RoadSpec, q: RoadSpec) => p.lanes === q.lanes && p.oneWay === q.oneWay && p.median === q.median;
    if (!same(into.spec, out.spec)) return null;
    // One-way roads must run on through the node.
    if (into.spec.oneWay && (into.b !== nodeId || out.a !== nodeId)) return null;
    const a = this.graph.directionAway(into, nodeId);
    const b = this.graph.directionAway(out, nodeId);
    if (a.x * b.x + a.y * b.y < -Math.cos(STRAIGHT_ENOUGH)) return null;

    // A point `offset` right of travel (from `into`, round the bend, onto `out`) where each road's markings stop.
    const frame = (segment: RoadSegment, arriving: boolean, offset: number) => {
      const path = this.graph.path(segment);
      const forward = (segment.b === nodeId) === arriving;
      const inset = this.bendInset(segment, nodeId);
      const f = path.at(segment.b === nodeId ? path.length - inset : inset);
      const sign = forward ? 1 : -1;
      return {
        p: { x: f.p.x + f.normal.x * offset * sign, y: f.p.y + f.normal.y * offset * sign },
        t: { x: f.tangent.x * sign, y: f.tangent.y * sign },
      };
    };
    return (offset: number) => {
      const from = frame(into, true, offset);
      const to = frame(out, false, offset);
      return bridge(from.p, from.t, to.p, to.t);
    };
  }

  /** The turns each lane of `segment` arriving at junction `nodeId` may make, from its lane connections. */
  private laneTurns(segment: RoadSegment, nodeId: NodeId): Turn[][] | undefined {
    if (!hasLaneConnector(this.graph, nodeId)) return undefined;
    const turns: Turn[][] = Array.from({ length: segment.spec.lanes }, () => []);
    for (const c of connectionsAt(this.graph, nodeId)) {
      if (c.from.segment !== segment.id) continue;
      const turn = turnAt(this.graph, nodeId, segment, this.graph.segments.get(c.to.segment)!);
      if (!turns[c.from.lane].includes(turn)) turns[c.from.lane].push(turn);
    }
    return turns;
  }

  private addSegment(segment: RoadSegment): void {
    const ends = { start: this.endAt(segment, segment.a), end: this.endAt(segment, segment.b) };
    const path = this.graph.drawnPath(segment);
    const graded = !!segment.spec.level;
    // Heights by distance along the drawn road, as the graph has them along its centre line.
    const scale = this.graph.path(segment).length / (path.length || 1);
    const height = (s: number) => this.graph.heightAt(segment, s * scale);
    // A bridge or tunnel is drawn over the roads it meets: no rounded end lying on top of them there.
    // Nor where it's only split (as at a driveway) and carries straight on, the same road: the two
    // pieces meet flush, their kerbs unbroken (a round end would cut across the other's kerb).
    const joined = (node: NodeId) => (!graded || this.graph.segmentsAt(node).length < 2) && !this.carriesOn(segment, node);
    // Round a paved bend, the bend's curve carries on from where this road stops.
    const trim = (node: NodeId) => (this.pavedBend(node) ? this.bendInset(segment, node) : 0);
    const [trimA, trimB] = [trim(segment.a), trim(segment.b)];
    const caps: [boolean, boolean] = [joined(segment.a) && !trimA, joined(segment.b) && !trimB];
    const paved: [number, number] = [trimA, path.length - trimB];
    const meshes: Mesh[] = buildRoadParts(path, segment.spec, ends, this.graph.drivingSide, caps, paved).map(({ part, geometry }) => {
      const layer = ROAD_PART_STYLE[part].layer;
      // A bridge or tunnel: lifted (or sunk) to its height, drawn with depth so it hides (and is
      // hidden by) what it passes over or under.
      if (graded) liftGeometry(geometry, path, height, layer);
      const mesh = new Mesh(geometry, graded ? this.gradedMaterial(part) : this.materials[part]);
      mesh.renderOrder = graded ? GRADED_ORDER + layer : layer;
      // Footpaths and medians stand above the road.
      if (part === "footpath" || part === "median") mesh.position.y = KERB_HEIGHT;
      // A bridge's deck shades what's under it.
      if (graded && (segment.spec.level ?? 0) > 0) mesh.castShadow = true;
      return mesh;
    });
    const width = carriagewayWidth(segment.spec) + (segment.spec.footpath ? 2 * FOOTPATH_WIDTH : 0);
    if (graded) meshes.push(...gradeStructure(path, width, height, this.concrete));
    // A tunnel: an opening in the ground over its ramps (drawn just before the ground).
    if ((segment.spec.level ?? 0) < 0) meshes.push(trenchMask(path, width, height, FlatLayer.ground - 0.5));
    this.add(...meshes);
    this.views.set(segment.id, meshes);
  }

  /** Points of markings round a bend lying on a bridge's or tunnel's ramp (nearer it than the other road): up (or down) to it. */
  private liftOntoGraded(geometry: BufferGeometry, meeting: RoadSegment[]): void {
    const position = geometry.getAttribute("position");
    for (let i = 0; i < position.count; i++) {
      const p = { x: position.getX(i), y: position.getZ(i) };
      let best = { d: Infinity, h: 0 };
      for (const segment of meeting) {
        const path = this.graph.drawnPath(segment);
        const { distance, s } = path.nearest(p);
        if (distance < best.d) best = { d: distance, h: this.graph.heightAt(segment, s * (this.graph.path(segment).length / (path.length || 1))) };
      }
      position.setY(i, best.h + 0.2);
    }
    position.needsUpdate = true;
  }

  /** A marking drawn over a bridge's or tunnel's surface where it meets the ground: not hidden by it. */
  private overMaterial(part: RoadPart): MeshBasicMaterial {
    let material = this.over.get(part);
    if (!material) {
      material = textured(part, this.materials[part].clone());
      material.depthTest = false;
      this.over.set(part, material);
    }
    return material;
  }

  /** A road part's material for bridges and tunnels: as on the ground, but writing depth. */
  private gradedMaterial(part: RoadPart): MeshBasicMaterial {
    let material = this.graded.get(part);
    if (!material) {
      material = textured(part, this.materials[part].clone());
      material.depthWrite = true;
      this.graded.set(part, material);
    }
    return material;
  }

  private removeSegment(id: SegmentId): void {
    for (const mesh of this.views.get(id) ?? []) {
      this.remove(mesh);
      // A bridge's or tunnel's concrete shares its box; it owns only its instances.
      if ((mesh as InstancedMesh).isInstancedMesh) (mesh as InstancedMesh).dispose();
      else mesh.geometry.dispose();
      // A tunnel's opening in the ground has its own material.
      if (mesh.userData.own) (mesh.material as MeshBasicMaterial).dispose();
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
    for (const { driveway } of this.markers.values()) driveway.geometry.dispose();
    this.buildings.dispose();
    for (const material of Object.values(this.materials)) material.dispose();
  }
}

/** Footpaths and medians draw their kerb stones (also on copies: a clone doesn't keep it). */
function textured(part: RoadPart, material: MeshBasicMaterial): MeshBasicMaterial {
  return part === "footpath" || part === "median" ? kerbColouring(material) : material;
}
