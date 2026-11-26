import { describe, expect, it } from "vitest";
import { straightCurve } from "./curve";
import { kerbRadius, minorRoads, roundaboutShape, signalApproaches, signalLights, slipRoad } from "./junction";

/** Longer than a stop sign's hold: a car standing at the line this long has stopped there. */
const STOP_HOLD_TEST = 1;
import { RoadGraph, type NodeId } from "./roadGraph";
import { findRoute } from "./routing";
import { DEFAULT_ROAD_SPEC, LANE_WIDTH, normalizeRoadSpec, parseRoadSpec, type RoadSpec } from "./roadSpec";
import { CAR_LENGTH, CAR_WIDTH, SIM_DT, Simulation, type Car } from "./simulation";
import { buildingSize, DEFAULT_SOURCE, carPark, newTerminal, parseTerminal, SINK } from "./terminal";
import { defaultConnections, lanesInnerToKerb } from "./lanes";
import { planLanes, type LaneFacts } from "./lanePlan";
import { legLength, TrackBuilder } from "./track";

const road = (graph: RoadGraph, ax: number, ay: number, bx: number, by: number, spec: RoadSpec = DEFAULT_ROAD_SPEC) =>
  graph.buildRoad(straightCurve({ x: ax, y: ay }, { x: bx, y: by }), spec);
const at = (graph: RoadGraph, x: number, y: number): NodeId => graph.nodeNear({ x, y }, 1)!.id;

/** Four 300-long arms meeting at (0, 0): sources at west and north, sinks at east and south. */
function crossroads(settings: Parameters<RoadGraph["setJunction"]>[1]): { graph: RoadGraph; centre: NodeId } {
  const graph = new RoadGraph();
  road(graph, -300, 0, 300, 0);
  road(graph, 0, -300, 0, 300);
  const centre = at(graph, 0, 0);
  graph.setJunction(centre, settings);
  graph.setTerminal(at(graph, -300, 0), { ...DEFAULT_SOURCE, rate: 40 });
  graph.setTerminal(at(graph, 0, -300), { ...DEFAULT_SOURCE, rate: 40 });
  graph.setTerminal(at(graph, 300, 0), SINK);
  graph.setTerminal(at(graph, 0, 300), SINK);
  return { graph, centre };
}

function run(sim: Simulation, seconds: number, check?: () => void): void {
  for (let i = 0; i < seconds / SIM_DT; i++) {
    sim.step(SIM_DT);
    check?.();
  }
}

/** Fails when two cars are closer than `min` (checked without `expect` first: it runs for every pair, every step). */
function apart(distance: number, min: number): void {
  if (distance <= min) expect(distance).toBeGreaterThan(min);
}

/** Cars on the same lane never overlap. */
function noOverlap(sim: Simulation): void {
  const lanes = new Map<string, Car[]>();
  for (const car of sim.cars) {
    // Parked underground: out of sight, all at the entrance.
    if (car.leaveAt !== null && car.legs[car.leg].underground) continue;
    const key = car.legs[car.leg].key;
    lanes.set(key, [...(lanes.get(key) ?? []), car]);
  }
  // Legs on one lane share a track but can start at different points (after a lane change).
  const at = (car: Car) => car.legs[car.leg].from + car.s;
  for (const cars of lanes.values()) {
    cars.sort((a, b) => at(a) - at(b));
    for (let i = 1; i < cars.length; i++) apart(at(cars[i]) - at(cars[i - 1]), CAR_LENGTH - 0.5);
  }
}

describe("findRoute", () => {
  it("takes the shorter way and respects one-way roads", () => {
    const graph = new RoadGraph();
    // A square loop: from the top-left corner, the bottom-right corner is equally far either way.
    road(graph, 0, 0, 200, 0);
    road(graph, 200, 0, 200, 200);
    road(graph, 0, 0, 0, 200, { ...DEFAULT_ROAD_SPEC, oneWay: true });
    road(graph, 0, 200, 200, 200);
    const from = at(graph, 0, 0);
    const to = at(graph, 200, 200);
    expect(findRoute(graph, from, to)!.segments).toHaveLength(2);
    // Against the one-way road, the only way back round is the other side.
    const back = findRoute(graph, at(graph, 0, 200), from)!;
    expect(back.nodes).toEqual([at(graph, 0, 200), to, at(graph, 200, 0), from]);
  });

  /**
   * From the west, two ways north-east: straight on, then straight through junction K (A); or a
   * little shorter, turning across traffic at J and again at K (B). `fast` sets route A's speed.
   */
  function twoWays(fast?: number) {
    const graph = new RoadGraph();
    const a = { ...DEFAULT_ROAD_SPEC, speed: fast };
    road(graph, -300, 0, 0, 0);
    road(graph, 0, 0, 300, 0, a);
    road(graph, 300, 0, 300, -300, a);
    road(graph, 0, 0, 0, -250);
    road(graph, 0, -250, 300, -300);
    road(graph, 300, -300, 300, -400);
    return { graph, from: at(graph, -300, 0), to: at(graph, 300, -400), viaA: at(graph, 300, 0) };
  }
  const noTurnCosts = (graph: RoadGraph) => graph.setRules({ ...graph.rules, routing: { ...graph.rules.routing, turnKerb: 0, turnAcross: 0 } });

  it("charges for turns, so it goes straight on rather than turn across traffic twice to save a little", () => {
    const { graph, from, to, viaA } = twoWays();
    expect(findRoute(graph, from, to)!.nodes).toContain(viaA);
    noTurnCosts(graph);
    expect(findRoute(graph, from, to)!.nodes).not.toContain(viaA);
  });

  it("prefers faster roads, by their speed limits", () => {
    const { graph, from, to, viaA } = twoWays(90);
    noTurnCosts(graph);
    expect(findRoute(graph, from, to)!.nodes).toContain(viaA);
    graph.setRules({ ...graph.rules, routing: { ...graph.rules.routing, speedLimits: false } });
    expect(findRoute(graph, from, to)!.nodes).not.toContain(viaA);
  });

  it("returns null when the sink can't be reached", () => {
    const graph = new RoadGraph();
    road(graph, 0, 0, 100, 0, { ...DEFAULT_ROAD_SPEC, oneWay: true });
    expect(findRoute(graph, at(graph, 100, 0), at(graph, 0, 0))).toBeNull();
  });
});

