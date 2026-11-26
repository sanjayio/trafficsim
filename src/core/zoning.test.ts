import { describe, expect, it } from "vitest";
import { straightCurve } from "./curve";
import { convexOverlap, pointInConvexPolygon } from "./geometry";
import { RoadGraph } from "./roadGraph";
import { DEFAULT_ROAD_SPEC, roadWidth } from "./roadSpec";
import { SIM_DT, Simulation } from "./simulation";
import { BUILDING_TILES, newTerminal, TILE, ZONE_ROWS } from "./terminal";
import { ZoneMap } from "./zoning";

const spec = { ...DEFAULT_ROAD_SPEC, lanes: 2, footpath: true };

describe("zoning tiles", () => {
  it("line both sides of a road, rows deep, and stay clear of junctions", () => {
    const graph = new RoadGraph();
    graph.buildRoad(straightCurve({ x: 0, y: 0 }, { x: 720, y: 0 }), spec);
    const zones = new ZoneMap(graph);
    expect(zones.all()).toHaveLength((720 / TILE) * ZONE_ROWS * 2);
    // The first row starts at the road's edge.
    expect(Math.min(...zones.all().map((t) => Math.abs(t.centre.y)))).toBeCloseTo(roadWidth(spec) / 2 + TILE / 2);

    graph.buildRoad(straightCurve({ x: 360, y: -300 }, { x: 360, y: 300 }), spec);
    const junction = graph.nodeNear({ x: 360, y: 0 }, 1)!;
    const clear = graph.junctionRadius(junction.id) + TILE;
    for (const t of zones.all()) expect(Math.hypot(t.centre.x - junction.x, t.centre.y - junction.y)).toBeGreaterThanOrEqual(clear);
  });

  it("take a building on the tiles it covers, facing the road, with room for another opposite", () => {
    const graph = new RoadGraph();
    graph.buildRoad(straightCurve({ x: 0, y: 0 }, { x: 720, y: 0 }), spec);
    const zones = new ZoneMap(graph);
    // Under the cursor, to the right of the road (south, as world y points down).
    const block = zones.blockAt({ x: 200, y: 40 }, "apartment")!;
    expect(block.fits).toBe(true);
    expect(block.tiles).toHaveLength(BUILDING_TILES.apartment[0] * BUILDING_TILES.apartment[1]);
    expect(zones.place(block, "apartment")).toBe(true);

    const [id, terminal] = [...graph.allTerminals()][0];
    expect(terminal.building).toBe("apartment");
    // The building stands on its block, and those tiles are taken.
    const lot = graph.terminalLot(id)!;
    expect(block.tiles.some((t) => pointInConvexPolygon(lot.centre, t.corners))).toBe(true);
    const taken = zones.all().filter((t) => !t.free);
    expect(taken).toHaveLength(block.tiles.length);
    expect(zones.blockAt({ x: 200, y: 40 }, "villa")!.fits).toBe(false);

    // A villa facing it across the road gets its own driveway point.
    const opposite = zones.blockAt({ x: 200, y: -40 }, "villa")!;
    expect(opposite.fits).toBe(true);
    expect(zones.place(opposite, "villa")).toBe(true);
    expect(graph.allTerminals().size).toBe(2);
  });

  it("never overlap each other, nor let buildings overlap, where roads meet at an angle or curve", () => {
    const graph = new RoadGraph();
    graph.buildRoad(straightCurve({ x: -400, y: 0 }, { x: 400, y: 0 }), spec);
    graph.buildRoad(straightCurve({ x: 0, y: 0 }, { x: 260, y: -300 }), spec);
    graph.buildRoad({ a: { x: -400, y: -60 }, c1: { x: -200, y: -260 }, c2: { x: -100, y: -260 }, b: { x: -60, y: -400 } }, spec);
    const zones = new ZoneMap(graph);
    const tiles = zones.all();
    for (let i = 0; i < tiles.length; i++) {
      for (let j = i + 1; j < tiles.length; j++) {
        if (tiles[i].segment !== tiles[j].segment && convexOverlap(tiles[i].corners, tiles[j].corners)) {
          expect.fail(`tiles of roads ${tiles[i].segment} and ${tiles[j].segment} overlap`);
        }
      }
    }
    // Fill every free spot with villas: none may overlap another, or a road.
    for (const tile of zones.all()) {
      const block = zones.blockAt(tile.centre, "villa");
      if (block?.fits) zones.place(block, "villa");
    }
    const lots = [...graph.allTerminals().keys()].map((id) => graph.lotCorners(id));
    expect(lots.length).toBeGreaterThan(20);
    for (let i = 0; i < lots.length; i++) {
      for (let j = i + 1; j < lots.length; j++) expect(convexOverlap(lots[i], lots[j])).toBe(false);
    }
    // And no free tile is left under a building.
    for (const t of zones.all()) if (t.free) for (const lot of lots) expect(convexOverlap(t.corners, lot)).toBe(false);
  });

  it("fit a wide building across where the road is split for other buildings' driveways", () => {
    const graph = new RoadGraph();
    graph.buildRoad(straightCurve({ x: 0, y: 0 }, { x: 720, y: 0 }), spec);
    const zones = new ZoneMap(graph);
    // Villas along the north side: their driveways split the road every two tiles.
    for (let x = 90; x < 640; x += 36) {
      const block = zones.blockAt({ x, y: -40 }, "villa");
      if (block?.fits) zones.place(block, "villa");
    }
    expect(graph.segments.size).toBeGreaterThan(8);
    // A large shop (4 tiles along) opposite, across several of those splits.
    const block = zones.blockAt({ x: 330, y: 40 }, "largeShop")!;
    expect(block.fits).toBe(true);
    expect(zones.place(block, "largeShop")).toBe(true);
    const lots = [...graph.allTerminals().keys()].map((id) => graph.lotCorners(id));
    for (let i = 0; i < lots.length; i++) {
      for (let j = i + 1; j < lots.length; j++) expect(convexOverlap(lots[i], lots[j])).toBe(false);
    }
  });

  it("give facing villas their own driveways, each in front of its garage, without moving the tiles", () => {
    const graph = new RoadGraph();
    graph.buildRoad(straightCurve({ x: 0, y: 0 }, { x: 720, y: 0 }), spec);
    const zones = new ZoneMap(graph);
    const tiles = () => zones.all().map((t) => t.centre);
    const before = tiles();
    // A row each side, facing each other: the second of each pair finds the middle taken.
    for (let x = 90; x < 640; x += 36) {
      for (const y of [40, -40]) {
        const block = zones.blockAt({ x, y }, "villa");
        if (block?.fits) expect(zones.place(block, "villa")).toBe(true);
      }
    }
    expect(graph.allTerminals().size).toBeGreaterThan(24);
    for (const [, t] of graph.allTerminals()) expect(Math.abs(t.offset ?? 0)).toBeLessThanOrEqual(TILE / 2);
    expect(tiles()).toEqual(before.map((c) => ({ x: expect.closeTo(c.x, 3), y: expect.closeTo(c.y, 3) })));
  });

  it("only let a building be swapped for one that still stands clear", () => {
    const graph = new RoadGraph();
    graph.buildRoad(straightCurve({ x: 0, y: 0 }, { x: 720, y: 0 }), spec);
    const zones = new ZoneMap(graph);
    for (const x of [200, 236, 272]) zones.place(zones.blockAt({ x, y: 40 }, "villa")!, "villa");
    const ids = [...graph.allTerminals().keys()];
    expect(ids).toHaveLength(3);
    const middle = ids.find((id) => Math.abs(graph.terminalLot(id)!.centre.x - 236) < 20)!;
    const villa = graph.terminal(middle)!;
    graph.setTerminal(middle, newTerminal("largeShop", villa.side, villa.offset));
    expect(zones.standsClear(middle)).toBe(false);
    graph.setTerminal(middle, newTerminal("smallShop", villa.side, villa.offset));
    expect(zones.standsClear(middle)).toBe(true);
  });

  it("stand a building on its tiles across where a road drawn in pieces joins", () => {
    // Two pieces joined end to end, the first not a whole number of tiles long.
    const graph = new RoadGraph();
    graph.buildRoad(straightCurve({ x: 0, y: 0 }, { x: 100, y: 0 }), spec);
    graph.buildRoad(straightCurve({ x: 100, y: 0 }, { x: 400, y: 0 }), spec);
    const zones = new ZoneMap(graph);
    const block = zones.blockAt({ x: 100, y: 40 }, "largeShop")!;
    expect(new Set(block.tiles.map((t) => t.segment)).size).toBe(2);
    expect(zones.place(block, "largeShop")).toBe(true);
    const [id] = [...graph.allTerminals().keys()];
    const front = block.tiles.filter((t) => t.row === 0);
    const middle = front.reduce((sum, t) => sum + t.centre.x, 0) / front.length;
    expect(graph.terminalLot(id)!.centre.x).toBeCloseTo(middle, 0);
  });

  it("send cars from a home on its tiles to a shop on others", () => {
    const graph = new RoadGraph();
    graph.buildRoad(straightCurve({ x: 0, y: 0 }, { x: 720, y: 0 }), spec);
    const zones = new ZoneMap(graph);
    zones.place(zones.blockAt({ x: 150, y: 40 }, "apartment")!, "apartment");
    zones.place(zones.blockAt({ x: 560, y: -40 }, "largeShop")!, "largeShop");
    // Busier than a real one, to see several trips in a minute.
    for (const [id, t] of graph.allTerminals()) if (t.kind === "source") graph.setTerminal(id, { ...t, rate: 12 });
    const sim = new Simulation(graph);
    for (let i = 0; i < 60 / SIM_DT; i++) sim.step(SIM_DT);
    expect(sim.delivered).toBeGreaterThan(3);
  });
});
