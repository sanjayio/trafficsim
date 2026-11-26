import { offsetCurve, reverseCurve, SampledCurve, type Curve, type PathFrame } from "./curve";
import type { Vec2 } from "./geometry";
import { roundaboutShape } from "./junction";
import type { DrivingSide, NodeId, RoadGraph, RoadSegment, SegmentId } from "./roadGraph";
import { laneOffsets, lanesInnerToKerb, scaleRank, type Turn } from "./lanes";
import { LANE_WIDTH } from "./roadSpec";
import { carPark, LOT_SETBACK, lotPoint, PARKING_DEPTH, type Bay, type Lot } from "./terminal";

/** A drivable line made of curve pieces joined end to end, walked by distance. */
export class Track {
  private pieces: SampledCurve[];
  /** Distance along the track where each piece starts. */
  private starts: number[] = [];
  readonly length: number;

  constructor(curves: Curve[]) {
    this.pieces = curves.map((c) => new SampledCurve(c));
    let total = 0;
    for (const piece of this.pieces) {
      this.starts.push(total);
      total += piece.length;
    }
    this.length = total;
  }

  at(s: number): PathFrame {
    let i = this.pieces.length - 1;
    while (i > 0 && this.starts[i] > s) i--;
    return this.pieces[i].at(s - this.starts[i]);
  }

  /** Whether this track crosses `other` (anywhere along either). */
  crosses(other: Track): boolean {
    return this.pieces.some((p) => other.pieces.some((q) => p.intersections(q).length > 0));
  }
}

/** One stretch of a car's route. */
export interface Leg {
  track: Track;
  /** Distance along `track` where the leg starts and ends. */
  from: number;
  to: number;
  /**
   * Cars on legs with the same key share a lane, so they follow each other. Road legs:
   * "r:segment:direction:lane". Junction legs: "j:node:segment:lane" (by the lane they came from).
   */
  key: string;
  segment?: SegmentId;
  /** Junction legs: the junction, and the movement's identity (in lane → out lane). */
  node?: NodeId;
  movement?: string;
  /** Out lane of a junction movement or lane change, as its road leg key (to check there's room). */
  outKey?: string;
  /** Lane changes: where along the target lane's track the car joins it, and which way it moves (1 right, -1 left). */
  joinAt?: number;
  shift?: 1 | -1;
  turn?: Turn;
  /** Driven backwards (backing out of a parking bay). */
  reverse?: boolean;
  /** Into an underground car park: a car parked at its end is out of sight, and out of the way. */
  underground?: boolean;
  /** Roundabout legs: the ring's centre, the radius cars circulate at, and the angles they join and leave it. */
  ring?: { centre: Vec2; radius: number; entry: number; exit: number; direction: 1 | -1 };
  /**
   * Lane changes along a road: the whole of the lanes it leaves and joins, how far along the road
   * (along the lane joined) it starts, and the furthest it can start and still finish before the
   * road's end. A car that can't change where planned moves it on, see `TrackBuilder.changeAt`.
   */
  slide?: { entry: Leg; exit: Leg; lead: number; maxLead: number };
}

export function legLength(leg: Leg): number {
  return Math.max(0, leg.to - leg.from);
}

export function legAt(leg: Leg, s: number): PathFrame {
  return leg.track.at(leg.from + Math.min(Math.max(s, 0), legLength(leg)));
}

/**
 * Builds the legs a car drives, from where roads stop at their junctions (`insetAt`, the stop
 * line) and the lanes it uses on each road (`laneFor`, by the turn at the road's end).
 */
export class TrackBuilder {
  private roadTracks = new Map<string, Track>();
  private movements = new Map<string, Track>();

  constructor(
    private graph: RoadGraph,
    private insetAt: (segment: RoadSegment, nodeId: NodeId) => number,
  ) {}

  /** Forget cached geometry (the network changed). */
  clear(): void {
    this.roadTracks.clear();
    this.movements.clear();
  }

