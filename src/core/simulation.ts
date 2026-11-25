import { effectiveControl, roundaboutShape, signalApproaches, signalLights, type JunctionControl } from "./junction";
import type { NodeId, RoadGraph, RoadSegment } from "./roadGraph";
import { CRUISE_SPEED, findRoute, type Route } from "./routing";
import { LANE_WIDTH } from "./roadSpec";
import { connectionsAt, hasLaneConnector, laneOffsets, lanesInnerToKerb, turnAt, type Turn } from "./lanes";
import { carPark, DRIVEWAY_BLEND } from "./terminal";
import { legAt, legLength, TrackBuilder, type Leg } from "./track";

/** Fixed simulation timestep in seconds, so traffic logic never sees a variable dt. */
export const SIM_DT = 1 / 60;

export const CAR_LENGTH = 14;
export const CAR_WIDTH = 6.5;
/** Car-following (IDM): acceleration, comfortable braking, standstill gap and time headway. */
const ACCEL = 15;
const BRAKE = 25;
const MIN_GAP = 3;
const HEADWAY = 0.9;
/** A car asks to enter a junction this far (plus its braking distance) before the stop line. */
const ASK_DISTANCE = 15;
/** Front cars this close to the line queue for an all-way junction, first come first served. */
const QUEUE_DISTANCE = 40;
/** At a stop sign, seconds a car stands at the line before it may go. */
const STOP_HOLD = 0.5;
/** Seconds of gap a car entering a roundabout needs before a circulating car reaches it. */
const RING_GAP = 2;
/** Cars signal a turn or lane change from this far before it. */
const SIGNAL_AHEAD = 60;
/** On green, turning cars give way to priority traffic this many seconds from the junction. */
const YIELD_HORIZON = 3;

/** Top speed in a car park bay (driving in or backing out). */
const PARK_SPEED = 8;
/** How long a car stays parked at a shop or office, in seconds: somewhere between these. */
const PARK_MIN = 20;
const PARK_MAX = 100;
/** Paint, roughly as common as on real roads: mostly white, black, silver and grey, a few colours. */
const CAR_COLORS = [
  0xf2f2f0, 0xf2f2f0, 0xf2f2f0, 0x1c1d20, 0x1c1d20, 0x1c1d20, 0xb9bdc2, 0xb9bdc2, 0x6c7178, 0x6c7178,
  0x1f3a5f, 0x9b1c1c, 0x2f5d50, 0x8a6f4e, 0xc9a227, 0x3f7fbf,
];
export const CAR_TYPES = ["sedan", "hatch", "suv"] as const;
export type CarType = (typeof CAR_TYPES)[number];

/** How entry to a leg is controlled: a junction's rule, "merge" for a lane change, null at a plain bend where two roads meet. */
type Rule = JunctionControl | "roundabout" | "merge" | null;

interface Movement extends Leg {
  rule: Rule;
  /** Roundabout legs: distance along the leg where the car is on the ring, and where it leaves it; which exit it takes. */
  onRing?: number;
  offRing?: number;
  exit?: number;
}

export interface Car {
  id: number;
  legs: Movement[];
  /** Index of the leg being driven, and distance along it. */
  leg: number;
  s: number;
  v: number;
  color: number;
  type: CarType;
  /** Allowed into the junction at the end of its current road leg. */
  cleared: boolean;
  /** When it reached the front of the queue at an all-way junction (null until then). */
  arrival: number | null;
  /** Seconds standing at the stop line. */
  stopped: number;
  /** The source it set off from, and drives back to after parking. */
  home: NodeId;
  /** The bay it holds at a shop or office (its index in `carPark`'s bays), from setting off until it has backed out. */
  parking: { sink: NodeId; bay: number } | null;
  /** Parked: the simulation time it leaves. */
  leaveAt: number | null;
}

/** Small seeded random generator (mulberry32), so runs can be repeated. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Where cars stop before a junction, when the renderer's painted stop lines aren't available. */
function roughInset(graph: RoadGraph): (segment: RoadSegment, nodeId: NodeId) => number {
  return (_segment, nodeId) => {
    const roads = graph.segmentsAt(nodeId);
    if (roads.length === 1) return 2;
    if (roads.length === 2) return 0;
    if (graph.junction(nodeId).roundabout) return roundaboutShape(roads.map((s) => s.spec)).outer + 2;
    return graph.junctionRadius(nodeId) + 2;
  };
}

