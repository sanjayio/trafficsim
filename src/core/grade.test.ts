import { describe, expect, it } from "vitest";
import { straightCurve } from "./curve";
import { heightAlong, LEVEL_HEIGHT, RAMP_PER_LEVEL, TUNNEL_DEPTH } from "./grade";
import { RoadGraph } from "./roadGraph";
import { DEFAULT_ROAD_SPEC } from "./roadSpec";

const line = (ax: number, ay: number, bx: number, by: number) => straightCurve({ x: ax, y: ay }, { x: bx, y: by });
const bridge = { ...DEFAULT_ROAD_SPEC, level: 1 };
const tunnel = { ...DEFAULT_ROAD_SPEC, level: -1 };

describe("bridges and tunnels", () => {
  it("ramp from the ground at each end to their level", () => {
    expect(heightAlong(1, 0, 400)).toBe(0);
    expect(heightAlong(1, 400, 400)).toBe(0);
    expect(heightAlong(1, 200, 400)).toBe(LEVEL_HEIGHT);
    expect(heightAlong(-2, 200, 400)).toBe(-2 * TUNNEL_DEPTH);
    expect(heightAlong(1, RAMP_PER_LEVEL / 2, 400)).toBeCloseTo(LEVEL_HEIGHT / 2);
  });

  it("pass over and under roads without a junction, and stack over each other", () => {
    const graph = new RoadGraph();
    graph.buildRoad(line(0, 0, 0, 600), DEFAULT_ROAD_SPEC);
    const over = graph.buildRoad(line(-300, 300, 300, 300), bridge);
    expect(over).toHaveLength(1);
    expect(over[0].spec.level).toBe(1);
    // Nothing was split: the ground road is still one piece, with no junction.
    expect(graph.segments.size).toBe(2);
    // A second bridge across the first goes a level higher; a tunnel goes under both.
    expect(graph.buildRoad(line(-200, 100, 200, 500), bridge)[0].spec.level).toBe(2);
    expect(graph.buildRoad(line(-200, 500, 200, 100), tunnel)[0].spec.level).toBe(-1);
    // A ground road built later under a bridge passes under it too.
    const later = new RoadGraph();
    later.buildRoad(line(-300, 300, 300, 300), bridge);
    expect(later.buildRoad(line(0, 0, 0, 600), DEFAULT_ROAD_SPEC)).toHaveLength(1);
    expect(later.segments.size).toBe(2);
  });

  it("refuse crossings on a ramp, roads too short to climb, and joining part way along", () => {
    const graph = new RoadGraph();
    graph.buildRoad(line(0, 0, 0, 600), DEFAULT_ROAD_SPEC);
    // Crosses the road 20 along: still on its ramp, too low to pass over.
    expect(graph.planRoad(line(-20, 300, 400, 300), bridge).valid).toBe(false);
    expect(graph.planRoad(line(-20, 300, 20, 300), bridge).valid).toBe(false);
    // A short underpass squeezes its ramps in, deep enough where it crosses.
    expect(graph.planRoad(line(-72, 450, 73, 450), tunnel).valid).toBe(true);
    graph.buildRoad(line(-300, 300, 300, 300), bridge);
    // A road ending on the bridge's level middle can't join it.
    expect(graph.planRoad(line(100, 100, 100, 300), DEFAULT_ROAD_SPEC).valid).toBe(false);
    // Nothing placed along it.
    expect(graph.nodeOnRoad({ x: 150, y: 300 })).toBeNull();
  });
});

describe("traffic over and under a bridge", () => {
  it("drives across the bridge at its height while traffic flows under it", async () => {
    const { Simulation, SIM_DT } = await import("./simulation");
    const { DEFAULT_SOURCE, SINK } = await import("./terminal");
    const graph = new RoadGraph();
    graph.buildRoad(line(0, -400, 0, 400), DEFAULT_ROAD_SPEC);
    graph.buildRoad(line(-400, 0, 400, 0), bridge);
    const at = (x: number, y: number) => graph.nodeNear({ x, y }, 1)!.id;
    graph.setTerminal(at(0, -400), { ...DEFAULT_SOURCE, rate: 3 });
    graph.setTerminal(at(0, 400), SINK);
    graph.setTerminal(at(-400, 0), { ...DEFAULT_SOURCE, rate: 3 });
    graph.setTerminal(at(400, 0), SINK);
    const sim = new Simulation(graph);
    sim.parking = false;
    let highest = 0;
    for (let i = 0; i < 120 / SIM_DT; i++) {
      sim.step(SIM_DT);
      for (const car of sim.cars) highest = Math.max(highest, sim.heightOf(car));
    }
    expect(highest).toBeCloseTo(LEVEL_HEIGHT, 0);
    // Both ways through: across the bridge and along the road under it.
    expect(sim.delivered).toBeGreaterThan(6);
  });
});
