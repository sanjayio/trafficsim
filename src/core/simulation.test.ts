import { describe, expect, it } from "vitest";
import { straightCurve } from "./curve";
import { kerbRadius, roundaboutShape, signalApproaches, signalLights } from "./junction";
import { RoadGraph, type NodeId } from "./roadGraph";
import { findRoute } from "./routing";
import { DEFAULT_ROAD_SPEC, LANE_WIDTH, type RoadSpec } from "./roadSpec";
import { CAR_LENGTH, CAR_WIDTH, SIM_DT, Simulation, type Car } from "./simulation";
import { DEFAULT_SOURCE, SINK } from "./terminal";
import { lanesInnerToKerb } from "./lanes";
import { TrackBuilder } from "./track";

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
    run(sim, 30, () => noOverlap(sim));
    expect(sim.delivered).toBeGreaterThan(5);
  });

  it("only sends cars to the sinks a source lists", () => {
    const { graph } = crossroads({ control: "yield" });
    const east = at(graph, 300, 0);
    graph.setTerminal(at(graph, -300, 0), { ...DEFAULT_SOURCE, rate: 40, sinks: [east] });
    graph.setTerminal(at(graph, 0, -300), { ...DEFAULT_SOURCE, enabled: false });
    const sim = new Simulation(graph);
    run(sim, 40, () => {
      for (const car of sim.cars) expect(car.legs[car.legs.length - 1].segment).toBe(graph.segmentsAt(east)[0].id);
    });
    expect(sim.delivered).toBeGreaterThan(3);
  });

  for (const control of ["stop", "yield", "none"] as const) {
    it(`never lets crossing movements share an all-way ${control} junction`, () => {
      const { graph, centre } = crossroads({ control });
      const sim = new Simulation(graph);
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

  it("keeps its lane where two roads join", () => {
    const graph = new RoadGraph();
    const spec = { ...DEFAULT_ROAD_SPEC, lanes: 2 };
    road(graph, 0, 0, 400, 0, spec);
    road(graph, 400, 0, 700, 120, spec);
    graph.setTerminal(at(graph, 0, 0), { ...DEFAULT_SOURCE, rate: 60 });
    graph.setTerminal(at(graph, 700, 120), SINK);
    const sim = new Simulation(graph);
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
          const light = (t: number) => signalLights(approaches.length, t)[approaches.indexOf(car.legs[car.leg - 1].segment!)];
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
    // Every exit was used, and second-exit traffic used both lanes.
    expect([...seen].sort()).toEqual(["1:outer", "2:inner", "2:outer", "3:inner"]);
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

describe("sources and sinks along a road", () => {
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
    // Not too close to a junction: cars would join the road past its stop line.
    road(graph, 500, -300, 500, 300, spec);
    expect(graph.nearJunction({ x: 470, y: 0 })).toBe(true);
    expect(graph.nodeOnRoad({ x: 470, y: 0 })).toBeNull();
    expect(graph.nearJunction({ x: 380, y: 0 })).toBe(false);
    expect(sim.delivered).toBeGreaterThan(20);

    const loaded = new RoadGraph();
    loaded.load(JSON.parse(JSON.stringify(graph.toJSON())));
    expect(loaded.terminal(middle.id)).toEqual({ kind: "sink", side: -1 });
  });
});

describe("terminals", () => {
  it("survive save and load, stay on a road that's extended, and are dropped when it becomes a junction", () => {
    const { graph } = crossroads({ control: "stop" });
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

  it("rejects a source or sink that isn't on a dead end", () => {
    const { graph, centre } = crossroads({ control: "stop" });
    const map = graph.toJSON();
    expect(() => new RoadGraph().load({ ...map, terminals: [{ node: centre, kind: "sink" }] })).toThrow();
  });
});