describe("Simulation", () => {
  it("drives cars from a source to a sink, where they vanish", () => {
    const graph = new RoadGraph();
    road(graph, 0, 0, 400, 0);
    graph.setTerminal(at(graph, 0, 0), { ...DEFAULT_SOURCE, rate: 30 });
    graph.setTerminal(at(graph, 400, 0), SINK);
    const sim = new Simulation(graph);
    sim.parking = false;
    run(sim, 30, () => noOverlap(sim));
    expect(sim.delivered).toBeGreaterThan(5);
  });

  it("drives at each road's speed limit", () => {
    const top = (speed?: number) => {
      const graph = new RoadGraph();
      road(graph, 0, 0, 1200, 0, { ...DEFAULT_ROAD_SPEC, speed });
      graph.setTerminal(at(graph, 0, 0), { ...DEFAULT_SOURCE, rate: 30 });
      graph.setTerminal(at(graph, 1200, 0), SINK);
      const sim = new Simulation(graph);
      sim.parking = false;
      let fastest = 0;
      run(sim, 30, () => (fastest = Math.max(fastest, ...sim.cars.map((c) => c.v))));
      return fastest;
    };
    expect(top()).toBeLessThanOrEqual(40.5);
    expect(top(110)).toBeGreaterThan(80);
    expect(top(30)).toBeLessThanOrEqual(24.5);
    expect(() => parseRoadSpec({ ...DEFAULT_ROAD_SPEC, speed: 45 })).toThrow();
    expect(normalizeRoadSpec({ ...DEFAULT_ROAD_SPEC, speed: 50 }).speed).toBeUndefined();
  });

  it("counts finished trips and their times, until the stats are reset", () => {
    const graph = new RoadGraph();
    road(graph, 0, 0, 400, 0);
    graph.setTerminal(at(graph, 0, 0), { ...DEFAULT_SOURCE, rate: 30 });
    graph.setTerminal(at(graph, 400, 0), SINK);
    const sim = new Simulation(graph);
    sim.parking = false;
    run(sim, 60);
    const stats = sim.stats();
    expect(stats.trips).toBe(sim.delivered);
    // About 400 units at cruising speed, plus pulling out and turning in.
    expect(stats.meanTrip).toBeGreaterThan(8);
    expect(stats.meanTrip).toBeLessThan(30);
    expect(stats.perMinute).toBeGreaterThan(0);
    expect(stats.stuck).toBe(0);
    sim.resetStats();
    expect(sim.stats()).toMatchObject({ trips: 0, meanTrip: 0, perMinute: 0, laneChanges: 0 });
  });

  it("gives the route ahead of a car, from where it is to the end of its trip", () => {
    const graph = new RoadGraph();
    road(graph, 0, 0, 400, 0);
    graph.setTerminal(at(graph, 0, 0), { ...DEFAULT_SOURCE, rate: 30 });
    graph.setTerminal(at(graph, 400, 0), SINK);
    const sim = new Simulation(graph);
    sim.parking = false;
    run(sim, 8);
    const car = sim.cars.find((c) => c.legs[c.leg].key.startsWith("r:"))!;
    const route = sim.routeAhead(car, 3);
    expect(route[0].x).toBeCloseTo(sim.pose(car).x);
    expect(route[route.length - 1].x).toBeGreaterThan(380);
    expect(route.every((p, i) => i === 0 || Math.hypot(p.x - route[i - 1].x, p.y - route[i - 1].y) <= 3.01)).toBe(true);
  });

  it("parks cars in a shop's bays, holds the rest back while it's full, and sends them home after", () => {
    const graph = new RoadGraph();
    road(graph, 0, 0, 400, 0);
    const home = at(graph, 0, 0);
    const shop = at(graph, 400, 0);
    graph.setTerminal(home, { ...DEFAULT_SOURCE, rate: 60 });
    graph.setTerminal(shop, SINK);
    const bays = carPark(graph.terminalLot(shop)!).bays.length;
    expect(bays).toBeGreaterThan(0);
    const sim = new Simulation(graph);
    let homeward = 0;
    run(sim, 200, () => {
      noOverlap(sim);
      // Never more cars after the shop than it has bays, and never two in one bay.
      const held = sim.cars.filter((c) => c.parking).map((c) => c.parking!.bay);
      expect(new Set(held).size).toBe(held.length);
      expect(held.length).toBeLessThanOrEqual(bays);
      for (const car of sim.cars) {
        if (car.leaveAt !== null) expect(car.leaveAt - sim.time).toBeLessThanOrEqual(100);
        if (car.legs[car.legs.length - 1].key === `in:${home}`) homeward++;
      }
    });
    // Over 200 s, bays emptied (stays are 20–100 s) and took more cars, and cars drove home.
    expect(sim.delivered).toBeGreaterThan(bays);
    expect(homeward).toBeGreaterThan(0);
  });

  it("parks cars behind a large shop, in two rows facing each other, up its side driveway", () => {
    const graph = new RoadGraph();
    road(graph, 0, 0, 400, 0);
    graph.setTerminal(at(graph, 0, 0), { ...DEFAULT_SOURCE, rate: 60 });
    const office = at(graph, 400, 0);
    graph.setTerminal(office, newTerminal("largeShop"));
    const { bays } = carPark(graph.terminalLot(office)!);
    expect(bays.every((b) => b.rear)).toBe(true);
    expect(new Set(bays.map((b) => b.facing))).toEqual(new Set([1, -1]));
    const sim = new Simulation(graph);
    const used = new Set<number>();
    let pathUp = 0;
    run(sim, 200, () => {
      noOverlap(sim);
      for (const car of sim.cars) {
        if (car.leaveAt !== null) used.add(car.parking!.bay);
        if (car.legs[car.leg].key === `path:${office}`) pathUp++;
      }
    });
    expect([...used].some((i) => bays[i].rear)).toBe(true);
    expect(pathUp).toBeGreaterThan(0);
  });

  it("parks cars under an office out of sight, and brings them out one at a time", () => {
    const graph = new RoadGraph();
    road(graph, 0, 0, 400, 0);
    graph.setTerminal(at(graph, 0, 0), { ...DEFAULT_SOURCE, rate: 60 });
    const office = at(graph, 400, 0);
    graph.setTerminal(office, newTerminal("smallOffice"));
    const { bays } = carPark(graph.terminalLot(office)!);
    expect(bays.every((b) => b.underground)).toBe(true);
    const sim = new Simulation(graph);
    let most = 0;
    let out = 0;
    run(sim, 200, () => {
      noOverlap(sim);
      most = Math.max(most, sim.cars.filter((c) => c.leaveAt !== null).length);
      expect(sim.cars.filter((c) => c.parking?.sink === office).length).toBeLessThanOrEqual(bays.length);
      if (sim.cars.some((c) => c.legs[c.leg].key === `exit:${office}`)) out++;
    });
    expect(most).toBeGreaterThan(2);
    expect(out).toBeGreaterThan(0);
  });

  it("keeps a shop's parked cars when it's renamed or recoloured, and drops them when it's moved", () => {
    const graph = new RoadGraph();
    road(graph, 0, 0, 400, 0);
    graph.setTerminal(at(graph, 0, 0), { ...DEFAULT_SOURCE, rate: 60 });
    const shop = at(graph, 400, 0);
    graph.setTerminal(shop, SINK);
    const sim = new Simulation(graph);
    run(sim, 40);
    const atShop = () => sim.cars.filter((c) => c.parking?.sink === shop).length;
    const before = atShop();
    expect(before).toBeGreaterThan(0);
    graph.setTerminal(shop, { ...graph.terminal(shop)!, name: "Corner Mart", colors: { primary: 0x123456, secondary: 0x654321 } });
    expect(atShop()).toBe(before);
    graph.setTerminal(shop, { ...graph.terminal(shop)!, wide: 1, level: 2 });
    expect(atShop()).toBe(0);
  });

  it("staggers the first cars from many homes rather than sending them all at once", () => {
    const graph = new RoadGraph();
    road(graph, 0, 0, 2000, 0);
    graph.setTerminal(at(graph, 2000, 0), SINK);
    for (let x = 100; x <= 1900; x += 60) {
      const node = graph.nodeOnRoad({ x, y: 5 })!;
      graph.setTerminal(node.id, { ...DEFAULT_SOURCE, side: 1 });
    }
    const sim = new Simulation(graph);
    sim.parking = false;
    const firsts: number[] = [];
    const seen = new Set<number>();
    run(sim, 70, () => {
      for (const c of sim.cars) {
        if (seen.has(c.home)) continue;
        seen.add(c.home);
        firsts.push(sim.time);
      }
    });
    // Over thirty villas at a car a minute: first cars spread across the minute, not in one burst.
    expect(firsts.length).toBeGreaterThan(25);
    const span = Math.max(...firsts) - Math.min(...firsts);
    expect(span).toBeGreaterThan(30);
  });

  it("only sends cars to the sinks a source lists", () => {
    const { graph } = crossroads({ control: "yield" });
    const east = at(graph, 300, 0);
    graph.setTerminal(at(graph, -300, 0), { ...DEFAULT_SOURCE, rate: 40, sinks: [east] });
    graph.setTerminal(at(graph, 0, -300), { ...DEFAULT_SOURCE, enabled: false });
    const sim = new Simulation(graph);
    sim.parking = false;
    run(sim, 40, () => {
      for (const car of sim.cars) expect(car.legs[car.legs.length - 1].segment).toBe(graph.segmentsAt(east)[0].id);
    });
    expect(sim.delivered).toBeGreaterThan(3);
  });

  for (const control of ["stop", "yield", "none"] as const) {
    it(`never lets crossing movements share an all-way ${control} junction`, () => {
      const { graph, centre } = crossroads({ control });
      const sim = new Simulation(graph);
      sim.parking = false;
      const tracks = (sim as unknown as { tracks: { conflicts: (a: unknown, b: unknown) => boolean } }).tracks;
      run(sim, 120, () => {
        noOverlap(sim);
        const inside = sim.cars.map((c) => c.legs[c.leg]).filter((l) => l.node === centre);
        for (const a of inside) for (const b of inside) if (a !== b) expect(tracks.conflicts(a, b)).toBe(false);
        // Right-hand traffic: indicating right for a kerb-side turn, left for one across traffic.
        for (const car of sim.cars) {
          const leg = car.legs[car.leg];
          if (leg.node === centre) expect(sim.signal(car)).toBe(leg.turn === "kerb" ? 1 : leg.turn === "across" ? -1 : 0);
        }
      });
      // An all-way stop serves about one car every 3 s.
      expect(sim.delivered).toBeGreaterThan(30);
    });
  }

  it("turns kerb-side on red where the junction allows it, only after stopping and giving way", () => {
    const { graph, centre } = crossroads({ control: "signals", turnOnRed: true });
    // Light traffic from the north, so cars turning from the west on red find gaps in it.
    graph.setTerminal(at(graph, 0, -300), { ...DEFAULT_SOURCE, rate: 8 });
    const sim = new Simulation(graph);
    sim.parking = false;
    const approaches = signalApproaches(graph, centre);
    const lightOf = (car: Car) => signalLights(approaches.length, sim.time, graph.rules.signals)[approaches.indexOf(car.legs[car.leg - 1].segment!)];
    // Cars that stood at the line (long enough for a stop sign) on their way to the junction.
    const stood = new Set<Car>();
    const legBefore = new Map<Car, number>();
    let onRed = 0;
    run(sim, 120, () => {
      noOverlap(sim);
      for (const car of sim.cars) {
        const leg = car.legs[car.leg];
        const entered = legBefore.get(car) !== car.leg && leg.node === centre;
        legBefore.set(car, car.leg);
        if (entered && lightOf(car) === "red" && !stood.has(car) && leg.turn === "kerb") expect.fail("turned on red without stopping");
        if (entered && lightOf(car) === "red" && stood.has(car)) {
          onRed++;
          expect(leg.turn).toBe("kerb");
          // Nobody with a green close by on a path it crosses or joins.
          for (const c of sim.cars) {
            const upcoming = c.legs[c.leg + 1];
            if (c === car || upcoming?.node !== centre || lightOf(c) === "red") continue;
            if (legLength(c.legs[c.leg]) - c.s < c.v * graph.rules.junctions.yieldHorizon + 10) {
              expect((sim as unknown as { tracks: TrackBuilder }).tracks.conflicts(leg, upcoming)).toBe(false);
            }
          }
        }
        if (car.legs[car.leg + 1]?.node === centre && car.stopped >= graph.rules.junctions.stopHold) stood.add(car);
      }
    });
    expect(onRed).toBeGreaterThan(0);
  });

  it("keeps its lane where two roads join", () => {
    const graph = new RoadGraph();
    const spec = { ...DEFAULT_ROAD_SPEC, lanes: 2 };
    road(graph, 0, 0, 400, 0, spec);
    road(graph, 400, 0, 700, 120, spec);
    graph.setTerminal(at(graph, 0, 0), { ...DEFAULT_SOURCE, rate: 60 });
    graph.setTerminal(at(graph, 700, 120), SINK);
    const sim = new Simulation(graph);
    sim.parking = false;
    run(sim, 120, () => {
      for (const a of sim.cars) {
        for (const b of sim.cars) {
          if (a === b) continue;
          const p = sim.pose(a);
          const q = sim.pose(b);
          apart(Math.hypot(p.x - q.x, p.y - q.y), CAR_LENGTH * 0.7);
        }
      }
    });
    expect(sim.delivered).toBeGreaterThan(40);
    // Every car starts and ends in the kerb lane, beside the source's and sink's buildings.
    const order = lanesInnerToKerb(spec, graph.drivingSide);
    const kerb = order[order.length - 1];
    for (const car of sim.cars) {
      const roads = car.legs.filter((l) => l.key.startsWith("r:"));
      expect(roads[0].key.split(":")[3]).toBe(String(kerb));
      expect(roads[roads.length - 1].key.split(":")[3]).toBe(String(kerb));
    }
  });

  for (const side of ["right", "left"] as const) {
    it(`never drives into a junction on a red light (${side}-hand traffic)`, () => {
      const { graph, centre } = crossroads({ control: "signals" });
      graph.setDrivingSide(side);
      const sim = new Simulation(graph);
      sim.parking = false;
      const approaches = signalApproaches(graph, centre);
      const leg = new Map<Car, number>();
      run(sim, 120, () => {
        noOverlap(sim);
        for (const car of sim.cars) {
          // Waiting cars keep their front bumper (half a car ahead of their centre) behind the line.
          const next = car.legs[car.leg + 1];
          if (next?.node !== undefined && next.rule && !car.cleared) {
            const leg = car.legs[car.leg];
            expect(car.s + CAR_LENGTH / 2).toBeLessThanOrEqual(leg.to - leg.from + 0.01);
          }
          const entered = leg.get(car) !== car.leg && car.legs[car.leg].node === centre;
          leg.set(car, car.leg);
          if (!entered) continue;
          // Red now and already red a moment ago means it ran the light (allowed in on yellow, it can cross just after the change).
          const light = (t: number) => signalLights(approaches.length, t, graph.rules.signals)[approaches.indexOf(car.legs[car.leg - 1].segment!)];
          expect(light(sim.time) === "red" && light(sim.time - 1.5) === "red").toBe(false);
        }
      });
      expect(sim.delivered).toBeGreaterThan(30);
    });
  }

  for (const side of ["right", "left"] as const) {
    it(`keeps a busy roundabout moving without cars overlapping on the ring (${side}-hand traffic)`, () => {
      const graph = new RoadGraph();
      graph.setDrivingSide(side);
      road(graph, -300, 0, 300, 0);
      road(graph, 0, -300, 0, 300);
      const centre = at(graph, 0, 0);
      graph.setJunction(centre, { roundabout: true });
      for (const [x, y] of [[-300, 0], [0, -300]]) graph.setTerminal(at(graph, x, y), { ...DEFAULT_SOURCE, rate: 40 });
      for (const [x, y] of [[300, 0], [0, 300]]) graph.setTerminal(at(graph, x, y), SINK);
      const sim = new Simulation(graph);
      sim.parking = false;
      run(sim, 300, () => {
        noOverlap(sim);
        const ring = sim.cars.filter((c) => {
          const l = c.legs[c.leg] as Car["legs"][number];
          return l.node === centre && c.s >= l.onRing! && c.s <= l.offRing!;
        });
        for (const a of ring) {
          for (const b of ring) {
            if (a === b) continue;
            const p = sim.pose(a);
            const q = sim.pose(b);
            apart(Math.hypot(p.x - q.x, p.y - q.y), CAR_LENGTH * 0.8);
          }
        }
      });
      const before = sim.delivered;
      run(sim, 60);
      expect(before).toBeGreaterThan(100);
      expect(sim.delivered - before).toBeGreaterThan(20);
    });
  }
});