/**
 * Traffic simulation, advanced in fixed steps by the engine, independent of frame rate. Sources
 * spawn cars that drive the fastest route to a sink and vanish there. Cars follow the car ahead,
 * and wait at junctions: for signals, in arrival order at all-way stops and give ways, and for a
 * gap in circulating traffic at roundabouts. They never enter a junction whose exit is backed up.
 */
export class Simulation {
  time = 0;
  ticks = 0;
  cars: Car[] = [];
  /** Cars that have reached their sink (parked, unless `parking` is off). */
  delivered = 0;
  /**
   * Cars park in a free bay at their shop or office, stay a while and drive home; a shop with no
   * free bay gets no more until one leaves. Off, they vanish on arriving (traffic tests use this
   * for steady flow through junctions).
   */
  parking = true;

  private tracks: TrackBuilder;
  private routes = new Map<string, Route | null>();
  private due = new Map<NodeId, number>();
  private random: () => number;
  private nextId = 1;
  private unsubscribe: () => void;

  constructor(
    readonly graph: RoadGraph,
    /** Distance from a road's end node to where cars stop (the painted stop line). */
    insetAt: (segment: RoadSegment, nodeId: NodeId) => number = roughInset(graph),
    seed = 1,
  ) {
    this.tracks = new TrackBuilder(graph, insetAt);
    this.random = seeded(seed);
    this.unsubscribe = graph.subscribe((e) => {
      this.routes.clear();
      if (e.type === "terminal-changed") {
        // A shop or office removed or rebuilt: its bays (and cars in or heading for them) go too.
        this.cars = this.cars.filter((c) => c.parking?.sink !== e.nodeId);
        return;
      }
      this.tracks.clear();
      // shortcut: cars driving through a changed part of the network just vanish; reroute them when it matters.
      if (e.type === "reset" || e.type === "settings") this.cars = [];
      else if (e.type === "junction-changed") this.dropCarsAt([e.nodeId]);
      else {
        const { id, a, b } = e.segment;
        this.cars = this.cars.filter((c) => !c.legs.some((l) => l.segment === id));
        this.dropCarsAt([a, b]);
      }
    });
  }

  dispose(): void {
    this.unsubscribe();
  }

  step(dt: number): void {
    this.time += dt;
    this.ticks++;
    this.spawn(dt);
    const arrived = new Set<Car>();
    for (const car of this.cars) if (car.leaveAt !== null && this.time >= car.leaveAt && !this.leave(car)) arrived.add(car);

    const lanes = this.byLane();
    const acceleration = new Map<Car, number>();
    for (const car of this.cars) if (car.leaveAt === null) acceleration.set(car, this.accelerate(car, lanes));

    for (const car of this.cars) {
      if (car.leaveAt !== null) continue;
      car.v = Math.max(0, car.v + acceleration.get(car)! * dt);
      const before = car.s;
      car.s += car.v * dt;
      const next = car.legs[car.leg + 1];
      // Never past a stop line without permission: the front bumper (half a car ahead of `s`) stays behind it.
      if (next?.rule && !car.cleared) car.s = Math.min(car.s, Math.max(before, legLength(car.legs[car.leg]) - CAR_LENGTH / 2));
      while (car.s >= legLength(car.legs[car.leg])) {
        if (car.leg === car.legs.length - 1) {
          if (car.parking && car.legs[car.leg].key.startsWith("bay:")) {
            // In its bay: stays a while.
            car.s = legLength(car.legs[car.leg]);
            car.v = 0;
            car.leaveAt = this.time + PARK_MIN + this.random() * (PARK_MAX - PARK_MIN);
            this.delivered++;
          } else {
            arrived.add(car);
            // At its sink (with parking on, cars only vanish once home again).
            if (!car.parking && !this.parking) this.delivered++;
          }
          break;
        }
        // Backed out of its bay: the bay is free for the next car.
        if (car.legs[car.leg].reverse) car.parking = null;
        car.s -= legLength(car.legs[car.leg]);
        car.leg++;
        car.cleared = false;
        car.arrival = null;
        car.stopped = 0;
      }
      const toLine = legLength(car.legs[car.leg]) - car.s;
      // Standing at the line: the front bumper (half a car ahead) within a few units of it.
      car.stopped = car.v < 0.5 && toLine - CAR_LENGTH / 2 < 6 ? car.stopped + dt : 0;
    }
    if (arrived.size) this.cars = this.cars.filter((c) => !arrived.has(c));
  }

