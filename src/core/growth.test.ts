import { describe, expect, it } from "vitest";
import { straightCurve } from "./curve";
import { levelUp } from "./growth";
import { RoadGraph } from "./roadGraph";
import { DEFAULT_ROAD_SPEC } from "./roadSpec";
import { buildingSize, headsTo, LEVEL_NEEDS, levelOf, MAX_LEVEL, newTerminal, parseTerminal, type Source } from "./terminal";
import { ZoneMap } from "./zoning";

const spec = { ...DEFAULT_ROAD_SPEC, footpath: true };

/** A long road with a large shop on its tiles; and, if `hemmed`, a small office either side of it. */
function street(hemmed: boolean): { graph: RoadGraph; zones: ZoneMap; shop: number } {
  const graph = new RoadGraph();
  graph.buildRoad(straightCurve({ x: 0, y: 0 }, { x: 900, y: 0 }), spec);
  const zones = new ZoneMap(graph);
  zones.place(zones.blockAt({ x: 450, y: 40 }, "largeShop")!, "largeShop");
  const shop = [...graph.allTerminals().keys()][0];
  if (hemmed) {
    const [, x0] = [0, graph.terminalLot(shop)!.centre.x];
    const half = buildingSize(graph.terminal(shop)!).length / 2;
    for (const x of [x0 - half - 20, x0 + half + 20]) zones.place(zones.blockAt({ x, y: 40 }, "smallOffice")!, "smallOffice");
  }
  return { graph, zones, shop };
}

describe("levelUp", () => {
  it("widens a building by a tile where there's room, and grows it taller on the next level", () => {
    const { graph, zones, shop } = street(false);
    const before = buildingSize(graph.terminal(shop)!).length;
    expect(levelUp(graph, zones, shop)).toBe(true);
    const t = graph.terminal(shop)!;
    expect([levelOf(t), t.wide]).toEqual([2, 1]);
    expect(buildingSize(t).length).toBeGreaterThan(before);
    expect(zones.standsClear(shop)).toBe(true);
    levelUp(graph, zones, shop);
    expect([levelOf(graph.terminal(shop)!), graph.terminal(shop)!.wide]).toEqual([3, 1]);
  });

  it("grows a hemmed-in building taller instead, and stops at the top level", () => {
    const { graph, zones, shop } = street(true);
    expect(graph.allTerminals().size).toBe(3);
    for (let i = 0; i < MAX_LEVEL + 2; i++) levelUp(graph, zones, shop);
    const t = graph.terminal(shop)!;
    expect([levelOf(t), t.wide ?? 0]).toEqual([MAX_LEVEL, 0]);
    expect(zones.standsClear(shop)).toBe(true);
  });

  it("counts customers quietly, and says when a building is due its next level", () => {
    const { graph, shop } = street(false);
    let events = 0;
    graph.subscribe(() => events++);
    const due = Array.from({ length: LEVEL_NEEDS[1] }, () => graph.recordVisit(shop));
    expect(due.filter(Boolean)).toHaveLength(1);
    expect(due[LEVEL_NEEDS[1] - 1]).toBe(true);
    expect(events).toBe(0);
  });
});

describe("building details", () => {
  it("survive save and load, and bad values are refused", () => {
    const t = { ...newTerminal("smallShop"), name: "Corner Mart", colors: { primary: 0x123456, secondary: 0xabcdef }, level: 3, wide: 1, served: 80 };
    expect(parseTerminal(JSON.parse(JSON.stringify(t)))).toEqual(t);
    expect(levelOf(parseTerminal(newTerminal("villa")))).toBe(1);
    for (const bad of [{ level: 9 }, { level: 0 }, { wide: 2, level: 2 }, { name: "x".repeat(40) }, { colors: { primary: -1, secondary: 0 } }, { served: 1.5 }]) {
      expect(() => parseTerminal({ ...newTerminal("smallShop"), ...bad })).toThrow();
    }
  });
});

describe("home destinations", () => {
  it("send cars to any, only shops, only offices, or the ones picked", () => {
    const home = newTerminal("villa") as Source;
    const pairs = [[1, "smallShop"], [2, "largeOffice"]] as const;
    const goes = (h: Source) => pairs.filter(([id, b]) => headsTo(h, id, b)).map(([id]) => id);
    expect(goes(home)).toEqual([1, 2]);
    expect(goes({ ...home, to: "shops" })).toEqual([1]);
    expect(goes({ ...home, to: "offices" })).toEqual([2]);
    expect(goes({ ...home, to: "custom", sinks: [2] })).toEqual([2]);
    // Older maps: a list of picks without `to` is a custom choice.
    expect(goes({ ...home, sinks: [1] })).toEqual([1]);
  });
});
