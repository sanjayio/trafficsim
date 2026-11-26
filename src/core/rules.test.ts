import { describe, expect, it } from "vitest";
import { straightCurve } from "./curve";
import { signalLights } from "./junction";
import { RoadGraph, type SavedMap } from "./roadGraph";
import { DEFAULT_ROAD_SPEC } from "./roadSpec";
import { DEFAULT_RULES, matchingPreset, parseRules, presetRules } from "./rules";
import { SIM_DT, Simulation } from "./simulation";
import { DEFAULT_SOURCE, SINK } from "./terminal";

describe("parseRules", () => {
  it("fills in defaults, keeps numbers in range, and rejects orders that don't list each choice once", () => {
    const rules = parseRules({
      following: { headway: 99, accel: "fast" },
      junctions: { rightOfWay: ["minor", "mainThrough", "mainTurning"], turnOrder: ["straight", "straight", "kerb"] },
      trips: { parkMin: 200, parkMax: 50 },
    });
    expect(rules.following.headway).toBe(3);
    expect(rules.following.accel).toBe(DEFAULT_RULES.following.accel);
    expect(rules.junctions.rightOfWay).toEqual(["minor", "mainThrough", "mainTurning"]);
    expect(rules.junctions.turnOrder).toEqual(DEFAULT_RULES.junctions.turnOrder);
    expect(rules.trips.parkMax).toBe(200);
    expect(parseRules(undefined)).toEqual(DEFAULT_RULES);
    expect(parseRules("nonsense")).toEqual(DEFAULT_RULES);
  });

  it("knows which preset rules match", () => {
    expect(matchingPreset(DEFAULT_RULES)).toBe("default");
    expect(matchingPreset(presetRules("polite"))).toBe("polite");
    expect(matchingPreset({ ...DEFAULT_RULES, signals: { green: 12, amber: 2 } })).toBeNull();
  });
});

describe("rules on a map", () => {
  const map = () => {
    const graph = new RoadGraph();
    graph.buildRoad(straightCurve({ x: 0, y: 0 }, { x: 400, y: 0 }), DEFAULT_ROAD_SPEC);
    graph.setTerminal(graph.nodeNear({ x: 0, y: 0 }, 1)!.id, { ...DEFAULT_SOURCE, rate: 30 });
    graph.setTerminal(graph.nodeNear({ x: 400, y: 0 }, 1)!.id, SINK);
    return graph;
  };

  it("are saved only when changed, and load back", () => {
    const graph = map();
    expect(graph.toJSON().rules).toBeUndefined();
    graph.setRules(presetRules("aggressive"));
    const saved = JSON.parse(JSON.stringify(graph.toJSON())) as SavedMap;
    const loaded = new RoadGraph();
    loaded.load(saved);
    expect(loaded.rules).toEqual(presetRules("aggressive"));
    // Older maps have none: the defaults.
    loaded.load({ ...saved, rules: undefined });
    expect(loaded.rules).toEqual(DEFAULT_RULES);
  });

  it("change live, without clearing the cars on the road", () => {
    const graph = map();
    const sim = new Simulation(graph);
    sim.parking = false;
    for (let i = 0; i < 8 / SIM_DT; i++) sim.step(SIM_DT);
    const cars = [...sim.cars];
    expect(cars.length).toBeGreaterThan(0);
    graph.setRules(presetRules("polite"));
    expect(sim.cars).toEqual(cars);
  });

  it("set how long the lights stay green", () => {
    const timing = { ...DEFAULT_RULES.signals, green: 20 };
    expect(signalLights(2, 15, timing)[0]).toBe("green");
    expect(signalLights(2, 15, DEFAULT_RULES.signals)[0]).not.toBe("green");
  });
});