  /** The road leg for driving `segment` away from `fromNode` in `lane`. */
  roadLeg(segment: RoadSegment, fromNode: NodeId, lane: number, ends: RoadEnds = {}): Leg {
    const forward = segment.a === fromNode;
    const key = `r:${segment.id}:${forward ? 1 : -1}:${lane}`;
    let track = this.roadTracks.get(key);
    if (!track) {
      // As drawn: a slip road's end runs from the main road's outside lane.
      const curve = this.graph.drawnCurve(segment);
      const offset = laneOffsets(segment.spec, this.graph.drivingSide)[lane];
      track = new Track(offsetCurve(forward ? curve : reverseCurve(curve), offset));
      this.roadTracks.set(key, track);
    }
    const toNode = forward ? segment.b : segment.a;
    // The lane is a little longer or shorter than the centre line on bends; scale the insets to match.
    const scale = track.length / (this.graph.drawnPath(segment).length || 1);
    const from = Math.max(this.insetAt(segment, fromNode), ends.start ?? 0) * scale;
    const to = track.length - Math.max(this.insetAt(segment, toNode), ends.end ?? 0) * scale;
    return { track, from, to: Math.max(from, to), key, segment: segment.id };
  }

  /**
   * The legs for driving `segment` away from `fromNode`, entering in `entryLane` and leaving in
   * `exitLane`: one leg, or (when they differ) the entry lane, a smooth lane change, and the exit
   * lane. The change comes `early` (straight out of a source, before any queue at the far end) or
   * halfway along (after a junction, so a car waiting for a gap doesn't block the junction's exit).
   */
  roadLegs(segment: RoadSegment, fromNode: NodeId, entryLane: number, exitLane: number, early: boolean, ends: RoadEnds = {}): Leg[] {
    const exit = this.roadLeg(segment, fromNode, exitLane, ends);
    if (entryLane === exitLane) return [exit];
    const entry = this.roadLeg(segment, fromNode, entryLane, ends);
    const half = (legLength(exit) - changeLength(exit)) / 2;
    return this.changeAt(entry, exit, early ? Math.min(LANE_CHANGE_LEAD, half) : half);
  }

  /**
   * Driving lane `entry` (a whole road leg), a smooth change starting `lead` along the road (as
   * measured along `exit`), then lane `exit` from where it joins.
   */
  changeAt(entry: Leg, exit: Leg, lead: number): Leg[] {
    const change = changeLength(exit);
    const leave = entry.from + lead * (legLength(entry) / (legLength(exit) || 1));
    const join = exit.from + lead + change;
    const p0 = entry.track.at(leave);
    const p1 = exit.track.at(join);
    const track = new Track(bridge(p0.p, p0.tangent, p1.p, p1.tangent));
    const lanes = laneOffsets(this.graph.segments.get(entry.segment!)!.spec, this.graph.drivingSide);
    const [entryLane, exitLane] = [entry, exit].map((l) => Number(l.key.split(":")[3]));
    // Room to finish the change a car length before the road's end.
    const maxLead = Math.max(lead, legLength(exit) - change - LANE_CHANGE_ROOM);
    return [
      { ...entry, to: leave },
      {
        track,
        from: 0,
        to: track.length,
        // Cars changing at different points are on different paths: they don't follow each other.
        key: `c:${entry.key}>${exitLane}@${Math.round(leave)}`,
        segment: entry.segment,
        outKey: exit.key,
        joinAt: join,
        shift: lanes[exitLane] > lanes[entryLane] ? 1 : -1,
        slide: { entry, exit, lead, maxLead },
      },
      { ...exit, from: join },
    ];
  }

  /**
   * Out of a source's building onto `road` (where it starts): a short stretch at the door, where
   * a new car waits, and the driveway, which joins the road's lane like a lane change (cars wait
   * for a gap in it, and those in it make room).
   */
  drivewayOut(node: NodeId, lot: Lot, road: Leg): [Leg, Leg] {
    const door = lot.door;
    const towards = { x: -lot.out.x, y: -lot.out.y };
    const step = { x: door.x + towards.x * DOOR_LENGTH, y: door.y + towards.y * DOOR_LENGTH };
    const join = legAt(road, 0);
    const driveway = new Track(bridge(step, towards, join.p, join.tangent));
    const turn = towards.x * join.tangent.y - towards.y * join.tangent.x;
    return [
      { track: new Track([straight(door, step)]), from: 0, to: DOOR_LENGTH, key: `door:${node}` },
      {
        track: driveway,
        from: 0,
        to: driveway.length,
        key: `out:${node}:${road.key}`,
        segment: road.segment,
        outKey: road.key,
        joinAt: road.from,
        // World y points down the screen: a positive cross product turns right.
        shift: turn > 0 ? 1 : -1,
      },
    ];
  }