describe("junction paths", () => {
  it("swing round the corner's kerb, not across it, even on a sharp turn into an acute corner", () => {
    // A two-lane road from the west, and one leaving at 30° to it: right-hand traffic from the
    // west turns 150° right into it, round the narrow corner between them.
    const graph = new RoadGraph();
    const spec = { ...DEFAULT_ROAD_SPEC, lanes: 2 };
    road(graph, -300, 0, 0, 0, spec);
    road(graph, 0, 0, -260, 150, spec);
    road(graph, 0, 0, 300, 0, spec);
    const centre = at(graph, 0, 0);
    const west = graph.segmentsAt(centre).find((s) => s.a === at(graph, -300, 0))!;
    const sharp = graph.segmentsAt(centre).find((s) => s.b === at(graph, -260, 150))!;
    // The roads are 48 wide. Their edges facing each other (y = 24, and the other road's edge
    // nearer it) meet at (-89.6, 24); the kerb (default smoothness 16) is an arc of radius 16
    // tangent to both, centred at (-149.3, 40). Beyond that arc, inside the corner, is grass.
    const r = kerbRadius(16);
    const kerbCentre = { x: -149.3, y: 40 };
    // Cars stop where the road layer puts the lines: just past where the kerb meets each road.
    const tracks = new TrackBuilder(graph, () => 151);
    const kerb = (s: typeof west) => lanesInnerToKerb(s.spec, graph.drivingSide)[1];
    const into = tracks.roadLeg(west, at(graph, -300, 0), kerb(west));
    const out = tracks.roadLeg(sharp, centre, kerb(sharp));
    const turn = tracks.junctionLeg(centre, into, out, kerb(west), kerb(sharp), "kerb");
    for (let s = 0; s <= turn.track.length; s += 1) {
      const p = turn.track.at(s).p;
      expect(Math.hypot(p.x - kerbCentre.x, p.y - kerbCentre.y)).toBeGreaterThan(r + CAR_WIDTH / 2);
    }
  });
});