  /**
   * Which indicator a car has on: 1 right, -1 left, 0 none. On for a turn or lane change coming up
   * within `SIGNAL_AHEAD` and while making it. At roundabouts: towards the kerb for the first exit,
   * away from it for the third and later (kept on round the ring), none for the second; then
   * towards the kerb when nearing the exit.
   */
  signal(car: Car): -1 | 0 | 1 {
    const kerb = this.graph.drivingSide === "right" ? 1 : -1;
    const approach = (leg: Movement): -1 | 0 | 1 => {
      if (leg.shift !== undefined) return leg.shift;
      if (!leg.rule) return 0;
      const turn = leg.ring ? (leg.exit === 1 ? "kerb" : leg.exit! >= 3 ? "across" : "straight") : leg.turn;
      return turn === "kerb" ? kerb : turn === "across" ? (-kerb as -1 | 1) : 0;
    };
    const leg = car.legs[car.leg];
    if (leg.shift !== undefined || (leg.node !== undefined && !leg.ring)) return approach(leg);
    if (leg.ring) {
      if (car.s >= leg.offRing! - SIGNAL_AHEAD) return kerb;
      return car.s < leg.onRing! || leg.exit! >= 3 ? approach(leg) : 0;
    }
    const next = car.legs[car.leg + 1];
    return next && legLength(leg) - car.s < SIGNAL_AHEAD ? approach(next) : 0;
  }

  /** Position and heading of a car, for drawing it. */
  pose(car: Car): { x: number; y: number; heading: number } {
    const leg = car.legs[car.leg];
    const f = legAt(leg, car.s);
    return { x: f.p.x, y: f.p.y, heading: Math.atan2(f.tangent.y, f.tangent.x) + (leg.reverse ? Math.PI : 0) };
  }

  private dropCarsAt(nodes: NodeId[]): void {
    this.cars = this.cars.filter((c) => !c.legs.some((l) => l.node !== undefined && nodes.includes(l.node)));
  }

  private route(from: NodeId, to: NodeId): Route | null {
    const key = `${from}>${to}`;
    if (!this.routes.has(key)) this.routes.set(key, findRoute(this.graph, from, to));
    return this.routes.get(key)!;
  }

  /** Each enabled source releases cars at its rate, when its road end is clear. */
  private spawn(dt: number): void {
    const terminals = this.graph.allTerminals();
    const sinks = [...terminals].filter(([, t]) => t.kind === "sink").map(([id]) => id);
    for (const [source, t] of terminals) {
      if (t.kind !== "source" || !t.enabled || t.rate <= 0) continue;
      // A source that can't release a car keeps one waiting, rather than a growing backlog.
      const due = Math.min(1, (this.due.get(source) ?? 0) + (t.rate / 60) * dt);
      this.due.set(source, due);
      if (due < 1) continue;
      // Only to shops and offices with a free bay: when they're all full, the source waits.
      const reachable = (t.sinks.length ? t.sinks : sinks).filter(
        (sink) => sink !== source && (!this.parking || this.freeBay(sink) !== null) && this.route(source, sink),
      );
      if (!reachable.length) continue;
      const sink = reachable[Math.floor(this.random() * reachable.length)];
      const bay = this.parking ? this.freeBay(sink) : null;
      const legs = this.legsFor(this.route(source, sink)!, bay === null ? {} : { parkAt: bay });
      // Not while the last car is still at the door or near the top of the driveway (either way out).
      const blocked = this.cars.some((c) => c.legs[c.leg].key === legs[0].key || this.nearDoor(c, source));
      if (blocked) continue;
      this.due.set(source, 0);
      this.cars.push({
        id: this.nextId++,
        legs,
        leg: 0,
        s: 0,
        // Out of the building's door, from a standstill.
        v: 0,
        color: CAR_COLORS[Math.floor(this.random() * CAR_COLORS.length)],
        type: CAR_TYPES[Math.floor(this.random() * CAR_TYPES.length)],
        cleared: false,
        arrival: null,
        stopped: 0,
        home: source,
        parking: bay === null ? null : { sink, bay },
        leaveAt: null,
      });
    }
  }

  /** A bay at shop or office `sink` no car holds, or null when they're all taken. */
  private freeBay(sink: NodeId): number | null {
    const lot = this.graph.terminalLot(sink);
    if (!lot) return null;
    const taken = new Set(this.cars.filter((c) => c.parking?.sink === sink).map((c) => c.parking!.bay));
    const free = carPark(lot).bays.findIndex((_, i) => !taken.has(i));
    return free < 0 ? null : free;
  }