  /** Off `road` (where it ends) along a sink's driveway, to its building's door. */
  drivewayIn(node: NodeId, lot: Lot, road: Leg): Leg {
    const door = lot.door;
    const leave = legAt(road, legLength(road));
    const driveway = new Track(bridge(leave.p, leave.tangent, door, lot.out));
    const turn = leave.tangent.x * lot.out.y - leave.tangent.y * lot.out.x;
    return { track: driveway, from: 0, to: driveway.length, key: `in:${node}`, segment: road.segment, shift: turn > 0 ? 1 : -1 };
  }

  /**
   * Into bay `index` of a shop's or office's car park (see `carPark`), off `last` (the last road
   * leg, returned cut to end where the car turns off). A front bay: over into the front yard,
   * along it and a quarter turn in. A rear bay: a turn off the road up the side path, then along
   * the lane behind the building and in. Nose to the building (front) or to the back fence (rear).
   */
  parkIn(node: NodeId, lot: Lot, index: number, last: Leg): { road: Leg; legs: Leg[] } {
    const park = carPark(lot);
    const bay = park.bays[index];
    if (bay.underground) {
      // Down the driveway and across the plaza to the garage entrance, where the car goes out of sight.
      const entrance = lotPoint(lot, bay.a, bay.z);
      const ramp = new Track([straight(lot.door, entrance)]);
      return {
        road: last,
        legs: [this.drivewayIn(node, lot, last), { track: ramp, from: 0, to: ramp.length, key: `ramp:${node}`, underground: true }],
      };
    }
    const centre = lotPoint(lot, bay.a, bay.z);
    const end = legAt(last, legLength(last));
    const along = alongWith(lot, end.tangent);
    // Where the car leaves the road for the lot, and how far before it the road leg stops.
    const [target, heading, before] =
      park.path !== null && bay.rear
        ? [lotPoint(lot, park.path, -lot.depth / 2), lot.out, TURN_IN]
        : [lotPoint(lot, bay.a - sign(lot, along) * AISLE_TURN, bay.z - AISLE_TURN), along, YARD_RUN];
    const rear = park.path !== null && bay.rear ? this.rearIn(node, lot, park.path, park.aisle, bay, index, target) : null;
    const ahead = (target.x - end.p.x) * end.tangent.x + (target.y - end.p.y) * end.tangent.y;
    const road = { ...last, to: Math.min(last.track.length, Math.max(last.from + 1, last.to + ahead - before)) };
    const leave = legAt(road, legLength(road));
    const off = new Track(bridge(leave.p, leave.tangent, target, heading));
    const turn = leave.tangent.x * lot.out.y - leave.tangent.y * lot.out.x;
    const into = new Track(bridge(target, heading, centre, lot.out));
    const offLeg: Leg = { track: off, from: 0, to: off.length, key: bay.rear ? `in:${node}:rear` : `in:${node}`, segment: road.segment, shift: turn > 0 ? 1 : -1 };
    return {
      road,
      legs: rear ? [offLeg, ...rear] : [offLeg, { track: into, from: 0, to: into.length, key: `bay:${node}:${index}` }],
    };
  }