describe("roundabout lanes", () => {
  it("uses the outer ring lane for the first exit and the inner one from the third, matching lanes in and out", () => {
    const graph = new RoadGraph();
    const spec = { ...DEFAULT_ROAD_SPEC, lanes: 2 };
    road(graph, -300, 0, 300, 0, spec);
    road(graph, 0, -300, 0, 300, spec);
    const centre = at(graph, 0, 0);
    graph.setJunction(centre, { roundabout: true });
    // From the west, south is the first exit and east the second; from the north, south is the second and east the third.
    // Sources feed in from side roads, so cars pick their lane at a junction before the roundabout
    // (straight out of a source, a car is in the kerb lane).
    road(graph, -200, -150, -200, 0, spec);
    road(graph, 150, -200, 0, -200, spec);
    for (const [x, y] of [[-200, -150], [150, -200]]) graph.setTerminal(at(graph, x, y), { ...DEFAULT_SOURCE, rate: 50 });
    for (const [x, y] of [[300, 0], [0, 300]]) graph.setTerminal(at(graph, x, y), SINK);
    const { island } = roundaboutShape([spec]);
    const inner = island + 2 + LANE_WIDTH / 2;
    const outer = inner + LANE_WIDTH;
    const sim = new Simulation(graph);
    sim.parking = false;
    const tracks = (sim as unknown as { tracks: TrackBuilder }).tracks;
    const seen = new Set<string>();
    run(sim, 120, () => {
      noOverlap(sim);
      // Cars in the two ring lanes, or crossing the outer one to leave, never run into each other.
      const inside = sim.cars.filter((c) => c.legs[c.leg].node === centre);
      for (const a of inside) {
        for (const b of inside) {
          if (a === b) continue;
          const p = sim.pose(a);
          const q = sim.pose(b);
          apart(Math.hypot(p.x - q.x, p.y - q.y), CAR_LENGTH * 0.75);
        }
      }
      for (const car of sim.cars) {
        const leg = car.legs[car.leg];
        if (leg.node !== centre || !leg.ring) continue;
        const into = graph.segments.get(car.legs[car.leg - 1].segment!)!;
        const exit = tracks.exitNumber(centre, into, graph.segments.get(car.legs[car.leg + 1].segment!)!);
        if (exit === 1) expect(leg.ring.radius).toBeCloseTo(outer);
        if (exit >= 3) expect(leg.ring.radius).toBeCloseTo(inner);
        // The inner road lane goes to and from the inner ring lane, the kerb lane to and from the outer one.
        const rank = (l: { key: string }) => lanesInnerToKerb(spec, graph.drivingSide).indexOf(Number(l.key.split(":")[3]));
        const ringRank = leg.ring.radius === outer ? 1 : 0;
        expect(rank(car.legs[car.leg - 1])).toBe(ringRank);
        expect(rank(car.legs[car.leg + 1])).toBe(ringRank);
        seen.add(`${exit}:${leg.ring.radius === outer ? "outer" : "inner"}`);
      }
    });
    // Every exit was used (second-exit traffic may use either lane: the one needing the fewest changes after).
    expect([...seen].sort()).toEqual(expect.arrayContaining(["1:outer", "3:inner"]));
    expect([...seen].some((k) => k.startsWith("2:"))).toBe(true);
  });
});

