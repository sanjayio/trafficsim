import { describe, expect, it } from "vitest";
import { straightCurve } from "../core/curve";
import { LEVEL_HEIGHT } from "../core/grade";
import { RoadGraph } from "../core/roadGraph";
import { DEFAULT_ROAD_SPEC } from "../core/roadSpec";
import { snapPoint } from "./snapping";

describe("snapping a road's end", () => {
  it("finds a node at another level where it's seen, for a ramp", () => {
    const graph = new RoadGraph();
    graph.buildRoad(straightCurve({ x: 0, y: 0 }, { x: 300, y: 0 }), { ...DEFAULT_ROAD_SPEC, level: 1 });
    // Laying ground roads: the pointer on the ground is well off the bridge's end, but on the
    // bridge's level (as seen from an angle) it's right by it.
    const pointerAt = (height: number) => (height === LEVEL_HEIGHT ? { x: 302, y: 1 } : { x: 330, y: 40 });
    const snapped = snapPoint({ x: 330, y: 40 }, { graph, grid: false, guides: false, tolerance: 8, isRoadEnd: true, level: 0, pointerAt });
    expect(snapped.point).toEqual({ x: 300, y: 0 });
    expect(snapped.level).toBe(1);
  });
});
