import { effectiveControl, minorRoads, roundaboutShape, slipControlAt, slipRoad, signalApproaches, signalLights, type JunctionControl } from "./junction";
import type { NodeId, RoadGraph, RoadSegment, SegmentId } from "./roadGraph";
import { CRUISE_SPEED, findRoute, type Route } from "./routing";
import { LANE_WIDTH } from "./roadSpec";
import { connectionsAt, hasLaneConnector, laneOffsets, lanesInnerToKerb, turnAt, type Turn } from "./lanes";
import { carPark, DRIVEWAY_BLEND, headsTo, type Terminal } from "./terminal";
import { TURN_ORDER } from "./rules";
import { legAt, legLength, TrackBuilder, type Leg } from "./track";

/** Fixed simulation timestep in seconds, so traffic logic never sees a variable dt. */
export const SIM_DT = 1 / 60;

export const CAR_LENGTH = 14;
export const CAR_WIDTH = 6.5;
/** Clearance kept round cars when checking for room (car following itself uses the rules' standstill gap). */
const MIN_GAP = 3;
/** A car asks to enter a junction this far (plus its braking distance) before the stop line. */
const ASK_DISTANCE = 15;
/** Front cars this close to the line queue for an all-way junction, first come first served. */
const QUEUE_DISTANCE = 40;

/** Top speed in a car park bay (driving in or backing out). */
const PARK_SPEED = 8;
/** Paint, roughly as common as on real roads: mostly white, black, silver and grey, a few colours. */
const CAR_COLORS = [
  0xf2f2f0, 0xf2f2f0, 0xf2f2f0, 0x1c1d20, 0x1c1d20, 0x1c1d20, 0xb9bdc2, 0xb9bdc2, 0x6c7178, 0x6c7178,
  0x1f3a5f, 0x9b1c1c, 0x2f5d50, 0x8a6f4e, 0xc9a227, 0x3f7fbf,
];
export const CAR_TYPES = ["sedan", "hatch", "suv"] as const;
export type CarType = (typeof CAR_TYPES)[number];

/** How entry to a leg is controlled: a junction's rule, "merge" for a lane change, null at a plain bend where two roads meet. */
type Rule = JunctionControl | "roundabout" | "merge" | "priority" | "turnIn" | null;

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
  /** Acceleration in the last step (negative while braking). */
  accel: number;
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
  /** The trip being driven: from and to which buildings, and the parking bay at either end (to plan it again, see `replan`). */
  trip: Trip;
  /** The bay it holds at a shop or office (its index in `carPark`'s bays), from setting off until it has backed out. */
  parking: { sink: NodeId; bay: number } | null;
  /** Parked: the simulation time it leaves. */
  leaveAt: number | null;
}

/** A shop's or office's footprint: what its bays depend on. Null for a home or no building. */
function lotKey(t: Terminal | undefined): string | null {
  return t?.kind === "sink" ? `${t.building}:${t.side ?? ""}:${t.offset ?? ""}:${t.wide ?? 0}` : null;
}

interface Trip {
  from: NodeId;
  to: NodeId;
  bays: { parkAt?: number; leaveFrom?: number };
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
  /** Buildings that have served enough to level up (see `levelUp`), for the engine to grow. */
  levelUps: NodeId[] = [];
  /** Cars that have reached their sink (parked, unless `parking` is off). */
  delivered = 0;
  /**
   * Cars park in a free bay at their shop or office, stay a while and drive home; a shop with no
   * free bay gets no more until one leaves. Off, they vanish on arriving (traffic tests use this
   * for steady flow through junctions).
   */
  parking = true;