describe("lane choice", () => {
  /** Two roads of two lanes (0 inner, 1 kerb), each lane carrying straight on into the same lane of the next. */
  const facts = (valid: number[][], congestion: number[] = [0, 0]): LaneFacts => ({
    roads: valid.length,
    valid: (i) => valid[i],
    next: (_i, lane) => [lane],
    changes: (_i, a, b) => Math.abs(a - b),
    congestion: (i, lane) => (i === 0 ? congestion[lane] : 0),
  });
  const rules = (order: ("fewestChanges" | "keepLane" | "leastCongested")[]) => ({ lookahead: 3, order });

  it("keeps its lane when either lane goes where it's going", () => {
    expect(planLanes(facts([[0, 1], [1]]), 0, 1, rules(["fewestChanges", "keepLane", "leastCongested"])).exit[0]).toBe(1);
    expect(planLanes(facts([[0, 1], [0, 1]]), 0, 0, rules(["fewestChanges", "keepLane", "leastCongested"])).exit[0]).toBe(0);
  });

  it("only ever takes a lane that leads on, and weighs queues by the order given", () => {
    expect(planLanes(facts([[0], [0, 1]]), 0, 1, rules(["keepLane", "fewestChanges", "leastCongested"])).exit[0]).toBe(0);
    // A queue in its own lane: moves over only when least congested comes before staying in lane.
    const queued = facts([[0, 1], [0, 1]], [0, 3]);
    expect(planLanes(queued, 0, 1, rules(["fewestChanges", "keepLane", "leastCongested"])).exit[0]).toBe(1);
    expect(planLanes(queued, 0, 1, rules(["leastCongested", "fewestChanges", "keepLane"])).exit[0]).toBe(0);
  });

  it("doesn't change lane before a turn both lanes may make", () => {
    const changes = (bothLanesTurn: boolean) => {
      const graph = new RoadGraph();
      const spec = { ...DEFAULT_ROAD_SPEC, lanes: 2 };
      road(graph, -400, 0, 0, 0, spec);
      road(graph, 0, 0, 400, 0, spec);
      road(graph, 0, 0, 0, -400, spec);
      const tee = at(graph, 0, 0);
      graph.setTerminal(at(graph, -400, 0), { ...DEFAULT_SOURCE, rate: 30 });
      graph.setTerminal(at(graph, 0, -400), SINK);
      if (bothLanesTurn) {
        const west = graph.segmentsAt(tee).find((s) => graph.directionAway(s, tee).x < -0.9)!;
        const north = graph.segmentsAt(tee).find((s) => graph.directionAway(s, tee).y < -0.9)!;
        const turns = defaultConnections(graph, tee).filter((c) => !(c.from.segment === west.id && c.to.segment === north.id));
        const lanes = lanesInnerToKerb(spec, graph.drivingSide);
        for (const lane of lanes) turns.push({ from: { segment: west.id, lane }, to: { segment: north.id, lane } });
        graph.setJunction(tee, { connections: turns });
      }
      const sim = new Simulation(graph);
      sim.parking = false;
      run(sim, 60, () => noOverlap(sim));
      expect(sim.delivered).toBeGreaterThan(10);
      return sim.stats().laneChanges;
    };
    // Out of the home in the kerb lane, turning across traffic: by default only the inner lane may.
    expect(changes(false)).toBeGreaterThan(0);
    expect(changes(true)).toBe(0);
  });
});

describe("lane changes", () => {
  it("changes lane on the road between a source, a roundabout and a sink, without clipping anyone", () => {
    const graph = new RoadGraph();
    const spec = { ...DEFAULT_ROAD_SPEC, lanes: 2 };
    road(graph, -400, 0, 400, 0, spec);
    road(graph, 0, -400, 0, 400, spec);
    const centre = at(graph, 0, 0);
    graph.setJunction(centre, { roundabout: true });
    // Straight out of the sources (kerb lane): from the north, east is the third exit (inner lane).
    // Below the roundabout's capacity (about 36 cars a minute here), so it checks flow, not peak throughput.
    for (const [x, y] of [[-400, 0], [0, -400]]) graph.setTerminal(at(graph, x, y), { ...DEFAULT_SOURCE, rate: 25 });
    for (const [x, y] of [[400, 0], [0, 400]]) graph.setTerminal(at(graph, x, y), SINK);
    const { island } = roundaboutShape([spec]);
    const inner = island + 2 + LANE_WIDTH / 2;
    const sim = new Simulation(graph);
    sim.parking = false;
    const tracks = (sim as unknown as { tracks: TrackBuilder }).tracks;
    const order = lanesInnerToKerb(spec, graph.drivingSide);
    run(sim, 180, () => {
      noOverlap(sim);
      for (const a of sim.cars) {
        for (const b of sim.cars) {
          if (a === b) continue;
          const p = sim.pose(a);
          const q = sim.pose(b);
          apart(Math.hypot(p.x - q.x, p.y - q.y), CAR_LENGTH * 0.75);
        }
        const leg = a.legs[a.leg] as Car["legs"][number];
        // Indicating towards the new lane while changing into it.
        if (leg.joinAt !== undefined) expect(sim.signal(a)).toBe(leg.shift);
        // Approaching the roundabout: right for the first exit, left for the third, none for the second.
        const next = a.legs[a.leg + 1] as Car["legs"][number] | undefined;
        if (next?.ring && leg.to - leg.from - a.s < 30) expect(sim.signal(a)).toBe(next.exit === 1 ? 1 : next.exit! >= 3 ? -1 : 0);
        if (leg.node !== centre || !leg.ring) continue;
        // Nearing the exit: right, to leave.
        if (a.s > leg.offRing! - 30 && a.s <= leg.offRing!) expect(sim.signal(a)).toBe(1);
        const into = graph.segments.get(a.legs[a.leg - 1].segment!)!;
        const exit = tracks.exitNumber(centre, into, graph.segments.get(a.legs[a.leg + 1].segment!)!);
        if (exit >= 3) expect(leg.ring.radius).toBeCloseTo(inner);
      }
    });
    // Every car still starts and ends in the kerb lane, by the buildings.
    for (const car of sim.cars) {
      const roads = car.legs.filter((l) => l.key.startsWith("r:"));
      expect(roads[0].key.split(":")[3]).toBe(String(order[order.length - 1]));
      expect(roads[roads.length - 1].key.split(":")[3]).toBe(String(order[order.length - 1]));
    }
    expect(sim.cars.some((c) => c.legs.some((l) => l.joinAt !== undefined))).toBe(true);
    expect(sim.delivered).toBeGreaterThan(80);
  });
});

