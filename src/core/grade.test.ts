import { describe, expect, it } from "vitest";
import { straightCurve } from "./curve";
import { heightAlong, LANDING, LEVEL_HEIGHT, levelHeight, minRampLength, RAMP_GRADE, TUNNEL_DEPTH } from "./grade";
import { RoadGraph } from "./roadGraph";
import { DEFAULT_ROAD_SPEC, normalizeRoadSpec, parseRoadSpec } from "./roadSpec";
import { SIM_DT, Simulation } from "./simulation";
import { DEFAULT_SOURCE, SINK } from "./terminal";

const line = (ax: number, ay: number, bx: number, by: number) => straightCurve({ x: ax, y: ay }, { x: bx, y: by });
const at = (level: number) => ({ ...DEFAULT_ROAD_SPEC, level });

describe("bridges and tunnels", () => {
  it("stand at their step's height all along, their nodes too", () => {
    expect(levelHeight(2)).toBe(2 * LEVEL_HEIGHT);
    expect(levelHeight(-1)).toBe(-TUNNEL_DEPTH);
    const graph = new RoadGraph();
    const [road] = graph.buildRoad(line(0, 0, 400, 0), at(2));
    for (const s of [0, 200, 400]) expect(graph.heightAt(road, s)).toBe(2 * LEVEL_HEIGHT);
    expect(graph.nodeHeight(road.a)).toBe(2 * LEVEL_HEIGHT);
    expect(graph.nodeHeight(road.b)).toBe(2 * LEVEL_HEIGHT);
  });

  it("pass over and under roads at other levels, with no junction", () => {
    const graph = new RoadGraph();
    graph.buildRoad(line(0, -300, 0, 300), DEFAULT_ROAD_SPEC);
    expect(graph.buildRoad(line(-300, 0, 300, 0), at(1))).toHaveLength(1);
    expect(graph.buildRoad(line(-300, 100, 300, -100), at(-1))).toHaveLength(1);
    expect(graph.buildRoad(line(-300, -100, 300, 100), at(2))).toHaveLength(1);
    // Nothing was split: four roads, eight ends, no junctions.
    expect(graph.segments.size).toBe(4);
    expect([...graph.nodes.keys()].every((id) => graph.segmentsAt(id).length === 1)).toBe(true);
  });

  it("form junctions with roads at the same step, at that height", () => {
    const graph = new RoadGraph();
    graph.buildRoad(line(-300, 0, 300, 0), at(1));
    graph.buildRoad(line(0, -300, 0, 300), at(1));
    const centre = graph.nodeNear({ x: 0, y: 0 }, 1)!;
    expect(graph.segmentsAt(centre.id)).toHaveLength(4);
    expect(graph.nodeHeight(centre.id)).toBe(LEVEL_HEIGHT);
    // A bridge at that step ending on one forms a T up there.
    graph.buildRoad(line(150, 300, 150, 0), at(1));
    expect(graph.segmentsAt(graph.nodeNear({ x: 150, y: 0 }, 1)!.id)).toHaveLength(3);
  });

  it("join only roads and nodes at their level", () => {
    const graph = new RoadGraph();
    graph.buildRoad(line(-300, 0, 300, 0), at(1));
    // A ground road ending on the bridge, and on its end, joins neither.
    graph.buildRoad(line(0, 300, 0, 0), DEFAULT_ROAD_SPEC);
    graph.buildRoad(line(300, 300, 300, 0), DEFAULT_ROAD_SPEC);
    expect([...graph.nodes.keys()].every((id) => graph.segmentsAt(id).length === 1)).toBe(true);
    expect(graph.nodeNear({ x: 300, y: 0 }, 1, 0)).toBeDefined();
    expect(graph.nodeNear({ x: 300, y: 0 }, 1, 1)).toBeDefined();
    // No buildings up on it.
    const end = graph.nodeNear({ x: -300, y: 0 }, 1, 1)!;
    graph.setTerminal(end.id, DEFAULT_SOURCE);
    expect(graph.terminal(end.id)).toBeUndefined();
  });

  it("have no footpaths, trees or median in tunnels (on bridges they do)", () => {
    const full = { ...DEFAULT_ROAD_SPEC, footpath: true, trees: true, median: true };
    const graph = new RoadGraph();
    const [tunnel] = graph.buildRoad(line(0, 0, 400, 0), { ...full, level: -1 });
    expect(tunnel.spec).toMatchObject({ footpath: false, median: false });
    expect(tunnel.spec.trees).toBeUndefined();
    expect(normalizeRoadSpec({ ...full, level: 1 })).toMatchObject({ footpath: true, median: true, trees: true });
  });

  it("go up three steps and down three", () => {
    expect(() => parseRoadSpec({ ...DEFAULT_ROAD_SPEC, level: 3 })).not.toThrow();
    expect(() => parseRoadSpec({ ...DEFAULT_ROAD_SPEC, level: -4 })).toThrow();
  });
});

