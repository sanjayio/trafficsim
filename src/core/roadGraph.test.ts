import { describe, expect, it } from "vitest";
import { straightCurve } from "./curve";
import { RoadGraph } from "./roadGraph";
import { DEFAULT_ROAD_SPEC } from "./roadSpec";

const road = (graph: RoadGraph, ax: number, ay: number, bx: number, by: number) =>
  graph.buildRoad(straightCurve({ x: ax, y: ay }, { x: bx, y: by }), DEFAULT_ROAD_SPEC);

/** Two roads crossing at (100, 100): a four-way junction. */
function crossroads(): RoadGraph {
  const graph = new RoadGraph();
  road(graph, 0, 100, 200, 100);
  road(graph, 100, 0, 100, 200);
  return graph;
}

describe("RoadGraph", () => {
  it("splits both roads where they cross", () => {
    const graph = crossroads();
    expect(graph.segments.size).toBe(4);
    const centre = graph.nodeNear({ x: 100, y: 100 }, 1)!;
    expect(graph.segmentsAt(centre.id)).toHaveLength(4);
  });

  it("saves and loads the same map", () => {
    const graph = crossroads();
    const centre = graph.nodeNear({ x: 100, y: 100 }, 1)!;
    graph.setJunction(centre.id, { roundabout: true });
    const saved = JSON.parse(JSON.stringify(graph.toJSON()));
    const loaded = new RoadGraph();
    loaded.load(saved);
    expect(loaded.toJSON()).toEqual(graph.toJSON());
    expect(loaded.segmentsAt(centre.id)).toHaveLength(4);
  });

  it("drops a junction's settings once fewer than three roads meet there", () => {
    const graph = crossroads();
    const centre = graph.nodeNear({ x: 100, y: 100 }, 1)!;
    graph.setJunction(centre.id, { cornerRadius: 40 });
    const [first, second] = graph.segmentsAt(centre.id);
    graph.removeSegment(first.id);
    expect(graph.junction(centre.id).cornerRadius).toBe(40);
    graph.removeSegment(second.id);
    expect(graph.toJSON().junctions).toEqual([]);
  });

  it("keeps the map's name, with a default and a length limit", () => {
    const named = new RoadGraph();
    named.load({ version: 3, name: "Harbour Town", nodes: [], segments: [] });
    expect(named.toJSON().name).toBe("Harbour Town");
    const old = new RoadGraph();
    old.load({ version: 3, nodes: [], segments: [] });
    expect(old.name).toBe("Untitled map");
    expect(() => new RoadGraph().load({ version: 3, name: "x".repeat(61), nodes: [], segments: [] })).toThrow();
  });

  it("rejects maps with bad or duplicate ids and coordinates", () => {
    const map = crossroads().toJSON();
    const broken = [
      { ...map, nodes: [...map.nodes, { ...map.nodes[0] }] },
      { ...map, nodes: map.nodes.map((n, i) => (i ? n : { ...n, x: null })) },
      { ...map, nodes: map.nodes.map((n, i) => (i ? n : { ...n, id: "a" })) },
      { ...map, segments: [...map.segments, { ...map.segments[0] }] },
      { ...map, segments: map.segments.map((s, i) => (i ? s : { ...s, b: s.a })) },
    ];
    for (const bad of broken) {
      const graph = crossroads();
      expect(() => graph.load(bad as never)).toThrow();
      expect(graph.segments.size).toBe(4);
    }

    // Fails on its last check (a building on a missing node): nothing about the current map changes.
    const graph = crossroads();
    const late = { ...map, name: "Other town", drivingSide: "left", terminals: [{ node: 9999, kind: "sink" }] };
    expect(() => graph.load(late as never)).toThrow();
    expect([graph.name, graph.drivingSide]).toEqual([map.name ?? "Untitled map", map.drivingSide ?? "right"]);
  });
});