describe("stuck before a turn", () => {
  /**
   * From the west, north is a left turn across traffic (inner lane only), or the long way round,
   * straight on east (either lane). Cars leave home in the kerb lane; lane changes on the road never
   * find a gap, so they're stuck before the turn.
   */
  function blocked(reroute: boolean) {
    const graph = new RoadGraph();
    const spec = { ...DEFAULT_ROAD_SPEC, lanes: 2 };
    road(graph, -400, 0, 0, 0, spec);
    road(graph, 0, 0, 0, -400, spec);
    road(graph, 0, 0, 400, 0, spec);
    road(graph, 400, 0, 400, -400, spec);
    road(graph, 400, -400, 0, -400, spec);
    road(graph, 0, -400, 0, -500, spec);
    graph.setTerminal(at(graph, -400, 0), { ...DEFAULT_SOURCE, rate: 10 });
    graph.setTerminal(at(graph, 0, -500), SINK);
    graph.setRules({ ...graph.rules, laneChange: { ...graph.rules.laneChange, deadlockReroute: reroute, rerouteWait: 4 } });
    const sim = new Simulation(graph);
    sim.parking = false;
    const blockable = sim as unknown as { mayChangeLane: (car: Car, change: Car["legs"][number]) => boolean };
    const mayChangeLane = blockable.mayChangeLane.bind(sim);
    blockable.mayChangeLane = (car, change) => (change.slide ? false : mayChangeLane(car, change));
    return sim;
  }

  it("waits at the last chance with its indicator on, then finds another way from its lane", () => {
    const sim = blocked(true);
    let indicating = false;
    // Long enough to wait, give up and drive the long way round.
    run(sim, 100, () => {
      noOverlap(sim);
      for (const car of sim.cars) if (car.stopped > 1 && car.legs[car.leg + 1]?.slide) indicating ||= sim.signal(car) !== 0;
    });
    expect(indicating).toBe(true);
    expect(sim.stats().reroutes).toBeGreaterThan(0);
    expect(sim.delivered).toBeGreaterThan(0);
  });

  it("waits for good when rerouting is off", () => {
    const sim = blocked(false);
    run(sim, 100);
    expect(sim.stats().reroutes).toBe(0);
    expect(sim.delivered).toBe(0);
  });
});

describe("sources and sinks along a road", () => {
  it("give way pulling out of a driveway: they never pull out in front of a car close by on the road", () => {
    const graph = new RoadGraph();
    road(graph, 0, 0, 1200, 0);
    // Busy through traffic from the west end to the east, and a home halfway along on its side.
    graph.setTerminal(at(graph, 0, 0), { ...DEFAULT_SOURCE, rate: 25 });
    graph.setTerminal(at(graph, 1200, 0), SINK);
    const home = graph.nodeOnRoad({ x: 600, y: 10 })!;
    graph.setTerminal(home.id, { ...DEFAULT_SOURCE, rate: 30, side: 1 });
    const sim = new Simulation(graph);
    sim.parking = false;
    const pulledOut = new Set<number>();
    run(sim, 120, () => {
      for (const car of sim.cars) {
        const leg = car.legs[car.leg];
        if (!leg.key.startsWith(`out:${home.id}:`) || pulledOut.has(car.id)) continue;
        pulledOut.add(car.id);
        // Just pulled out: nobody in the lane it joins within ~2 s of the joining point.
        for (const other of sim.cars) {
          const theirs = other.legs[other.leg];
          if (other === car || theirs.key !== leg.outKey) continue;
          const behind = leg.joinAt! - (theirs.from + other.s);
          if (behind > 0) apart(behind, other.v * 2.2);
        }
      }
    });
    expect(pulledOut.size).toBeGreaterThan(3);
  });

  it("send cars out of the driveway both ways, and take them in at the far end", () => {
    const graph = new RoadGraph();
    const spec = { ...DEFAULT_ROAD_SPEC, lanes: 2 };
    road(graph, 0, 0, 1000, 0, spec);
    // A source halfway along, its building on the right of the road (south, as world y points
    // down); sinks at both ends, and one along the road with its building on the left (north).
    const source = graph.nodeOnRoad({ x: 500, y: 10 })!;
    graph.setTerminal(source.id, { ...DEFAULT_SOURCE, rate: 30, side: 1 });
    const middle = graph.nodeOnRoad({ x: 800, y: -10 })!;
    graph.setTerminal(middle.id, { ...SINK, side: -1 });
    graph.setTerminal(at(graph, 0, 0), SINK);
    graph.setTerminal(at(graph, 1000, 0), SINK);
    expect(graph.segments.size).toBe(3);
    expect(graph.terminalLot(source.id)!.centre.y).toBeGreaterThan(0);
    expect(graph.terminalLot(middle.id)!.centre.y).toBeLessThan(0);

    const sim = new Simulation(graph);
    sim.parking = false;
    const headings = new Set<string>();
    run(sim, 90, () => {
      noOverlap(sim);
      for (const a of sim.cars) {
        for (const b of sim.cars) {
          if (a === b) continue;
          const p = sim.pose(a);
          const q = sim.pose(b);
          apart(Math.hypot(p.x - q.x, p.y - q.y), CAR_LENGTH * 0.7);
        }
        // Out through the door and driveway; in by the sink's driveway.
        expect(a.legs[0].key).toBe(`door:${source.id}`);
        expect(a.legs[a.legs.length - 1].key.startsWith("in:")).toBe(true);
        headings.add(sim.pose(a).x > 500 ? "east" : "west");
      }
    });
    expect([...headings].sort()).toEqual(["east", "west"]);
    expect(sim.delivered).toBeGreaterThan(20);

    const loaded = new RoadGraph();
    loaded.load(JSON.parse(JSON.stringify(graph.toJSON())));
    // Plus the customers it has served by now.
    expect(loaded.terminal(middle.id)).toMatchObject({ kind: "sink", building: "smallShop", side: -1 });
  });
});