const ramp = (from: number, to: number) => ({ ...DEFAULT_ROAD_SPEC, from, level: to });

describe("ramps", () => {
  it("run level at each end and climb at one gradient between", () => {
    expect(heightAlong(0, 1, 0)).toBe(0);
    expect(heightAlong(0, 1, LANDING)).toBe(0);
    expect(heightAlong(0, 1, LANDING + 30)).toBeCloseTo(30 * RAMP_GRADE);
    expect(heightAlong(0, 1, 500)).toBe(LEVEL_HEIGHT);
    expect(heightAlong(2, 0, 500)).toBe(0);
    expect(minRampLength(0, 2)).toBeCloseTo(2 * LANDING + (2 * LEVEL_HEIGHT) / RAMP_GRADE);
    expect(minRampLength(0, -1)).toBeCloseTo(2 * LANDING + TUNNEL_DEPTH / RAMP_GRADE);
  });

  it("join a ground road to a bridge, each node keeping its height", () => {
    const graph = new RoadGraph();
    graph.buildRoad(line(0, 0, 200, 0), DEFAULT_ROAD_SPEC);
    graph.buildRoad(line(500, 0, 800, 0), at(1));
    expect(graph.buildRoad(line(200, 0, 500, 0), ramp(0, 1))).toHaveLength(1);
    const node = (x: number) => graph.nodeNear({ x, y: 0 }, 1)!.id;
    expect(graph.segmentsAt(node(200))).toHaveLength(2);
    expect(graph.segmentsAt(node(500))).toHaveLength(2);
    expect(graph.nodeHeight(node(200))).toBe(0);
    expect(graph.nodeHeight(node(500))).toBe(LEVEL_HEIGHT);
  });

  it("are refused too short for their climb", () => {
    const graph = new RoadGraph();
    expect(graph.planRoad(line(0, 0, minRampLength(0, 1) - 5, 0), ramp(0, 1)).valid).toBe(false);
    expect(graph.planRoad(line(0, 0, minRampLength(0, 1) + 5, 0), ramp(0, 1)).valid).toBe(true);
  });

  it("pass over or under roads with headroom, and are refused too close to one", () => {
    const graph = new RoadGraph();
    graph.buildRoad(line(0, 0, 300, 0), ramp(0, 1));
    // At 30 along it's barely off the ground: a step-2 bridge clears it, a step-1 one doesn't.
    expect(graph.planRoad(line(30, -100, 30, 100), at(2)).valid).toBe(true);
    expect(graph.planRoad(line(50, -100, 50, 100), at(1)).valid).toBe(false);
    // Nor can a road end on its slope.
    expect(graph.planRoad(line(60, -100, 60, 0), DEFAULT_ROAD_SPEC).valid).toBe(false);
  });

  it("have no footpaths, trees or median going below ground", () => {
    const graph = new RoadGraph();
    const [down] = graph.buildRoad(line(0, 0, 300, 0), { ...ramp(0, -1), footpath: true, trees: true, median: true });
    expect(down.spec).toMatchObject({ footpath: false, median: false, from: 0, level: -1 });
  });

  it("carry cars up and down at the road's height", () => {
    const graph = new RoadGraph();
    // Ground, up a ramp, over a bridge, down a ramp, ground.
    graph.buildRoad(line(0, 0, 100, 0), DEFAULT_ROAD_SPEC);
    graph.buildRoad(line(100, 0, 300, 0), ramp(0, 1));
    graph.buildRoad(line(300, 0, 500, 0), at(1));
    graph.buildRoad(line(500, 0, 700, 0), ramp(1, 0));
    graph.buildRoad(line(700, 0, 800, 0), DEFAULT_ROAD_SPEC);
    const node = (x: number) => graph.nodeNear({ x, y: 0 }, 1)!.id;
    graph.setTerminal(node(0), { ...DEFAULT_SOURCE, rate: 20 });
    graph.setTerminal(node(800), SINK);
    const sim = new Simulation(graph);
    sim.parking = false;
    const heights: number[] = [];
    for (let t = 0; t < 40 / SIM_DT; t++) {
      sim.step(SIM_DT);
      for (const car of sim.cars) heights.push(sim.heightOf(car));
    }
    // Some cars part way up (or down) a ramp, some on the bridge.
    expect(heights.some((h) => h > 1 && h < LEVEL_HEIGHT - 1)).toBe(true);
    expect(heights).toContain(LEVEL_HEIGHT);
  });
});