  /** A parked car sets off home, backing out of its bay. False if it can't get there (it just goes). */
  private leave(car: Car): boolean {
    const { sink, bay } = car.parking!;
    const route = this.graph.terminal(car.home)?.kind === "source" ? this.route(sink, car.home) : null;
    if (!route) return false;
    Object.assign(car, { legs: this.legsFor(route, { leaveFrom: bay }), leg: 0, s: 0, v: 0, leaveAt: null, cleared: false, arrival: null, stopped: 0 });
    return true;
  }

  /** The legs driving `route`: a lane on each road (by the turn at its end), and the junctions between. */
  private legsFor(route: Route, bays: { parkAt?: number; leaveFrom?: number } = {}): Movement[] {
    const { graph } = this;
    const segments = route.segments.map((id) => graph.segments.get(id)!);
    const turns: (Turn | null)[] = segments.map((s, i) =>
      i < segments.length - 1 ? turnAt(graph, route.nodes[i + 1], s, segments[i + 1]) : null,
    );
    // At each plain junction, one of the lane connections for this turn (they fix the lanes either side).
    const via = segments.map((s, i) => {
      if (i === segments.length - 1 || !hasLaneConnector(graph, route.nodes[i + 1])) return null;
      const options = connectionsAt(graph, route.nodes[i + 1]).filter(
        (c) => c.from.segment === s.id && c.to.segment === segments[i + 1].id,
      );
      return options[Math.floor(this.random() * options.length)] ?? null;
    });
    // The lane of road `i` nearest the building of the source it leaves (or sink it arrives at).
    const nearestToBuilding = (i: number, node: NodeId, leaving: boolean): number => {
      const lot = graph.terminalLot(node)!;
      const away = graph.directionAway(segments[i], node);
      const travel = leaving ? away : { x: -away.x, y: -away.y };
      // Right of travel: world y points down the screen.
      const right = lot.out.x * -travel.y + lot.out.y * travel.x > 0 ? 1 : -1;
      const offsets = laneOffsets(segments[i].spec, graph.drivingSide);
      return offsets.indexOf(right > 0 ? Math.max(...offsets) : Math.min(...offsets));
    };
    // The lane each road is left in, for what comes next: before a roundabout, the kerb lane for the
    // first exit, the inner lane for the third and later, either for the second; at the sink, the
    // lane nearest its building; by the turn at a junction; through a joint, the next road's lane position.
    const exitLanes: number[] = [];
    for (let i = segments.length - 1; i >= 0; i--) {
      const order = lanesInnerToKerb(segments[i].spec, graph.drivingSide);
      const joint = i < segments.length - 1 && graph.segmentsAt(route.nodes[i + 1]).length === 2;
      if (joint) {
        const rank = lanesInnerToKerb(segments[i + 1].spec, graph.drivingSide).indexOf(exitLanes[i + 1]);
        exitLanes[i] = order[Math.min(rank, order.length - 1)];
        continue;
      }
      const connection = via[i];
      if (connection) {
        exitLanes[i] = connection.from.lane;
        continue;
      }
      const node = route.nodes[i + 1];
      const exit = i < segments.length - 1 && this.tracks.isRoundabout(node) ? this.tracks.exitNumber(node, segments[i], segments[i + 1]) : 0;
      const turn = exit ? (exit === 1 ? "kerb" : exit >= 3 ? "across" : "straight") : turns[i];
      if (i === segments.length - 1) exitLanes[i] = nearestToBuilding(i, route.nodes[i + 1], false);
      else if (turn === "kerb") exitLanes[i] = order[order.length - 1];
      else if (turn === "across") exitLanes[i] = order[0];
      else exitLanes[i] = order[Math.floor(this.random() * order.length)];
    }
    // The lane each road is entered in: the one nearest the source's building; out of a
    // roundabout, the lane matching the ring lane (inner to inner, outer to outer); through a joint,
    // the lane position it was left in; after a junction, the lane its lane connection leads to.
    // Where entry and exit lanes differ, the car changes lane halfway along the road.
    const entryLanes = segments.map((segment, i) => {
      const order = lanesInnerToKerb(segment.spec, graph.drivingSide);
      const from = route.nodes[i];
      if (i === 0) return nearestToBuilding(0, route.nodes[0], true);
      if (this.tracks.isRoundabout(from)) {
        return this.tracks.exitLane(from, this.tracks.ringLane(from, segments[i - 1], exitLanes[i - 1]), segment);
      }
      if (graph.segmentsAt(from).length === 2) {
        const rank = lanesInnerToKerb(segments[i - 1].spec, graph.drivingSide).indexOf(exitLanes[i - 1]);
        return order[Math.min(rank, order.length - 1)];
      }
      return via[i - 1]?.to.lane ?? exitLanes[i];
    });
    // The first and last roads start and end where the driveways join them.
    const source = route.nodes[0];
    const sink = route.nodes[route.nodes.length - 1];
    const sourceLot = graph.terminalLot(source)!;
    const sinkLot = graph.terminalLot(sink)!;
    const roads = segments.map((s, i) =>
      this.tracks.roadLegs(s, route.nodes[i], entryLanes[i], exitLanes[i], i === 0, {
        start: i === 0 ? sourceLot.at + DRIVEWAY_BLEND : undefined,
        end: i === segments.length - 1 ? sinkLot.at + DRIVEWAY_BLEND : undefined,
      }),
    );
    const legs: Movement[] = [];
    roads.forEach((pieces, i) => {
      for (const piece of pieces) legs.push({ ...piece, rule: piece.joinAt === undefined ? null : "merge" });
      if (i === roads.length - 1) return;
      const node = route.nodes[i + 1];
      const into = pieces[pieces.length - 1];
      const junction = this.tracks.junctionLeg(node, into, roads[i + 1][0], exitLanes[i], entryLanes[i + 1], turns[i]!);
      const settings = graph.junction(node);
      const rule: Rule =
        graph.segmentsAt(node).length < 3 ? null : settings.roundabout ? "roundabout" : effectiveControl(settings);
      const movement: Movement = { ...junction, rule };
      if (junction.ring) {
        movement.exit = this.tracks.exitNumber(node, segments[i], segments[i + 1]);
        // Find where along the leg the car joins and leaves the ring.
        const { centre, radius } = junction.ring;
        const onRing = (s: number) => {
          const p = legAt(junction, s).p;
          return Math.abs(Math.hypot(p.x - centre.x, p.y - centre.y) - radius) < 1.5;
        };
        const length = legLength(junction);
        let s = 0;
        while (s < length && !onRing(s)) s += 1;
        movement.onRing = s;
        let e = length;
        while (e > s && !onRing(e)) e -= 1;
        movement.offRing = e;
      }
      legs.push(movement);
    });
    // Out of the source's building and down its driveway (waiting at the door for a gap), and at
    // the far end off the road down the sink's driveway to its door.
    // From a car park, instead: backing out of the bay, then onto the road; to one, into a bay.
    const last = legs.length - 1;
    let start: Movement[];
    if (bays.leaveFrom === undefined) {
      const [door, driveway] = this.tracks.drivewayOut(source, sourceLot, legs[0]);
      start = [{ ...door, rule: null }, { ...driveway, rule: "merge" }];
    } else {
      const { road, legs: out } = this.tracks.parkOut(source, sourceLot, bays.leaveFrom, legs[0]);
      // The last leg joins the road: it waits for a gap there.
      start = out.map((leg, i) => ({ ...leg, rule: i === out.length - 1 ? "merge" : null }));
      legs[0] = { ...legs[0], ...road };
    }
    let end: Movement[];
    if (bays.parkAt === undefined) end = [{ ...this.tracks.drivewayIn(sink, sinkLot, legs[last]), rule: null }];
    else {
      const { road, legs: into } = this.tracks.parkIn(sink, sinkLot, bays.parkAt, legs[last]);
      legs[last] = { ...legs[last], ...road };
      end = into.map((leg) => ({ ...leg, rule: null }));
    }
    return [...start, ...legs, ...end];
  }

