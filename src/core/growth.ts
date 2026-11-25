import { pointInConvexPolygon, type Vec2 } from "./geometry";
import type { NodeId, RoadGraph } from "./roadGraph";
import { levelOf, MAX_LEVEL, sourceRate, TILE, type Terminal } from "./terminal";
import type { ZoneMap } from "./zoning";

/**
 * Takes the building at `nodeId` up a level. Levels 2 and 4 try to widen it by a tile (to
 * either side) where that keeps it on zoning tiles, clear of roads and other buildings;
 * otherwise, and at levels 3 and 5, it grows taller on the same footprint. A home sends out
 * more cars at each level (see `sourceRate`), an office parks more (see `levelFactor`). False if already at the top.
 */
export function levelUp(graph: RoadGraph, zones: ZoneMap, nodeId: NodeId): boolean {
  const t = graph.terminal(nodeId);
  if (!t || levelOf(t) >= MAX_LEVEL) return false;
  const level = levelOf(t) + 1;
  const up = <T extends Terminal>(next: T): T => (next.kind === "source" ? { ...next, rate: sourceRate(next.building, level) } : next);
  if (level % 2 === 0) {
    const wide = (t.wide ?? 0) + 1;
    const offsets = t.offset === undefined ? [undefined] : [t.offset + TILE / 2, t.offset - TILE / 2];
    for (const offset of offsets) {
      graph.setTerminal(nodeId, up({ ...t, level, wide, ...(offset === undefined ? {} : { offset }) }));
      if (zones.standsClear(nodeId) && onTiles(graph, zones, nodeId)) return true;
    }
  }
  graph.setTerminal(nodeId, up({ ...t, level }));
  return true;
}

/** Whether the building at `nodeId` stands on zoning tiles (each corner, pulled in a little, on one). */
function onTiles(graph: RoadGraph, zones: ZoneMap, nodeId: NodeId): boolean {
  const corners = graph.lotCorners(nodeId);
  const middle = corners.reduce((m, c) => ({ x: m.x + c.x / corners.length, y: m.y + c.y / corners.length }), { x: 0, y: 0 });
  const tiles = zones.all();
  return corners.every((c) => {
    const d = Math.hypot(middle.x - c.x, middle.y - c.y) || 1;
    const p: Vec2 = { x: c.x + ((middle.x - c.x) / d) * 1.5, y: c.y + ((middle.y - c.y) / d) * 1.5 };
    return tiles.some((tile) => pointInConvexPolygon(p, tile.corners));
  });
}