  /**
   * Out of bay `index` onto `first` (the first road leg, returned cut to start where the car
   * joins it): backing out with a quarter turn (`reverse` marks that leg), then forward, through
   * the front yard or up the side path, and onto the road's lane like a lane change (the last leg).
   */
  parkOut(node: NodeId, lot: Lot, index: number, first: Leg): { road: Leg; legs: Leg[] } {
    const park = carPark(lot);
    const bay = park.bays[index];
    if (bay.underground) {
      // Up out of the garage entrance, across the plaza and out of the driveway.
      const entrance = lotPoint(lot, bay.a, bay.z);
      const exit = new Track([straight(entrance, lot.door)]);
      const [door, driveway] = this.drivewayOut(node, lot, first);
      return { road: first, legs: [{ track: exit, from: 0, to: exit.length, key: `exit:${node}` }, door, driveway] };
    }
    const centre = lotPoint(lot, bay.a, bay.z);
    const start = legAt(first, 0);
    const toPath = park.path !== null && bay.rear;
    let legs: Leg[];
    let from: Vec2;
    let heading: Vec2;
    if (toPath) {
      // Rear bays face the lane: drive straight out, along it, and up the side driveway to the road.
      from = lotPoint(lot, park.path!, -lot.depth / 2);
      heading = neg(lot.out);
      const towardPath = alongToward(lot, park.path! - bay.a);
      // Out of the bay onto the lane, short of the corner, then the lane and driveway every car shares.
      const turn = Math.min(AISLE_TURN, Math.abs(park.path! - bay.a) - LANE_CORNER - 0.5);
      const onLane = bay.a + sign(lot, towardPath) * turn;
      const out = new Track(bridge(centre, noseOf(lot, bay), lotPoint(lot, onLane, park.aisle), towardPath));
      const shared = this.laneOut(lot, park.path!, park.aisle, towardPath);
      legs = [
        { track: out, from: 0, to: out.length, key: `bay:${node}:${index}` },
        { track: shared.track, from: Math.abs(shared.far - onLane), to: shared.track.length, key: `path:${node}` },
      ];
    } else {
      // Backing out along the front yard with the traffic, then onto the road.
      heading = alongWith(lot, start.tangent);
      from = lotPoint(lot, bay.a - sign(lot, heading) * AISLE_TURN, bay.z - AISLE_TURN);
      const reverse = new Track(bridge(centre, neg(lot.out), from, neg(heading)));
      legs = [{ track: reverse, from: 0, to: reverse.length, key: `bay:${node}:${index}`, reverse: true }];
    }
    const ahead = (from.x - start.p.x) * start.tangent.x + (from.y - start.p.y) * start.tangent.y;
    const road = { ...first, from: Math.max(0, Math.min(first.to - 1, first.from + ahead + (toPath ? TURN_IN : YARD_RUN))) };
    const join = legAt(road, 0);
    const merge = new Track(bridge(from, heading, join.p, join.tangent));
    const turn = heading.x * join.tangent.y - heading.y * join.tangent.x;
    legs.push({
      track: merge,
      from: 0,
      to: merge.length,
      key: `out:${node}:${road.key}`,
      segment: road.segment,
      outKey: road.key,
      joinAt: road.from,
      shift: turn > 0 ? 1 : -1,
    });
    return { road, legs };
  }

  /**
   * From the top of the side driveway (`top`) to rear bay `bay`: down the driveway, along the
   * lane behind the building past the bay, and backing into it, so it faces the lane.
   */
  private rearIn(node: NodeId, lot: Lot, path: number, aisle: number, bay: Bay, index: number, top: Vec2): Leg[] {
    const towardBay = alongToward(lot, bay.a - path);
    const pastAt = bay.a + sign(lot, towardBay) * AISLE_TURN;
    const past = lotPoint(lot, pastAt, aisle);
    // Down the driveway and along the lane: one track every car shares (so they queue), each to its own spot.
    const corner = lotPoint(lot, path + sign(lot, towardBay) * LANE_CORNER, aisle);
    const farAt = path + sign(lot, towardBay) * lot.length * 1.5;
    const lane = new Track([...bridge(top, lot.out, corner, towardBay), straight(corner, lotPoint(lot, farAt, aisle))]);
    const into = new Track(bridge(past, neg(towardBay), lotPoint(lot, bay.a, bay.z), neg(noseOf(lot, bay))));
    return [
      { track: lane, from: 0, to: lane.length - Math.abs(farAt - pastAt), key: `lane:${node}` },
      { track: into, from: 0, to: into.length, key: `bay:${node}:${index}`, reverse: true },
    ];
  }

