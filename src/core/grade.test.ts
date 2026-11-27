import { describe, expect, it } from "vitest";
import { straightCurve } from "./curve";
import { LEVEL_HEIGHT, levelHeight, TUNNEL_DEPTH } from "./grade";
import { RoadGraph } from "./roadGraph";
import { DEFAULT_ROAD_SPEC, normalizeRoadSpec, parseRoadSpec } from "./roadSpec";
import { DEFAULT_SOURCE } from "./terminal";

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
