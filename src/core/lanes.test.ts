import { describe, expect, it } from "vitest";
import { straightCurve } from "./curve";
import { connectionsAt, defaultConnections, lanesInnerToKerb, turnAt, type LaneConnection } from "./lanes";
import { RoadGraph, type NodeId } from "./roadGraph";
import { findRoute } from "./routing";
import { DEFAULT_ROAD_SPEC } from "./roadSpec";
import { SIM_DT, Simulation } from "./simulation";
import { DEFAULT_SOURCE, SINK } from "./terminal";

const spec = { ...DEFAULT_ROAD_SPEC, lanes: 2 };

/** Two-lane crossroads at (0, 0); arms 300 long. */
function crossroads() {
  const graph = new RoadGraph();
  graph.buildRoad(straightCurve({ x: -300, y: 0 }, { x: 300, y: 0 }), spec);
  graph.buildRoad(straightCurve({ x: 0, y: -300 }, { x: 0, y: 300 }), spec);
  const at = (x: number, y: number): NodeId => graph.nodeNear({ x, y }, 1)!.id;
  const centre = at(0, 0);
  const arm = (x: number, y: number) => graph.segmentsAt(centre).find((s) => s.a === at(x, y) || s.b === at(x, y))!;
  return { graph, at, centre, west: arm(-300, 0), east: arm(300, 0), south: arm(0, 300) };
}

describe("lane connections", () => {
  it("start with the kerb lane turning kerb-side, the inner lane across, and every lane straight on", () => {
    const { graph, centre, west } = crossroads();
    const [inner, kerb] = lanesInnerToKerb(spec, graph.drivingSide);
    const fromWest = defaultConnections(graph, centre).filter((c) => c.from.segment === west.id);
    const turns = (lane: number) =>
      fromWest
        .filter((c) => c.from.lane === lane)
        .map((c) => turnAt(graph, centre, west, graph.segments.get(c.to.segment)!))
        .sort();
    expect(turns(kerb)).toEqual(["kerb", "straight"]);
    expect(turns(inner)).toEqual(["across", "straight"]);
  });

  it("only let cars make the turns and use the lanes they connect", () => {
    const { graph, at, centre, west, east, south } = crossroads();
    const [inner, kerb] = lanesInnerToKerb(spec, graph.drivingSide);
    // From the west: straight on only, from the inner lane into the east road's kerb lane.
    const keep = connectionsAt(graph, centre).filter((c) => c.from.segment !== west.id);
    const only: LaneConnection = { from: { segment: west.id, lane: inner }, to: { segment: east.id, lane: kerb } };
    graph.setJunction(centre, { connections: [...keep, only] });

    expect(findRoute(graph, at(-300, 0), at(0, 300))).toBeNull();
    graph.setTerminal(at(-300, 0), { ...DEFAULT_SOURCE, rate: 40 });
    graph.setTerminal(at(300, 0), SINK);
    graph.setTerminal(at(0, 300), SINK);
    const sim = new Simulation(graph);
    // A stop sign at the junction: cars go through one at a time.
    for (let i = 0; i < 80 / SIM_DT; i++) {
      sim.step(SIM_DT);
      for (const car of sim.cars) {
        const leg = car.legs[car.leg];
        if (leg.node !== centre) continue;
        expect(leg.movement).toBe(`${centre}:${west.id}:${inner}>${east.id}:${kerb}`);
        expect(car.legs[car.leg + 1].segment).not.toBe(south.id);
      }
    }
    expect(sim.delivered).toBeGreaterThan(10);
  });

  it("are saved with the map, and reset when a road at the junction changes", () => {
    const { graph, centre, west, east } = crossroads();
    const [inner] = lanesInnerToKerb(spec, graph.drivingSide);
    const connections = [{ from: { segment: west.id, lane: inner }, to: { segment: east.id, lane: inner } }];
    graph.setJunction(centre, { connections });
    const loaded = new RoadGraph();
    loaded.load(JSON.parse(JSON.stringify(graph.toJSON())));
    expect(loaded.junction(centre).connections).toEqual(connections);

    // A lane that doesn't exist is refused.
    const bad = graph.toJSON();
    bad.junctions![0].connections![0].to.lane = 5;
    expect(() => new RoadGraph().load(bad)).toThrow();

    graph.buildRoad(straightCurve({ x: 0, y: 0 }, { x: 200, y: -200 }), spec);
    expect(graph.junction(centre).connections).toBeUndefined();
  });

  it("are kept when one of the junction's roads is split (for a source along it, or a road across it)", () => {
    const { graph, centre, west, east } = crossroads();
    const [inner] = lanesInnerToKerb(spec, graph.drivingSide);
    graph.setJunction(centre, { connections: [{ from: { segment: west.id, lane: inner }, to: { segment: east.id, lane: inner } }] });
    graph.nodeOnRoad({ x: -200, y: 0 });
    graph.buildRoad(straightCurve({ x: 150, y: -100 }, { x: 150, y: 100 }), spec);
    const [kept] = graph.junction(centre).connections!;
    // Now the halves of the west and east roads that meet the junction.
    const half = (x: number) => graph.segmentsAt(centre).find((s) => graph.path(s).nearest({ x, y: 0 }).distance < 1)!;
    expect(kept).toEqual({ from: { segment: half(-50).id, lane: inner }, to: { segment: half(50).id, lane: inner } });
  });
});