  /**
   * Along the lane behind the building towards the side driveway (`toward`) and up it to the road
   * end, from far along the lane: one track every car leaving shares. `far` is where it starts (along).
   */
  private laneOut(lot: Lot, path: number, aisle: number, toward: Vec2): { track: Track; far: number } {
    const far = path - sign(lot, toward) * lot.length * 1.5;
    const corner = lotPoint(lot, path - sign(lot, toward) * LANE_CORNER, aisle);
    const top = lotPoint(lot, path, -lot.depth / 2);
    return { track: new Track([straight(lotPoint(lot, far, aisle), corner), ...bridge(corner, toward, top, neg(lot.out))]), far };
  }

  /** Whether `node` is drawn (and driven) as a roundabout. */
  isRoundabout(node: NodeId): boolean {
    return this.graph.junction(node).roundabout && this.graph.segmentsAt(node).length >= 3;
  }

  /**
   * Which exit `out` is for traffic entering roundabout `node` from `into`: 1 for the first road
   * leaving round the ring in the direction of circulation, and so on (one-way roads in don't count).
   */
  exitNumber(node: NodeId, into: RoadSegment, out: RoadSegment): number {
    const angle = (s: RoadSegment) => {
      const d = this.graph.directionAway(s, node);
      return Math.atan2(d.y, d.x);
    };
    const direction = circulation(this.graph.drivingSide);
    const from = angle(into);
    const round = (s: RoadSegment) => (((direction * (angle(s) - from)) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) || Math.PI * 2;
    const exits = this.graph.segmentsAt(node).filter((s) => s.id !== into.id && (!s.spec.oneWay || s.a === node));
    return exits.filter((s) => round(s) < round(out)).length + 1;
  }

  /** The leg across junction `node` from `inLeg`'s end to `outLeg`'s start. */
  junctionLeg(node: NodeId, inLeg: Leg, outLeg: Leg, inLane: number, outLane: number, turn: Turn): Leg {
    const movement = `${node}:${inLeg.segment}:${inLane}>${outLeg.segment}:${outLane}`;
    let track = this.movements.get(movement);
    const start = legAt(inLeg, legLength(inLeg));
    const end = legAt(outLeg, 0);
    const ring = this.isRoundabout(node) ? this.ringOf(node, inLeg, inLane, start.p, end.p) : undefined;
    if (!track) {
      track = new Track(ring ? ringCurves(start, end, ring) : bridge(start.p, start.tangent, end.p, end.tangent));
      this.movements.set(movement, track);
    }
    return {
      track,
      from: 0,
      to: track.length,
      key: `j:${node}:${inLeg.segment}:${inLane}`,
      node,
      movement,
      outKey: outLeg.key,
      turn,
      ring,
    };
  }

  /**
   * The ring lane (0 by the island) a car in `lane` of road `into` circulates in: the matching
   * lane, so the inner lane enters the inner ring lane and the kerb lane the outer one.
   */
  ringLane(node: NodeId, into: RoadSegment, lane: number): number {
    const approach = lanesInnerToKerb(into.spec, this.graph.drivingSide);
    return scaleRank(approach.indexOf(lane), approach.length, this.ringLanes(node));
  }

  /** The lane of road `out` a car leaving the ring from `ringLane` comes out in: the matching one. */
  exitLane(node: NodeId, ringLane: number, out: RoadSegment): number {
    const exit = lanesInnerToKerb(out.spec, this.graph.drivingSide);
    return exit[scaleRank(ringLane, this.ringLanes(node), exit.length)];
  }

  private ringLanes(node: NodeId): number {
    return roundaboutShape(this.graph.segmentsAt(node).map((s) => s.spec)).lanes;
  }

  private ringOf(node: NodeId, inLeg: Leg, inLane: number, entryPoint: Vec2, exitPoint: Vec2): NonNullable<Leg["ring"]> {
    const centre = this.graph.node(node);
    const shape = roundaboutShape(this.graph.segmentsAt(node).map((s) => s.spec));
    const lane = this.ringLane(node, this.graph.segments.get(inLeg.segment!)!, inLane);
    const radius = shape.island + 2 + (lane + 0.5) * LANE_WIDTH;
    const direction = circulation(this.graph.drivingSide);
    const angle = (p: Vec2) => Math.atan2(p.y - centre.y, p.x - centre.x);
    return {
      centre: { x: centre.x, y: centre.y },
      radius,
      entry: angle(entryPoint) + direction * RING_JOIN,
      exit: angle(exitPoint) - direction * RING_JOIN,
      direction,
    };
  }

  /** Whether two movements through the same junction can't both be driven at once. */
  conflicts(a: Leg, b: Leg): boolean {
    if (a.movement === b.movement || a.key === b.key) return false;
    if (a.outKey === b.outKey) return true;
    return a.track.crosses(b.track);
  }
}

/** Seen on the map (north up), right-hand traffic goes round anticlockwise: decreasing angle, as world y points down. */
function circulation(side: DrivingSide): 1 | -1 {
  return side === "right" ? -1 : 1;
}

/** Where a road leg starts and ends, at least this far from its nodes (beyond the stop lines), when it meets a driveway. */
export interface RoadEnds {
  start?: number;
  end?: number;
}

/** The stretch a new car waits on at a building's door. */
const DOOR_LENGTH = 1;
/** From a bay's middle to the middle of the front yard in front of it: the radius of the turn in or out. */
const AISLE_TURN = PARKING_DEPTH / 2 + LOT_SETBACK / 2;
/** How far along the road a car takes to cross between its lane and the front yard. */
const YARD_RUN = 20;
/** Radius of the turn between the lane behind a building and its side driveway. */
const LANE_CORNER = 6;
/** How far along the road a car takes to turn between its lane and a side path. */
const TURN_IN = 12;

const neg = (v: Vec2): Vec2 => ({ x: -v.x, y: -v.y });
/** +1 if `v` points along the lot's road direction, -1 if against it. */
const sign = (lot: Lot, v: Vec2) => (v.x * lot.along.x + v.y * lot.along.y >= 0 ? 1 : -1);
/** The way along the lot's road that goes with `traffic`. */
const alongWith = (lot: Lot, traffic: Vec2): Vec2 => ({ x: lot.along.x * sign(lot, traffic), y: lot.along.y * sign(lot, traffic) });
/** Which way a parked car in `bay` points: to the building (front bays), or to the lane (rear bays, `facing`). */
const noseOf = (lot: Lot, bay: Bay): Vec2 => (bay.facing === -1 ? neg(lot.out) : lot.out);
/** The way along the lot's road towards an offset `delta` along it. */
const alongToward = (lot: Lot, delta: number): Vec2 => (delta >= 0 ? lot.along : neg(lot.along));

/** A straight piece from a to b, as a cubic. */
function straight(a: Vec2, b: Vec2): Curve {
  return {
    a,
    c1: { x: a.x + (b.x - a.x) / 3, y: a.y + (b.y - a.y) / 3 },
    c2: { x: a.x + ((b.x - a.x) * 2) / 3, y: a.y + ((b.y - a.y) * 2) / 3 },
    b,
  };
}

/** Longest stretch of road a lane change takes, and how far along the road it starts (less on short roads). */
const LANE_CHANGE_LENGTH = 50;
const LANE_CHANGE_LEAD = 20;
/** A lane change finishes at least this far before the road's end. */
const LANE_CHANGE_ROOM = 15;

/** How long a lane change onto lane `exit` takes, along the road. */
function changeLength(exit: Leg): number {
  return Math.min(LANE_CHANGE_LENGTH, legLength(exit) * 0.6);
}

/** How far round the ring (radians) cars join and leave it from their approach's direction. */
const RING_JOIN = 0.35;

/** Widest a turn's arc gets: tighter sharp turns stay out in the junction, clear of its corners. */
const TURN_RADIUS_MAX = 30;

/**
 * A smooth path from p0 heading t0 to p1 heading t1. Through a turn: straight on to an arc round
 * the point where the two lines of travel meet, then straight out. The arc is as wide as fits but
 * no wider than TURN_RADIUS_MAX, and tighter on sharp turns, so a sharp turn into an acute corner
 * swings round out in the junction instead of sweeping across the corner's kerb. Otherwise (lines of travel parallel, as
 * in a lane change, or not meeting ahead) one smooth cubic.
 */
export function bridge(p0: Vec2, t0: Vec2, p1: Vec2, t1: Vec2): Curve[] {
  const d = { x: p1.x - p0.x, y: p1.y - p0.y };
  const cross = t0.x * t1.y - t0.y * t1.x;
  const turn = Math.acos(Math.max(-1, Math.min(1, t0.x * t1.x + t0.y * t1.y)));
  if (Math.abs(cross) > 1e-3 && turn > 1e-3) {
    const ahead = (d.x * t1.y - d.y * t1.x) / cross; // from p0 to where the lines meet, along t0
    const behind = -(d.x * t0.y - d.y * t0.x) / cross; // from there to p1, along t1
    if (ahead > 0 && behind > 0) {
      // An arc of radius R turning through `turn` meets each line R·tan(turn/2) from the meeting
      // point. Past a right angle, the sharper the turn the more of the way in is driven straight
      // (up to 60% for a U-turn), so the arc stays out in the junction, away from the corner.
      const tangent = Math.tan(turn / 2);
      const share = turn <= Math.PI / 2 ? 1 : 1 - 0.6 * ((turn - Math.PI / 2) / (Math.PI / 2));
      const reach = Math.min(ahead * share, behind * share, TURN_RADIUS_MAX * tangent);
      const radius = reach / tangent;
      const a = { x: p0.x + t0.x * (ahead - reach), y: p0.y + t0.y * (ahead - reach) };
      const b = { x: p1.x - t1.x * (behind - reach), y: p1.y - t1.y * (behind - reach) };
      const h = (4 / 3) * Math.tan(turn / 4) * radius;
      const arc: Curve = { a, c1: { x: a.x + t0.x * h, y: a.y + t0.y * h }, c2: { x: b.x - t1.x * h, y: b.y - t1.y * h }, b };
      const near = (p: Vec2, q: Vec2) => Math.hypot(p.x - q.x, p.y - q.y) < 0.01;
      return [...(near(p0, a) ? [] : [straight(p0, a)]), arc, ...(near(b, p1) ? [] : [straight(b, p1)])];
    }
  }
  const h = Math.hypot(d.x, d.y) / 3;
  return [{ a: p0, c1: { x: p0.x + t0.x * h, y: p0.y + t0.y * h }, c2: { x: p1.x - t1.x * h, y: p1.y - t1.y * h }, b: p1 }];
}

/** Onto the ring, round it in the direction of circulation, and off again. */
function ringCurves(start: PathFrame, end: PathFrame, ring: NonNullable<Leg["ring"]>): Curve[] {
  const { centre, radius, entry, exit, direction } = ring;
  const point = (a: number) => ({ x: centre.x + Math.cos(a) * radius, y: centre.y + Math.sin(a) * radius });
  const heading = (a: number) => ({ x: -Math.sin(a) * direction, y: Math.cos(a) * direction });
  let sweep = (((direction * (exit - entry)) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  if (sweep < 0.05) sweep += Math.PI * 2;
  const curves: Curve[] = bridge(start.p, start.tangent, point(entry), heading(entry));
  // Arc pieces of at most a quarter turn, each a cubic with the standard 4/3·tan(φ/4) handles.
  const count = Math.ceil(sweep / (Math.PI / 2));
  const step = sweep / count;
  const k = (4 / 3) * Math.tan(step / 4) * radius;
  for (let i = 0; i < count; i++) {
    const a0 = entry + direction * step * i;
    const a1 = a0 + direction * step;
    const p0 = point(a0);
    const p1 = point(a1);
    const h0 = heading(a0);
    const h1 = heading(a1);
    curves.push({ a: p0, c1: { x: p0.x + h0.x * k, y: p0.y + h0.y * k }, c2: { x: p1.x - h1.x * k, y: p1.y - h1.y * k }, b: p1 });
  }
  curves.push(...bridge(point(exit), heading(exit), end.p, end.tangent));
  return curves;
}
