import type { Mesh } from "three";
import { describe, expect, it } from "vitest";
import { straightCurve } from "../core/curve";
import type { Vec2 } from "../core/geometry";
import { connectionsAt, turnAt } from "../core/lanes";
import { RoadGraph, type NodeId } from "../core/roadGraph";
import { carriagewayWidth, DEFAULT_ROAD_SPEC } from "../core/roadSpec";
import { CAR_WIDTH } from "../core/simulation";
import { legAt, legLength, TrackBuilder } from "../core/track";
import { RoadLayer } from "./RoadLayer";

const spec = { ...DEFAULT_ROAD_SPEC, lanes: 2 };

/** Junction shapes: each a list of roads (from, to) meeting at one point. */
const SHAPES: Record<string, [Vec2, Vec2][]> = {
  crossroads: [
    [{ x: -300, y: 0 }, { x: 300, y: 0 }],
    [{ x: 0, y: -300 }, { x: 0, y: 300 }],
  ],
  skewed: [
    [{ x: -429, y: 286 }, { x: 471, y: -314 }],
    [{ x: -529, y: -34 }, { x: 571, y: 36 }],
  ],
  "acute arm": [
    [{ x: -300, y: 0 }, { x: 300, y: 0 }],
    [{ x: 0, y: 0 }, { x: -260, y: 150 }],
  ],
  "T-junction": [
    [{ x: -300, y: 0 }, { x: 300, y: 0 }],
    [{ x: 0, y: 0 }, { x: 0, y: 300 }],
  ],
};

/**
 * Whether every point is on the pavement: a road's surface, or the corners the road layer paves
 * where they meet (read back from its meshes).
 */
function pavement(graph: RoadGraph, roads: RoadLayer, node: NodeId): (p: Vec2) => boolean {
  const triangles: Vec2[][] = [];
  for (const mesh of (roads as unknown as { junctions: Map<NodeId, Mesh[]> }).junctions.get(node) ?? []) {
    const position = mesh.geometry.getAttribute("position");
    const index = mesh.geometry.getIndex()!;
    for (let i = 0; i < index.count; i += 3) {
      triangles.push([0, 1, 2].map((k) => ({ x: position.getX(index.getX(i + k)), y: position.getZ(index.getX(i + k)) })));
    }
  }
  const inside = (p: Vec2, [a, b, c]: Vec2[]) => {
    const side = (u: Vec2, v: Vec2) => (v.x - u.x) * (p.y - u.y) - (v.y - u.y) * (p.x - u.x);
    const [d1, d2, d3] = [side(a, b), side(b, c), side(c, a)];
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  };
  return (p) =>
    triangles.some((t) => inside(p, t)) ||
    [...graph.segments.values()].some((s) => graph.path(s).distanceTo(p) <= carriagewayWidth(s.spec) / 2);
}

describe("paths through junctions", () => {
  for (const [name, lines] of Object.entries(SHAPES)) {
    for (const smoothness of [0, 16, 40]) {
      it(`keep cars on the pavement: ${name}, corner smoothness ${smoothness}`, () => {
        const graph = new RoadGraph();
        for (const [a, b] of lines) graph.buildRoad(straightCurve(a, b), spec);
        const node = graph.nodeNear({ x: 0, y: 0 }, 2)!.id;
        graph.setJunction(node, { cornerRadius: smoothness });
        const roads = new RoadLayer(graph);
        const paved = pavement(graph, roads, node);
        const tracks = new TrackBuilder(graph, (s, n) => roads.stopLineAt(s, n));
        for (const c of connectionsAt(graph, node)) {
          const into = graph.segments.get(c.from.segment)!;
          const out = graph.segments.get(c.to.segment)!;
          const inLeg = tracks.roadLeg(into, into.a === node ? into.b : into.a, c.from.lane);
          const outLeg = tracks.roadLeg(out, node, c.to.lane);
          const leg = tracks.junctionLeg(node, inLeg, outLeg, c.from.lane, c.to.lane, turnAt(graph, node, into, out));
          // Both sides of the car, all the way through.
          for (let s = 0; s <= legLength(leg); s += 1) {
            const f = legAt(leg, s);
            for (const side of [-1, 1]) {
              const p = { x: f.p.x + (f.normal.x * side * CAR_WIDTH) / 2, y: f.p.y + (f.normal.y * side * CAR_WIDTH) / 2 };
              if (!paved(p)) expect.fail(`${turnAt(graph, node, into, out)} turn leaves the road ${s.toFixed(0)} into the junction`);
            }
          }
        }
        roads.dispose();
      });
    }
  }
});