  /**
   * Where a car is along its leg's track. Legs on the same lane share one track but may start at
   * different points (after a lane change), so this, not `s`, orders cars in a lane.
   */
  private at(car: Car): number {
    return car.legs[car.leg].from + car.s;
  }

  /** Cars by the lane (leg key) they're on, nearest the start first. */
  private byLane(): Map<string, Car[]> {
    const lanes = new Map<string, Car[]>();
    for (const car of this.cars) {
      const key = car.legs[car.leg].key;
      const list = lanes.get(key);
      if (list) list.push(car);
      else lanes.set(key, [car]);
    }
    for (const list of lanes.values()) list.sort((a, b) => this.at(a) - this.at(b));
    return lanes;
  }

  /** IDM acceleration towards the car ahead, or a stop line the car may not cross yet. */
  private accelerate(car: Car, lanes: Map<string, Car[]>): number {
    let { gap, speed } = this.leader(car, lanes);

    const leg = car.legs[car.leg];
    const next = car.legs[car.leg + 1];
    const toLine = legLength(leg) - car.s;
    // Signals and lane changes are re-checked until the car is over the line: a light can turn red,
    // or a faster car close in on the gap, while it gets there.
    if (next?.rule === "signals" || next?.rule === "merge") car.cleared = false;
    if (next?.rule && !car.cleared) {
      // First in line: no car ahead on this lane before the line (cars can be on past it, when it's a lane change).
      const lane = lanes.get(leg.key)!;
      const ahead = lane[lane.indexOf(car) + 1];
      const front = !ahead || this.at(ahead) > leg.to;
      if (front && toLine < QUEUE_DISTANCE && car.arrival === null) car.arrival = this.time;
      if (toLine < ASK_DISTANCE + (car.v * car.v) / (2 * BRAKE)) car.cleared = front && this.mayEnter(car, next, toLine);
      // Stop with the front bumper just behind the line.
      const toBumper = toLine - CAR_LENGTH / 2 - 0.5;
      if (!car.cleared && toBumper < gap) {
        gap = toBumper;
        speed = 0;
      }
    }

    if (gap <= 0) return -BRAKE * 4;
    const desired = MIN_GAP + car.v * HEADWAY + (car.v * (car.v - speed)) / (2 * Math.sqrt(ACCEL * BRAKE));
    const limit = leg.key.startsWith("bay:") ? PARK_SPEED : CRUISE_SPEED;
    const a = ACCEL * (1 - (car.v / limit) ** 4 - (Math.max(0, desired) / gap) ** 2);
    return Math.max(a, -BRAKE * 4);
  }