describe("terminals", () => {
  it("survive save and load, stay on a road that's extended, and are dropped when it becomes a junction", () => {
    const { graph } = crossroads({ control: "stop" });
    // Rates a home could really have (loading caps them at its kind's top rate).
    for (const [id, t] of graph.allTerminals()) if (t.kind === "source") graph.setTerminal(id, { ...t, rate: 2 });
    const loaded = new RoadGraph();
    loaded.load(JSON.parse(JSON.stringify(graph.toJSON())));
    expect(loaded.toJSON()).toEqual(graph.toJSON());

    const east = at(graph, 300, 0);
    road(graph, 300, 0, 300, 200);
    expect(graph.terminal(east)?.kind).toBe("sink");
    road(graph, 300, 0, 500, 0);
    expect(graph.terminal(east)).toBeUndefined();
    expect([...graph.allTerminals().values()].filter((t) => t.kind === "sink")).toHaveLength(1);
  });

  it("finds a source's or sink's building under a point, but not the road end beside it", () => {
    const { graph } = crossroads({ control: "stop" });
    const west = at(graph, -300, 0);
    expect(graph.terminalAt(graph.terminalLot(west)!.centre)).toBe(west);
    expect(graph.terminalAt({ x: -300, y: 0 })).toBeUndefined();
  });

  it("load maps from before buildings, and use each building's footprint", () => {
    const old = (rate: number) => parseTerminal({ kind: "source", enabled: true, rate, sinks: [] });
    expect([old(1), old(3), old(10)].map((t) => t.building)).toEqual(["villa", "townhouse", "apartment"]);
    expect(old(10)).toMatchObject({ rate: 10 });
    expect(parseTerminal({ kind: "sink" })).toEqual({ kind: "sink", building: "smallShop" });
    expect(() => parseTerminal({ kind: "sink", building: "castle" })).toThrow();

    const { graph } = crossroads({ control: "stop" });
    const east = at(graph, 300, 0);
    graph.setTerminal(east, newTerminal("largeShop"));
    expect(graph.terminalLot(east)).toMatchObject(buildingSize({ building: "largeShop" }));
  });

  it("rejects a source or sink that isn't on a dead end", () => {
    const { graph, centre } = crossroads({ control: "stop" });
    const map = graph.toJSON();
    expect(() => new RoadGraph().load({ ...map, terminals: [{ node: centre, kind: "sink", building: "smallShop" }] })).toThrow();
  });
});

describe("stop and give way junctions", () => {
  it("keep cars going through a junction when its control or its shape changes", () => {
    const { graph, centre } = crossroads({ control: "stop" });
    const sim = new Simulation(graph);
    sim.parking = false;
    run(sim, 20);
    const through = () => sim.cars.filter((c) => c.legs.some((l) => l.node === centre)).length;
    const before = through();
    expect(before).toBeGreaterThan(0);
    graph.setJunction(centre, { control: "yield" });
    expect(through()).toBe(before);
    graph.setJunction(centre, { major: 1 });
    expect(through()).toBe(before);
    graph.setJunction(centre, { control: "signals" });
    expect(through()).toBe(before);
    // Cars keep moving under the new rules.
    const delivered = sim.delivered;
    run(sim, 30);
    expect(sim.delivered).toBeGreaterThan(delivered);
    // Made a roundabout: their trips are planned again on it, and they carry on.
    const all = sim.cars.length;
    graph.setJunction(centre, { roundabout: true });
    expect(sim.cars.length).toBeGreaterThanOrEqual(Math.ceil(all * 0.8));
    const after = sim.delivered;
    run(sim, 40, () => noOverlap(sim));
    expect(sim.delivered).toBeGreaterThan(after);
    graph.setJunction(centre, { cornerRadius: 30, roundabout: false });
    expect(sim.cars.length).toBeGreaterThan(0);
    run(sim, 20, () => noOverlap(sim));
  });

  it("put the signs on the side road at a T, and on one opposite pair (swappable) at a crossroads", () => {
    const t = new RoadGraph();
    road(t, -300, 0, 300, 0);
    road(t, 0, 0, 0, 300);
    const tee = at(t, 0, 0);
    const stem = t.segmentsAt(tee).find((s) => Math.abs(t.directionAway(s, tee).y) > 0.9)!;
    expect([...minorRoads(t, tee)]).toEqual([stem.id]);

    const { graph, centre } = crossroads({ control: "stop" });
    const pair = () => [...minorRoads(graph, centre)].map((id) => graph.directionAway(graph.segments.get(id)!, centre));
    const first = pair();
    expect(first).toHaveLength(2);
    // Opposite each other.
    expect(first[0].x * first[1].x + first[0].y * first[1].y).toBeCloseTo(-1, 3);
    graph.setJunction(centre, { major: 1 });
    const second = pair();
    expect(Math.abs(first[0].x * second[0].x + first[0].y * second[0].y)).toBeLessThan(0.01);
  });

  it("let main-road traffic drive straight through, while the side road stops", () => {
    const graph = new RoadGraph();
    road(graph, -300, 0, 300, 0);
    road(graph, 0, 0, 0, 300);
    const centre = at(graph, 0, 0);
    graph.setJunction(centre, { control: "stop" });
    graph.setTerminal(at(graph, -300, 0), { ...DEFAULT_SOURCE, rate: 30 });
    graph.setTerminal(at(graph, 0, 300), { ...DEFAULT_SOURCE, rate: 30 });
    graph.setTerminal(at(graph, 300, 0), SINK);
    const sim = new Simulation(graph);
    sim.parking = false;
    const stem = [...minorRoads(graph, centre)][0];
    let mainStopped = 0;
    let sideStopped = 0;
    run(sim, 90, () => {
      for (const car of sim.cars) {
        const leg = car.legs[car.leg];
        if (car.legs[car.leg + 1]?.node !== centre || car.stopped < STOP_HOLD_TEST) continue;
        if (leg.segment === stem) sideStopped++;
        // A main-road car held at the line with nobody ahead of it would be stopping for nothing.
        else if (!sim.cars.some((c) => c !== car && c.legs[c.leg].key === leg.key && c.s > car.s)) mainStopped++;
      }
    });
    expect(sideStopped).toBeGreaterThan(0);
    expect(mainStopped).toBe(0);
  });

  it("let the side road go first when the rules put it first, without jamming", () => {
    const graph = new RoadGraph();
    road(graph, -300, 0, 300, 0);
    road(graph, 0, 0, 0, 300);
    const centre = at(graph, 0, 0);
    graph.setJunction(centre, { control: "yield" });
    graph.setTerminal(at(graph, -300, 0), { ...DEFAULT_SOURCE, rate: 30 });
    graph.setTerminal(at(graph, 0, 300), { ...DEFAULT_SOURCE, rate: 30 });
    graph.setTerminal(at(graph, 300, 0), SINK);
    graph.setRules({ ...graph.rules, junctions: { ...graph.rules.junctions, rightOfWay: ["minor", "mainThrough", "mainTurning"] } });
    const sim = new Simulation(graph);
    sim.parking = false;
    const stem = [...minorRoads(graph, centre)][0];
    let mainStopped = 0;
    run(sim, 90, () => {
      noOverlap(sim);
      for (const car of sim.cars) {
        const leg = car.legs[car.leg];
        if (car.legs[car.leg + 1]?.node !== centre || car.stopped < STOP_HOLD_TEST || leg.segment === stem) continue;
        if (!sim.cars.some((c) => c !== car && c.legs[c.leg].key === leg.key && c.s > car.s)) mainStopped++;
      }
    });
    expect(mainStopped).toBeGreaterThan(0);
    // Still flowing, not jammed.
    expect(sim.delivered).toBeGreaterThan(15);
  });
});

