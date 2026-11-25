import { offsetCurve, reverseCurve, SampledCurve, type Curve, type PathFrame } from "./curve";
import type { Vec2 } from "./geometry";
import { roundaboutShape } from "./junction";
import type { DrivingSide, NodeId, RoadGraph, RoadSegment, SegmentId } from "./roadGraph";
import { laneOffsets, lanesInnerToKerb, scaleRank, type Turn } from "./lanes";
import { LANE_WIDTH } from "./roadSpec";
import type { Lot } from "./terminal";

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
  /** Roundabout legs: the ring's centre, the radius cars circulate at, and the angles they join and leave it. */
  ring?: { centre: Vec2; radius: number; entry: number; exit: number; direction: 1 | -1 };
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
      const curve = this.graph.curveOf(segment);
      const offset = laneOffsets(segment.spec, this.graph.drivingSide)[lane];
      track = new Track(offsetCurve(forward ? curve : reverseCurve(curve), offset));
      this.roadTracks.set(key, track);
    }
    const toNode = forward ? segment.b : segment.a;
    // The lane is a little longer or shorter than the centre line on bends; scale the insets to match.
    const scale = track.length / (this.graph.path(segment).length || 1);
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
    const change = Math.min(LANE_CHANGE_LENGTH, legLength(exit) * 0.6);
    const lanes = laneOffsets(segment.spec, this.graph.drivingSide);
    const half = (legLength(exit) - change) / 2;
    const lead = early ? Math.min(LANE_CHANGE_LEAD, half) : half;
    const leave = entry.from + lead * (legLength(entry) / (legLength(exit) || 1));
    const join = exit.from + lead + change;
    const p0 = entry.track.at(leave);
    const p1 = exit.track.at(join);
    const track = new Track(bridge(p0.p, p0.tangent, p1.p, p1.tangent));
    return [
      { ...entry, to: leave },
      {
        track,
        from: 0,
        to: track.length,
        key: `c:${entry.key}>${exitLane}`,
        segment: segment.id,
        outKey: exit.key,
        joinAt: join,
        shift: lanes[exitLane] > lanes[entryLane] ? 1 : -1,
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