  /** Gap to the car ahead (bumper to bumper) and its speed; Infinity when the road ahead is clear. */
  private leader(car: Car, lanes: Map<string, Car[]>): { gap: number; speed: number } {
    let best = { gap: Infinity, speed: 0 };
    const lane = lanes.get(car.legs[car.leg].key)!;
    const ahead = lane[lane.indexOf(car) + 1];
    if (ahead) best = { gap: this.at(ahead) - this.at(car) - CAR_LENGTH, speed: ahead.v };
    else {
      // Look along the next couple of legs, at the first car past where each starts.
      let distance = legLength(car.legs[car.leg]) - car.s;
      for (let i = car.leg + 1; i < Math.min(car.legs.length, car.leg + 3); i++) {
        const leg = car.legs[i];
        const first = lanes.get(leg.key)?.find((c) => this.at(c) >= leg.from);
        if (first) {
          best = { gap: distance + this.at(first) - leg.from - CAR_LENGTH, speed: first.v };
          break;
        }
        distance += legLength(leg);
      }
    }
    // Changing lane, the car is still partly in the lane it's leaving: keep back from cars ahead there too.
    const changing = car.legs[car.leg];
    if (changing.joinAt !== undefined) {
      const left = car.legs[car.leg - 1];
      const mine = left.to + car.s;
      for (const other of lanes.get(left.key) ?? []) {
        const ahead = this.at(other) - mine;
        if (ahead > 0 && ahead - CAR_LENGTH < best.gap) best = { gap: ahead - CAR_LENGTH, speed: other.v };
      }
    }
    // A car changing lane takes up room in both lanes: cars in the lane it leaves see it where it
    // is, cars in the lane it joins see it where it will join.
    const mine = car.legs[car.leg];
    if (mine.key.startsWith("r:")) {
      for (const other of this.cars) {
        const leg = other.legs[other.leg];
        if (leg.joinAt === undefined || other === car) continue;
        const left = other.legs[other.leg - 1];
        const position =
          left.key === mine.key ? left.to + other.s : leg.outKey === mine.key ? leg.joinAt - (legLength(leg) - other.s) : null;
        if (position === null) continue;
        const ahead = position - this.at(car);
        if (ahead > 0 && ahead - CAR_LENGTH < best.gap) best = { gap: ahead - CAR_LENGTH, speed: other.v };
      }
    }
    // On a roundabout, also follow whoever is ahead round the ring in the same ring lane, whichever
    // way they came in. Leaving, a car crosses any lanes outside it, so it watches every lane.
    const leg = car.legs[car.leg];
    if (leg.ring && car.s >= leg.onRing! && car.s <= leg.offRing!) {
      const mine = this.ringAngle(car);
      const leaving = leg.offRing! - car.s < CAR_LENGTH * 3;
      // shortcut: a car alongside in the outer lane isn't watched while an inner-lane car leaves; add a merge check if they clip.
      for (const other of this.cars) {
        const otherLeg = other.legs[other.leg];
        if (other === car || otherLeg.node !== leg.node || !otherLeg.ring || other.s > otherLeg.offRing!) continue;
        // A car about to join counts as already at its joining point, so ring traffic makes room for it.
        const joining = other.s < otherLeg.onRing!;
        if (joining && otherLeg.onRing! - other.s > CAR_LENGTH * 2) continue;
        if (!leaving && Math.abs(otherLeg.ring.radius - leg.ring.radius) > LANE_WIDTH / 2) continue;
        const angle = joining ? otherLeg.ring.entry : this.ringAngle(other);
        const ahead = this.around(leg, mine, angle) * leg.ring.radius;
        if (ahead > 0.5 && ahead - CAR_LENGTH < best.gap) best = { gap: ahead - CAR_LENGTH, speed: other.v };
      }
    }
    return best;
  }