  private tracks: TrackBuilder;
  /** Each shop's and office's footprint when its bays were last handed out (see `lotKey`). */
  private lotKeys = new Map<NodeId, string>();
  /** Each junction's shape when cars' paths through it were made (see `junctionChanged`). */
  private junctionShapes = new Map<NodeId, string>();
  /** Bays held at each shop or office, counted once a step (see `spawn`). */
  private held = new Map<NodeId, Set<number>>();
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
      // New rules: cars carry on, reading them from the next step.
      if (e.type === "rules") return;
      if (e.type === "terminal-changed") {
        // A shop or office removed, or moved or resized: its bays (and cars in or heading for
        // them) go too. Renamed, recoloured or grown taller, they stay.
        const before = this.lotKeys.get(e.nodeId);
        const after = lotKey(graph.terminal(e.nodeId));
        if (before !== undefined && before !== after) this.cars = this.cars.filter((c) => c.parking?.sink !== e.nodeId);
        if (after === null) this.lotKeys.delete(e.nodeId);
        else this.lotKeys.set(e.nodeId, after);
        return;
      }
      if (e.type === "reset") {
        this.lotKeys.clear();
        this.junctionShapes.clear();
      }
      this.tracks.clear();
      // shortcut: cars driving through a changed part of the network just vanish; reroute them when it matters.
      if (e.type === "reset" || e.type === "settings") this.cars = [];
      else if (e.type === "junction-changed") this.junctionChanged(e.nodeId);
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
      car.accel = car.v > 0 || acceleration.get(car)! > 0 ? acceleration.get(car)! : 0;
      car.v = Math.max(0, car.v + acceleration.get(car)! * dt);
      const before = car.s;
      car.s += car.v * dt;
      const next = car.legs[car.leg + 1];
      // Never past a stop line without permission: the front bumper (half a car ahead of `s`) stays behind it.
      if (next?.rule && !car.cleared) car.s = Math.min(car.s, Math.max(before, legLength(car.legs[car.leg]) - CAR_LENGTH / 2));
      while (car.s >= legLength(car.legs[car.leg])) {
        if (car.leg === car.legs.length - 1) {
          if (car.parking) {
            // In its bay: stays a while.
            car.s = legLength(car.legs[car.leg]);
            car.v = 0;
            const { parkMin, parkMax } = this.graph.rules.trips;
            car.leaveAt = this.time + parkMin + this.random() * (parkMax - parkMin);
            this.delivered++;
            if (this.graph.recordVisit(car.parking.sink)) this.levelUps.push(car.parking.sink);
          } else {
            arrived.add(car);
            // Home again: one more trip for its home.
            const end = car.legs[car.leg];
            if (this.parking && end.key === `in:${car.home}` && this.graph.recordVisit(car.home)) this.levelUps.push(car.home);
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
   * within the rules' `signalAhead` and while making it. At roundabouts: towards the kerb for the first exit,
   * away from it for the third and later (kept on round the ring), none for the second; then
   * towards the kerb when nearing the exit.
   */
  signal(car: Car): -1 | 0 | 1 {
    const kerb = this.graph.drivingSide === "right" ? 1 : -1;
    const approach = (leg: Movement): -1 | 0 | 1 => {
      if (leg.shift !== undefined) return leg.shift;
      // Plain bends need no indicator; onto or off a slip road they do, though nothing there gives way.
      if (!leg.rule && !(leg.node !== undefined && slipRoad(this.graph, leg.node))) return 0;
      const turn = leg.ring ? (leg.exit === 1 ? "kerb" : leg.exit! >= 3 ? "across" : "straight") : leg.turn;
      return turn === "kerb" ? kerb : turn === "across" ? (-kerb as -1 | 1) : 0;
    };
    const leg = car.legs[car.leg];
    if (leg.shift !== undefined || (leg.node !== undefined && !leg.ring)) return approach(leg);
    if (leg.ring) {
      if (car.s >= leg.offRing! - this.graph.rules.trips.signalAhead) return kerb;
      return car.s < leg.onRing! || leg.exit! >= 3 ? approach(leg) : 0;
    }
    const next = car.legs[car.leg + 1];
    return next && legLength(leg) - car.s < this.graph.rules.trips.signalAhead ? approach(next) : 0;
  }

  /** How high a car is: up on a bridge, down in a tunnel, else 0. */
  heightOf(car: Car): number {
    const id = car.legs[car.leg].segment;
    const segment = id === undefined ? undefined : this.graph.segments.get(id);
    if (!segment?.spec.level) return 0;
    const { x, y } = this.pose(car);
    return this.graph.heightAt(segment, this.graph.path(segment).nearest({ x, y }).s);
  }

  /** Points `step` apart along the rest of a car's trip, from where it is to where it ends, with the road's height at each (for drawing its route). */
  routeAhead(car: Car, step: number): { x: number; y: number; h: number }[] {
    const points: { x: number; y: number; h: number }[] = [];
    for (let i = car.leg; i < car.legs.length; i++) {
      const leg = car.legs[i];
      const length = legLength(leg);
      const segment = leg.segment === undefined ? undefined : this.graph.segments.get(leg.segment);
      const path = segment?.spec.level ? this.graph.path(segment) : null;
      for (let s = i === car.leg ? Math.min(car.s, length) : 0; ; s = Math.min(s + step, length)) {
        const { p } = legAt(leg, s);
        points.push({ x: p.x, y: p.y, h: path ? this.graph.heightAt(segment!, path.nearest(p).s) : 0 });
        if (s >= length) break;
      }
    }
    return points;
  }

  /** Position and heading of a car, for drawing it. */
  pose(car: Car): { x: number; y: number; heading: number } {
    const leg = car.legs[car.leg];
    const f = legAt(leg, car.s);
    return { x: f.p.x, y: f.p.y, heading: Math.atan2(f.tangent.y, f.tangent.x) + (leg.reverse ? Math.PI : 0) };
  }

  /** How traffic arriving at junction `node` on road `into` is controlled. */
  private ruleAt(node: NodeId, into: SegmentId): Rule {
    const { graph } = this;
    const settings = graph.junction(node);
    // A slip road gives way to the main road where it joins; under stop or give way, the main
    // road's traffic has priority and the others stop or give way to it.
    const slip = slipRoad(graph, node);
    const control = slip ? (slip.merge ? slipControlAt(graph, node) : "yield") : effectiveControl(settings);
    // At a slip road, only traffic joining from it gives way (or stops), unless it's under signals:
    // nothing else crosses there, so nothing else waits.
    const free = slip !== null && control !== "signals" && into !== slip.slip;
    const minor = control === "stop" || control === "yield" ? minorRoads(graph, node) : null;
    if (graph.segmentsAt(node).length < 3 || free) return null;
    if (settings.roundabout) return "roundabout";
    return minor && !minor.has(into) ? "priority" : control;
  }

  /**
   * Junction `node`'s settings changed. Only its control (stop, give way, signals, which roads have
   * them): cars keep their routes and take up the new rules. Its shape (a roundabout, its corners,
   * its lane connections): cars through it go (their paths no longer fit).
   */
  private junctionChanged(node: NodeId): void {
    const shape = this.shapeOf(node);
    const before = this.junctionShapes.get(node);
    this.junctionShapes.set(node, shape);
    if (before !== undefined && before !== shape) {
      // Its shape changed: plan the trips through it again on the new one.
      this.cars = this.cars.filter((c) => !c.legs.some((l) => l.node === node) || this.replan(c, node));
      return;
    }
    for (const car of this.cars) {
      car.legs.forEach((leg, i) => {
        if (leg.node !== node || i === 0) return;
        leg.rule = this.ruleAt(node, car.legs[i - 1].segment!);
        // Not past it yet: asks again under the new rule.
        if (i > car.leg) {
          car.cleared = false;
          car.arrival = null;
        }
      });
    }
  }

  /**
   * Plans `car`'s trip again after junction `node` changed shape, carrying on from where it is:
   * on its new path at the same spot if it hasn't reached the junction, or (part way through it)
   * finishing its old curve and joining its new path beyond. False if it can't be placed on its
   * new path (its lane or road isn't on it any more).
   */
  private replan(car: Car, node: NodeId): boolean {
    if (car.leaveAt !== null) return true;
    const route = this.route(car.trip.from, car.trip.to);
    if (!route) return false;
    const fresh = this.legsFor(route, car.trip.bays);
    const current = car.legs[car.leg];
    if (current.node === node) {
      const next = car.legs[car.leg + 1];
      const k = next ? fresh.findIndex((l) => l.key === next.key) : -1;
      if (k < 0) return false;
      car.legs = [current, ...fresh.slice(k)];
      car.leg = 0;
      return true;
    }
    const j = fresh.findIndex((l) => l.key === current.key);
    if (j < 0) return false;
    const along = current.from + car.s;
    car.legs = fresh;
    car.leg = j;
    car.s = Math.max(0, Math.min(legLength(fresh[j]), along - fresh[j].from));
    return true;
  }

  /** What cars' paths through junction `node` depend on (see `junctionChanged`). */
  private shapeOf(node: NodeId): string {
    const s = this.graph.junction(node);
    return `${s.roundabout}:${s.cornerRadius}:${JSON.stringify(s.connections ?? null)}`;
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
    // Bays held at each shop or office, counted once for all the homes trying to send cars.
    this.held.clear();
    for (const c of this.cars) {
      if (!c.parking) continue;
      if (!this.held.has(c.parking.sink)) this.held.set(c.parking.sink, new Set());
      this.held.get(c.parking.sink)!.add(c.parking.bay);
    }
    const terminals = this.graph.allTerminals();
    const sinks = [...terminals].filter(([, t]) => t.kind === "sink");
    for (const [source, t] of terminals) {
      if (t.kind !== "source" || !t.enabled || t.rate <= 0) continue;
      // A source that can't release a car keeps one waiting, rather than a growing backlog.
      // A home seen for the first time (a new one, or every one when a map loads) starts part way
      // through its wait, so homes don't all send their first car at once.
      const due = Math.min(1, (this.due.get(source) ?? this.random()) + (t.rate / 60) * dt);
      this.due.set(source, due);
      if (due < 1) continue;
      // Only to shops and offices with a free bay: when they're all full, the source waits.
      const reachable = sinks.filter(([id, s]) => headsTo(t, id, s.building)).map(([id]) => id).filter(
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
        accel: 0,
        color: CAR_COLORS[Math.floor(this.random() * CAR_COLORS.length)],
        type: CAR_TYPES[Math.floor(this.random() * CAR_TYPES.length)],
        cleared: false,
        arrival: null,
        stopped: 0,
        home: source,
        trip: { from: source, to: sink, bays: bay === null ? {} : { parkAt: bay } },
        parking: bay === null ? null : { sink, bay },
        leaveAt: null,
      });
      if (bay !== null) {
        if (!this.held.has(sink)) this.held.set(sink, new Set());
        this.held.get(sink)!.add(bay);
        if (!this.lotKeys.has(sink)) this.lotKeys.set(sink, lotKey(this.graph.terminal(sink))!);
      }
    }
  }

  /** A bay at shop or office `sink` no car holds, or null when they're all taken. */
  private freeBay(sink: NodeId): number | null {
    const lot = this.graph.terminalLot(sink);
    if (!lot) return null;
    const taken = this.held.get(sink);
    const free = carPark(lot).bays.findIndex((_, i) => !taken?.has(i));
    return free < 0 ? null : free;
  }

  /** A parked car sets off home, backing out of its bay. False if it can't get there (it just goes). */
  private leave(car: Car): boolean {
    const { sink, bay } = car.parking!;
    const route = this.graph.terminal(car.home)?.kind === "source" ? this.route(sink, car.home) : null;
    if (!route) return false;
    const legs = this.legsFor(route, { leaveFrom: bay });
    // Out of an underground or rear car park, one at a time: through the entrance, or out of a bay and up the side driveway.
    const leaving = (key: string, reverse?: boolean) =>
      key === `exit:${sink}` || key === `path:${sink}` || (key.startsWith(`bay:${sink}:`) && !reverse);
    if (leaving(legs[0].key) && this.cars.some((c) => c !== car && c.leaveAt === null && leaving(c.legs[c.leg].key, c.legs[c.leg].reverse))) {
      car.leaveAt = this.time + 1;
      return true;
    }
    Object.assign(car, {
      legs,
      leg: 0,
      s: 0,
      v: 0,
      leaveAt: null,
      cleared: false,
      arrival: null,
      stopped: 0,
      trip: { from: sink, to: car.home, bays: { leaveFrom: bay } },
    });
    // Out of an underground car park (no backing out of a bay): its space is free once it sets off.
    if (!legs.some((l) => l.reverse)) car.parking = null;
    return true;
  }

  /** The legs driving `route`: a lane on each road (by the turn at its end), and the junctions between. */
  private legsFor(route: Route, bays: { parkAt?: number; leaveFrom?: number } = {}): Movement[] {
    const { graph } = this;
    const segments = route.segments.map((id) => graph.segments.get(id)!);
    const turns: (Turn | null)[] = segments.map((s, i) => {
      if (i === segments.length - 1) return null;
      // Onto a slip road: from the kerb lane, indicating towards it; off one, indicating towards the main road.
      const slip = slipRoad(graph, route.nodes[i + 1]);
      if (slip) return segments[i + 1].id === slip.slip ? "kerb" : s.id === slip.slip ? "across" : "straight";
      return turnAt(graph, route.nodes[i + 1], s, segments[i + 1]);
    });
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
      const movement: Movement = { ...junction, rule: this.ruleAt(node, segments[i].id) };
      if (!this.junctionShapes.has(node)) this.junctionShapes.set(node, this.shapeOf(node));
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
    // Off the road into a driveway (or a car park's): wait in the lane until it can turn in, see `mayTurnIn`.
    if (bays.parkAt === undefined) end = [{ ...this.tracks.drivewayIn(sink, sinkLot, legs[last]), rule: "turnIn" }];
    else {
      const { road, legs: into } = this.tracks.parkIn(sink, sinkLot, bays.parkAt, legs[last]);
      legs[last] = { ...legs[last], ...road };
      end = into.map((leg, i) => ({ ...leg, rule: i === 0 ? "turnIn" : null }));
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
      // Parked underground: out of everyone's way.
      if (car.leaveAt !== null && car.legs[car.leg].underground) continue;
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
    const { accel, brake, minGap, headway } = this.graph.rules.following;

    const leg = car.legs[car.leg];
    const next = car.legs[car.leg + 1];
    const toLine = legLength(leg) - car.s;
    // Signals and lane changes are re-checked until the car is over the line: a light can turn red,
    // or a faster car close in on the gap, while it gets there.
    if (next?.rule === "signals" || next?.rule === "merge" || next?.rule === "turnIn") car.cleared = false;
    if (next?.rule && !car.cleared) {
      // First in line: no car ahead on this lane before the line (cars can be on past it, when it's a lane change).
      const lane = lanes.get(leg.key)!;
      const ahead = lane[lane.indexOf(car) + 1];
      const front = !ahead || this.at(ahead) > leg.to;
      if (front && toLine < QUEUE_DISTANCE && car.arrival === null) car.arrival = this.time;
      // A turn into a driveway, or the main road at a junction, is checked from further back, so a car with a clear way doesn't slow for nothing.
      const ask = ASK_DISTANCE + (car.v * car.v) / (2 * brake) + (next.rule === "turnIn" || next.rule === "priority" ? QUEUE_DISTANCE : 0);
      if (toLine < ask) car.cleared = front && this.mayEnter(car, next, toLine);
      // Stop with the front bumper just behind the line.
      const toBumper = toLine - CAR_LENGTH / 2 - 0.5;
      if (!car.cleared && toBumper < gap) {
        gap = toBumper;
        speed = 0;
      }
    }

    if (gap <= 0) return -brake * 4;
    const desired = minGap + car.v * headway + (car.v * (car.v - speed)) / (2 * Math.sqrt(accel * brake));
    const limit = leg.key.startsWith("bay:") ? PARK_SPEED : CRUISE_SPEED;
    const a = accel * (1 - (car.v / limit) ** 4 - (Math.max(0, desired) / gap) ** 2);
    return Math.max(a, -brake * 4);
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
    if (next.rule === "turnIn") return this.mayTurnIn(car, next);
    const { junctions, following } = this.graph.rules;
    if (junctions.gridlockCheck && !this.exitHasRoom(car, next)) return false;
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
    // Higher for the turns that go first (see `TrafficRules.junctions.turnOrder`).
    const rank = (turn: Turn | undefined) => (turn ? TURN_ORDER.length - junctions.turnOrder.indexOf(turn) : 0);
    const near = (c: Car) => legLength(c.legs[c.leg]) - c.s < c.v * junctions.yieldHorizon + 10;

    if (next.rule === "signals") {
      const approaches = signalApproaches(this.graph, next.node!);
      const lights = signalLights(approaches.length, this.time, this.graph.rules.signals);
      const lightFor = (c: Car) => lights[approaches.indexOf(c.legs[c.leg].segment!)];
      const light = lightFor(car);
      // Red (or amber, unless amber counts as go): stop if there's room to before the front bumper
      // reaches the line (a car let through on amber keeps going if the light turns red).
      const stop = light === "red" || (light === "yellow" && junctions.amberStopIfSafe);
      if (stop && (car.v * car.v) / (2 * following.brake) < toLine - CAR_LENGTH / 2) return false;
      // Turning cars let conflicting movements that go first, with a green, go first.
      return !this.cars.some((c) => {
        const upcoming = c.legs[c.leg + 1];
        if (c === car || upcoming?.node !== next.node || lightFor(c) !== "green") return false;
        return near(c) && rank(upcoming.turn) > rank(next.turn) && this.tracks.conflicts(next, upcoming);
      });
    }

    if (next.rule !== "none") {
      // Stop or give way, and the main road: whoever stands higher (see `TrafficRules.junctions.rightOfWay`)
      // goes first; between two main-road turns, the turn order decides.
      const standing = (leg: Movement) =>
        junctions.rightOfWay.indexOf(leg.rule === "priority" ? (leg.turn === "straight" ? "mainThrough" : "mainTurning") : "minor");
      const mine = standing(next);
      const first = (leg: Movement) => {
        const theirs = standing(leg);
        return theirs < mine || (theirs === mine && leg.rule === "priority" && leg.turn !== "straight" && rank(leg.turn) > rank(next.turn));
      };
      if (next.rule === "stop" && car.stopped < junctions.stopHold) return false;
      const yields = this.cars.some((c) => {
        const upcoming = c.legs[c.leg + 1];
        if (c === car || upcoming?.node !== next.node || !(upcoming.rule === "priority" || upcoming.rule === "stop" || upcoming.rule === "yield")) return false;
        return near(c) && first(upcoming) && this.tracks.conflicts(next, upcoming);
      });
      if (yields) return false;
      if (next.rule === "priority") return true;
    }
    // Then first come, first served among the side roads' conflicting movements (and all-way with no control).
    const mine = car.arrival ?? this.time;
    return !waiting.filter((c) => c.legs[c.leg + 1].rule !== "priority").some(
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
    const { giveWayTime } = this.graph.rules.junctions;
    const { headway } = this.graph.rules.following;
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
      } else if (door !== null) {
        // Seen from a driveway: a car further back along the road, a leg or two before the lane joined.
        let ahead = legLength(leg) - other.s;
        let i = other.leg + 1;
        while (i < other.legs.length && i <= other.leg + 3 && other.legs[i].key !== change.outKey) ahead += legLength(other.legs[i++]);
        if (other.legs[i]?.key !== change.outKey) continue;
        position = other.legs[i].from - ahead;
      } else continue;
      // Out of a driveway, give way: road traffic keeps going, so wait for a gap it won't have to slow for.
      const gap = door !== null ? other.v * giveWayTime + CAR_LENGTH : other.v * headway * 1.5 + CAR_LENGTH;
      const behind = join - (gap + MIN_GAP * 2);
      if (position > behind && position < join + CAR_LENGTH + MIN_GAP * 2) return false;
    }
    return true;
  }

  /**
   * Turning off the road into a driveway: only with room to get off the road (nobody on the turn,
   * and the car ahead on the drive or car park lane beyond it clear of its start), and, across the
   * other lane, with no oncoming car about to get there. Otherwise it waits in its lane, not halfway across.
   */
  private mayTurnIn(car: Car, turn: Movement): boolean {
    const after = car.legs[car.legs.indexOf(turn) + 1];
    for (const c of this.cars) {
      if (c === car) continue;
      const leg = c.legs[c.leg];
      // Parked underground: out of the way.
      if (c.leaveAt !== null && leg.underground) continue;
      // The start of the turn clear (cars on it follow each other).
      if (leg.key === turn.key && c.s < CAR_LENGTH + MIN_GAP * 2) return false;
      if (after && leg.key === after.key && this.at(c) - after.from < CAR_LENGTH + MIN_GAP * 2) return false;
    }
    // Turning towards the kerb crosses nobody; across the road, give way to oncoming traffic.
    const kerb = this.graph.drivingSide === "right" ? 1 : -1;
    if (turn.shift === kerb) return true;
    const me = this.pose(car);
    const target = legAt(turn, legLength(turn)).p;
    const heading = { x: Math.cos(me.heading), y: Math.sin(me.heading) };
    return !this.cars.some((c) => {
      if (c === car || !c.legs[c.leg].key.startsWith("r:")) return false;
      const p = this.pose(c);
      const h = { x: Math.cos(p.heading), y: Math.sin(p.heading) };
      if (h.x * heading.x + h.y * heading.y > -0.5) return false;
      const to = { x: target.x - p.x, y: target.y - p.y };
      const ahead = to.x * h.x + to.y * h.y;
      // A car standing still (waiting at a line itself) only counts when it's right there.
      const reach = c.v < 1 ? CAR_LENGTH : c.v * this.graph.rules.junctions.turnInGap + CAR_LENGTH * 1.5;
      return ahead > -CAR_LENGTH && ahead < reach;
    });
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
   * ring will pass this entry within the rules' `ringGap` seconds, and the spot just past it is free.
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
      if (passes && upstream < other.v * this.graph.rules.junctions.ringGap + CAR_LENGTH + MIN_GAP * 2) return false;
      const downstream = this.around(next, entry, angle) * ring.radius;
      if (lead === 0 && downstream < CAR_LENGTH + MIN_GAP * 2) return false;
    }
    return true;
  }
}