describe("slip roads", () => {
  it("peel a one-way road off the main road and merge it back, giving way, with no junction", () => {
    const graph = new RoadGraph();
    road(graph, 0, 0, 900, 0);
    const oneWay = { ...DEFAULT_ROAD_SPEC, oneWay: true };
    road(graph, 200, 0, 320, 30, oneWay);
    road(graph, 320, 30, 580, 30, oneWay);
    road(graph, 580, 30, 700, 0, oneWay);
    const split = at(graph, 200, 0);
    const merge = at(graph, 700, 0);
    expect(slipRoad(graph, split)).toMatchObject({ merge: false });
    expect(slipRoad(graph, merge)).toMatchObject({ merge: true });
    expect(minorRoads(graph, split).size).toBe(0);

    // Off the far side, against the traffic in the lane it would leave: a normal junction instead.
    const wrong = new RoadGraph();
    road(wrong, 0, 0, 900, 0);
    road(wrong, 200, 0, 320, -30, oneWay);
    expect(slipRoad(wrong, at(wrong, 200, 0))).toBeNull();
    expect([...minorRoads(graph, merge)]).toEqual([slipRoad(graph, merge)!.slip]);

    // In off the main road to a shop on the slip road; out of a home on it, merging back on.
    const shop = graph.nodeOnRoad({ x: 450, y: 32 })!;
    graph.setTerminal(shop.id, { ...SINK, side: 1 });
    graph.setTerminal(at(graph, 0, 0), { ...DEFAULT_SOURCE, rate: 8, to: "custom", sinks: [shop.id] });
    const home = graph.nodeOnRoad({ x: 380, y: 32 })!;
    graph.setTerminal(home.id, { ...DEFAULT_SOURCE, rate: 20, side: 1, to: "custom", sinks: [] });
    graph.setTerminal(at(graph, 900, 0), SINK);
    graph.setTerminal(home.id, { ...DEFAULT_SOURCE, rate: 20, side: 1, to: "custom", sinks: [at(graph, 900, 0)] });
    const sim = new Simulation(graph);
    sim.parking = false;
    const arrived = new Map<string, number>();
    const indicated = new Set<string>();
    run(sim, 120, () => {
      noOverlap(sim);
      // Right-hand traffic, slip road on the right: right onto it, left off it back onto the main road.
      for (const car of sim.cars) {
        const leg = car.legs[car.leg];
        if (leg.node === split && sim.signal(car) === 1) indicated.add("on");
        // Nothing to wait for on the way onto the slip road: no braking for it (except behind another car).
        const next = car.legs[car.leg + 1];
        const alone = !sim.cars.some((c) => c !== car && c.legs[c.leg].key === leg.key && c.s > car.s);
        if (next?.node === split && alone) expect(car.accel).toBeGreaterThan(-2);
        if (leg.node === merge && sim.signal(car) === -1) indicated.add("off");
      }
      for (const car of sim.cars) {
        const end = car.legs[car.legs.length - 1].key;
        if (car.leg === car.legs.length - 1 && car.s > legLength(car.legs[car.leg]) - 1) arrived.set(end, (arrived.get(end) ?? 0) + 1);
      }
    });
    // Coming the other way along the main road, nobody doubles back onto the slip road at its start.
    const back = findRoute(graph, at(graph, 900, 0), shop.id);
    if (back) {
      back.nodes.slice(1, -1).forEach((node, i) => {
        if (node !== split) return;
        const p = graph.directionAway(graph.segments.get(back.segments[i])!, node);
        const q = graph.directionAway(graph.segments.get(back.segments[i + 1])!, node);
        expect(p.x * q.x + p.y * q.y).toBeLessThan(0);
      });
    }
    // Both ways round got through: in to the shop off the split, out past the merge to the far end.
    expect(sim.delivered).toBeGreaterThan(20);
    expect(arrived.get(`in:${shop.id}`)).toBeGreaterThan(0);
    expect(arrived.get(`in:${at(graph, 900, 0)}`)).toBeGreaterThan(0);
    expect([...indicated].sort()).toEqual(["off", "on"]);
  });
});

describe("turning into driveways", () => {
  it("waits in its lane for oncoming traffic and for room, rather than stopping halfway across", () => {
    const graph = new RoadGraph();
    road(graph, 0, 0, 900, 0);
    // Through traffic both ways, and a shop on the far side of the road from a home.
    graph.setTerminal(at(graph, 0, 0), { ...DEFAULT_SOURCE, rate: 3 });
    graph.setTerminal(at(graph, 900, 0), { ...DEFAULT_SOURCE, rate: 3 });
    const home = graph.nodeOnRoad({ x: 300, y: 5 })!;
    graph.setTerminal(home.id, { ...DEFAULT_SOURCE, rate: 3, side: 1 });
    const shop = graph.nodeOnRoad({ x: 500, y: -5 })!;
    graph.setTerminal(shop.id, { ...SINK, side: -1 });
    const sim = new Simulation(graph);
    let turns = 0;
    let stalled = 0;
    run(sim, 240, () => {
      for (const car of sim.cars) {
        const leg = car.legs[car.leg];
        if (!leg.key.startsWith("in:") || leg.key.endsWith(":rear") === false && !leg.key.startsWith(`in:${shop.id}`)) continue;
        if (car.s < 1) turns++;
        // Part way through the turn (still on the road), standing still.
        if (car.s > 4 && car.s < legLength(leg) - 4 && car.v < 0.5) stalled++;
      }
    });
    expect(turns).toBeGreaterThan(0);
    expect(stalled).toBe(0);
  });
});