  private ringAngle(car: Car): number {
    const leg = car.legs[car.leg];
    const p = legAt(leg, car.s).p;
    return Math.atan2(p.y - leg.ring!.centre.y, p.x - leg.ring!.centre.x);
  }

  /** How far round the ring (radians, 0–2π) angle `to` lies ahead of angle `from`. */
  private around(leg: Movement, from: number, to: number): number {
    const tau = Math.PI * 2;
    return (((leg.ring!.direction * (to - from)) % tau) + tau) % tau;
  }

  /** Whether `car`, at its stop line `toLine` away, may drive into junction leg `next`. */
  private mayEnter(car: Car, next: Movement, toLine: number): boolean {
    if (next.rule === "merge") return this.mayChangeLane(car, next);
    if (!this.exitHasRoom(car, next)) return false;
    // Cars already in the junction, or allowed in, on movements crossing or merging with this one.
    const claimed = this.cars.filter((c) => {
      if (c === car) return false;
      const leg = c.legs[c.leg];
      const upcoming = c.legs[c.leg + 1];
      return leg.node === next.node || (c.cleared && upcoming?.node === next.node);
    });
    const legOf = (c: Car) => (c.legs[c.leg].node === next.node ? c.legs[c.leg] : c.legs[c.leg + 1]);

    if (next.rule === "roundabout") return this.ringClear(next, claimed);
    if (claimed.some((c) => this.tracks.conflicts(next, legOf(c)))) return false;

    // Front cars waiting at this junction's other lines, and the leg each would take.
    const waiting = this.cars.filter(
      (c) => c !== car && !c.cleared && c.legs[c.leg + 1]?.node === next.node && c.arrival !== null,
    );

    if (next.rule === "signals") {
      const approaches = signalApproaches(this.graph, next.node!);
      const lights = signalLights(approaches.length, this.time);
      const lightFor = (c: Car) => lights[approaches.indexOf(c.legs[c.leg].segment!)];
      const light = lightFor(car);
      // Not green: stop if there's room to before the front bumper reaches the line (a car let through
      // on yellow keeps going if the light turns red).
      if (light !== "green" && (car.v * car.v) / (2 * BRAKE) < toLine - CAR_LENGTH / 2) return false;
      // Turning cars let conflicting straight-on (then kerb-side) traffic with a green go first.
      const rank = (turn: Turn | undefined) => (turn === "straight" ? 2 : turn === "kerb" ? 1 : 0);
      const approaching = this.cars.filter((c) => {
        const upcoming = c.legs[c.leg + 1];
        if (c === car || upcoming?.node !== next.node || lightFor(c) !== "green") return false;
        const distance = legLength(c.legs[c.leg]) - c.s;
        return distance < c.v * YIELD_HORIZON + 10 && rank(upcoming.turn) > rank(next.turn);
      });
      return !approaching.some((c) => this.tracks.conflicts(next, c.legs[c.leg + 1]));
    }

    // All-way stop, give way or none: first come, first served among conflicting movements.
    if (next.rule === "stop" && car.stopped < STOP_HOLD) return false;
    const mine = car.arrival ?? this.time;
    return !waiting.some(
      (c) =>
        this.tracks.conflicts(next, c.legs[c.leg + 1]) &&
        (c.arrival! < mine || (c.arrival === mine && c.id < car.id)),
    );
  }

