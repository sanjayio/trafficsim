import { describe, expect, it } from "vitest";
import { straightCurve } from "./curve";
import { RoadGraph, type SavedMap } from "./roadGraph";
import { DEFAULT_ROAD_SPEC, roadWidth } from "./roadSpec";
import { SceneryKeeper, type Plant } from "./scenery";
import { DEFAULT_SOURCE } from "./terminal";

const road = (graph: RoadGraph, ax: number, ay: number, bx: number, by: number) =>
  graph.buildRoad(straightCurve({ x: ax, y: ay }, { x: bx, y: by }), DEFAULT_ROAD_SPEC);

/** A graph whose scenery is looked after, as in the game. */
function kept(): RoadGraph {
  const graph = new RoadGraph();
  new SceneryKeeper(graph);
  return graph;
}

/** Whether a plant stands on any road (its road and footpaths). */
const onAnyRoad = (graph: RoadGraph, p: Plant) =>
  [...graph.segments.values()].some((s) => graph.drawnPath(s).nearest(p).distance < roadWidth(s.spec) / 2);

describe("scenery", () => {
  it("plants clusters beside a new road, none on it, the same each time", () => {
    const plant = () => {
      const graph = kept();
      road(graph, 0, 0, 600, 0);
      return graph;
    };
    const graph = plant();
    expect(graph.scenery.length).toBeGreaterThan(20);
    expect(graph.scenery.some((p) => onAnyRoad(graph, p))).toBe(false);
    // Beside it: within the band either side.
    expect(graph.scenery.every((p) => Math.abs(p.y) < 90)).toBe(true);
    expect(graph.scenery.some((p) => p.y > 0) && graph.scenery.some((p) => p.y < 0)).toBe(true);
    expect(plant().scenery).toEqual(graph.scenery);
  });

  it("clears the plants a new road crosses, and its junction", () => {
    const graph = kept();
    road(graph, 0, 0, 600, 0);
    road(graph, 300, -300, 300, 300);
    expect(graph.scenery.some((p) => onAnyRoad(graph, p))).toBe(false);
    const centre = graph.nodeNear({ x: 300, y: 0 }, 1)!;
    expect(graph.scenery.some((p) => Math.hypot(p.x - centre.x, p.y - centre.y) < graph.junctionRadius(centre.id) + 4)).toBe(false);
  });

  it("clears a building's lot, and doesn't grow back when the road goes", () => {
    const graph = kept();
    road(graph, 0, 0, 600, 0);
    const home = graph.nodeOnRoad({ x: 300, y: 10 })!;
    graph.setTerminal(home.id, { ...DEFAULT_SOURCE, side: 1 });
    const lot = graph.terminalLot(home.id)!;
    const onLot = (p: Plant) => {
      const u = (p.x - lot.centre.x) * lot.along.x + (p.y - lot.centre.y) * lot.along.y;
      const w = (p.x - lot.centre.x) * lot.out.x + (p.y - lot.centre.y) * lot.out.y;
      return Math.abs(u) < lot.length / 2 && Math.abs(w) < lot.depth / 2;
    };
    expect(graph.scenery.some(onLot)).toBe(false);
    const before = graph.scenery.length;
    for (const segment of [...graph.segments.values()]) graph.removeSegment(segment.id);
    expect(graph.scenery.length).toBe(before);
  });

  it("is saved with the map; a map from before scenery is planted once when it's opened", () => {
    const graph = kept();
    road(graph, 0, 0, 600, 0);
    const saved = JSON.parse(JSON.stringify(graph.toJSON())) as SavedMap;
    const loaded = kept();
    loaded.load(saved);
    expect(loaded.scenery).toEqual(graph.scenery.map((p) => ({ ...p, x: expect.closeTo(p.x, 1), y: expect.closeTo(p.y, 1), size: expect.closeTo(p.size, 2), turn: expect.closeTo(p.turn, 2) })));

    // Saved with none (all cleared): stays bare.
    const bare = kept();
    bare.load({ ...saved, scenery: [] });
    expect(bare.scenery).toEqual([]);

    // From before scenery: planted on opening.
    const old = kept();
    old.load({ ...saved, scenery: undefined });
    expect(old.scenery.length).toBeGreaterThan(20);
    expect(old.scenery.some((p) => onAnyRoad(old, p))).toBe(false);
  });
});