  /**
   * A lane change may start when the target lane is clear round where the car joins it: no car
   * there or closing in from behind, and no other car changing into it. Two cars waiting to swap
   * lanes side by side would block each other, so the lower-numbered one goes first.
   */
  private mayChangeLane(car: Car, change: Movement): boolean {
    const join = change.joinAt!;
    // Out of a building: the driveways each way share their first stretch.
    const door = change.key.startsWith("out:") ? Number(change.key.split(":")[1]) : null;
    if (door !== null && this.cars.some((c) => c !== car && this.nearDoor(c, door))) return false;
    const from = car.legs[car.leg].key;
    for (const other of this.cars) {
      if (other === car) continue;
      const leg = other.legs[other.leg];
      if (leg.outKey === change.outKey && leg.joinAt !== undefined) return false;
      let position: number;
      if (leg.key === change.outKey) {
        const waitingToSwap = !other.cleared && other.legs[other.leg + 1]?.outKey === from && other.id > car.id;
        if (waitingToSwap) continue;
        position = this.at(other);
      } else if (leg.node !== undefined && leg.outKey === change.outKey) {
        // Still in the junction behind, about to come out into the target lane: count it from there.
        position = other.legs[other.leg + 1].from - (legLength(leg) - other.s);
      } else continue;
      const behind = join - (other.v * HEADWAY * 1.5 + CAR_LENGTH + MIN_GAP * 2);
      if (position > behind && position < join + CAR_LENGTH + MIN_GAP * 2) return false;
    }
    return true;
  }

  /** Whether a car is on its way out of `source`'s building, still close to the door. */
  private nearDoor(car: Car, source: NodeId): boolean {
    return car.legs[car.leg].key.startsWith(`out:${source}:`) && car.s < CAR_LENGTH + MIN_GAP * 2;
  }

  /** Room for one more car where the movement comes out, counting cars already heading there. */
  private exitHasRoom(car: Car, next: Movement): boolean {
    // Up to the first car in the lane it comes out in, however far along (the leg itself may stop
    // short at a lane change); a car changing out of that lane still takes room in it.
    const out = car.legs[car.legs.indexOf(next) + 1];
    let room = Infinity;
    for (const c of this.cars) {
      const leg = c.legs[c.leg];
      const left = leg.joinAt !== undefined ? c.legs[c.leg - 1] : null;
      const position = leg.key === out.key ? this.at(c) : left?.key === out.key ? left.to + c.s : null;
      if (position !== null) room = Math.min(room, position - out.from - CAR_LENGTH);
    }
    for (const c of this.cars) {
      if (c === car) continue;
      const leg = c.legs[c.leg];
      const upcoming = c.legs[c.leg + 1];
      // Through the junction (lane changes further along the road don't count).
      const heading = (leg.node !== undefined && leg.outKey === out.key) || (c.cleared && upcoming?.node !== undefined && upcoming.outKey === out.key);
      if (heading) room -= CAR_LENGTH + MIN_GAP;
    }
    return room >= CAR_LENGTH + MIN_GAP;
  }

  /**
   * Roundabouts: circulating cars have priority. Enter only when no car on (or about to join) the
   * ring will pass this entry within `RING_GAP` seconds, and the spot just past it is free.
   */
  private ringClear(next: Movement, claimed: Car[]): boolean {
    const ring = next.ring!;
    const entry = ring.entry;
    for (const other of claimed) {
      const leg = other.legs[other.leg];
      let angle: number;
      let lead = 0;
      if (leg.node === next.node && leg.ring) {
        if (other.s > leg.offRing!) continue;
        if (other.s < leg.onRing!) {
          // Still joining: treat it as at its own entry, that far away.
          angle = leg.ring.entry;
          lead = leg.onRing! - other.s;
        } else angle = this.ringAngle(other);
      } else {
        // Allowed in from another approach but not in yet.
        const upcoming = other.legs[other.leg + 1];
        angle = upcoming.ring!.entry;
        lead = legLength(leg) - other.s + upcoming.onRing!;
      }
      const otherLeg = leg.ring ? leg : other.legs[other.leg + 1];
      // Side by side from the same approach into different ring lanes: their paths don't meet.
      const sameApproach = otherLeg.key.split(":")[2] === next.key.split(":")[2];
      const nearEntry = lead > 0 || this.around(next, entry, angle) * ring.radius < CAR_LENGTH * 2;
      if (sameApproach && otherLeg.ring!.radius !== ring.radius && nearEntry) continue;
      const exit = otherLeg.ring!.exit;
      const upstream = this.around(next, angle, entry) * ring.radius + lead;
      const passes = this.around(next, angle, exit) > this.around(next, angle, entry) - 0.05;
      if (passes && upstream < other.v * RING_GAP + CAR_LENGTH + MIN_GAP * 2) return false;
      const downstream = this.around(next, entry, angle) * ring.radius;
      if (lead === 0 && downstream < CAR_LENGTH + MIN_GAP * 2) return false;
    }
    return true;
  }
}
