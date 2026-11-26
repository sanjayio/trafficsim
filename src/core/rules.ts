/**
 * The traffic rules: every tunable part of how cars drive, give way and choose their way, saved
 * with the map so players can experiment. The simulation reads them live, every step.
 */

/** Who goes first at a stop or give-way junction, highest first. */
export const RIGHT_OF_WAY = ["mainThrough", "mainTurning", "minor"] as const;
export type RightOfWay = (typeof RIGHT_OF_WAY)[number];

/** Which turns go first when movements cross (on the same green, or both on the main road), highest first. */
export const TURN_ORDER = ["straight", "kerb", "across"] as const;
export type TurnPriority = (typeof TURN_ORDER)[number];

/** How a car compares the lanes it could take on a road, most important first (see `planLanes`). */
export const LANE_CRITERIA = ["fewestChanges", "keepLane", "leastCongested"] as const;
export type LaneCriterion = (typeof LANE_CRITERIA)[number];

export interface TrafficRules {
  following: { accel: number; brake: number; minGap: number; headway: number };
  junctions: {
    rightOfWay: RightOfWay[];
    turnOrder: TurnPriority[];
    amberStopIfSafe: boolean;
    gridlockCheck: boolean;
    stopHold: number;
    yieldHorizon: number;
    ringGap: number;
    giveWayTime: number;
    turnInGap: number;
  };
  signals: { green: number; amber: number };
  lanes: { order: LaneCriterion[]; lookahead: number; congestionAware: boolean; sight: number };
  laneChange: {
    minSafeGap: number;
    reaction: number;
    urgency: boolean;
    minReaction: number;
    urgencyStart: number;
    deadlockReroute: boolean;
    rerouteWait: number;
    stuckChange: boolean;
    stuckAfter: number;
  };
  routing: { speedLimits: boolean; turnKerb: number; turnAcross: number; delayNone: number; delayYield: number; delayStop: number; delaySignals: number };
  trips: { parkMin: number; parkMax: number; signalAhead: number };
}

export type RuleSection = keyof TrafficRules;

export const DEFAULT_RULES: TrafficRules = {
  following: { accel: 15, brake: 25, minGap: 3, headway: 0.9 },
  junctions: {
    rightOfWay: [...RIGHT_OF_WAY],
    turnOrder: [...TURN_ORDER],
    amberStopIfSafe: true,
    gridlockCheck: true,
    stopHold: 0.5,
    yieldHorizon: 3,
    ringGap: 2,
    giveWayTime: 2.5,
    turnInGap: 3,
  },
  signals: { green: 8, amber: 2 },
  lanes: { order: [...LANE_CRITERIA], lookahead: 3, congestionAware: true, sight: 150 },
  laneChange: { minSafeGap: 6, reaction: 1.4, urgency: true, minReaction: 0.4, urgencyStart: 200, deadlockReroute: true, rerouteWait: 15, stuckChange: true, stuckAfter: 10 },
  routing: { speedLimits: true, turnKerb: 2, turnAcross: 5, delayNone: 0.5, delayYield: 1, delayStop: 3, delaySignals: 4 },
  trips: { parkMin: 20, parkMax: 100, signalAhead: 60 },
};

type Patch = { [S in RuleSection]?: Partial<TrafficRules[S]> };

/** Named starting points, from calm to reckless drivers; each changes a few rules from Standard (the default). */
export const PRESETS: { id: string; label: string; patch: Patch }[] = [
  {
    id: "chill",
    label: "Chill",
    patch: {
      following: { headway: 1.6, minGap: 5, accel: 10 },
      junctions: { stopHold: 1.5, yieldHorizon: 5, ringGap: 3, giveWayTime: 4, turnInGap: 4.5 },
      lanes: { order: ["keepLane", "fewestChanges", "leastCongested"] },
      laneChange: { reaction: 2, minSafeGap: 9, urgencyStart: 100, rerouteWait: 25 },
    },
  },
  { id: "standard", label: "Standard", patch: {} },
  {
    id: "hurry",
    label: "Hurry",
    patch: {
      following: { headway: 0.7, minGap: 2, accel: 20, brake: 32 },
      junctions: { stopHold: 0.2, yieldHorizon: 2, ringGap: 1.5, giveWayTime: 1.8, turnInGap: 2 },
      lanes: { order: ["fewestChanges", "leastCongested", "keepLane"] },
      laneChange: { reaction: 1, minSafeGap: 4, urgencyStart: 300, rerouteWait: 10 },
    },
  },
  {
    id: "madMax",
    label: "Mad Max",
    patch: {
      following: { headway: 0.4, minGap: 1, accel: 30, brake: 50 },
      junctions: { stopHold: 0, yieldHorizon: 1, ringGap: 0.8, giveWayTime: 1, turnInGap: 1.2, amberStopIfSafe: false },
      lanes: { order: ["leastCongested", "fewestChanges", "keepLane"] },
      laneChange: { reaction: 0.5, minSafeGap: 2, minReaction: 0.1, urgencyStart: 400, rerouteWait: 6 },
    },
  },
];

export function applyPatch(base: TrafficRules, patch: Patch): TrafficRules {
  const out = structuredClone(base);
  for (const section of Object.keys(patch) as RuleSection[]) Object.assign(out[section], patch[section]);
  return out;
}

export function presetRules(id: string): TrafficRules {
  return applyPatch(DEFAULT_RULES, PRESETS.find((p) => p.id === id)?.patch ?? {});
}

/** The preset `rules` match exactly, or null when they've been changed from any. */
export function matchingPreset(rules: TrafficRules): string | null {
  const json = JSON.stringify(rules);
  return PRESETS.find((p) => JSON.stringify(presetRules(p.id)) === json)?.id ?? null;
}

export type RuleField =
  | { kind: "number"; section: RuleSection; key: string; label: string; help: string; min: number; max: number; step: number; unit: string }
  | { kind: "toggle"; section: RuleSection; key: string; label: string; help: string }
  | { kind: "order"; section: RuleSection; key: string; label: string; help: string; items: Record<string, string> };

/** How each rule is shown in Settings, and the range it's kept to. Grouped by section, in display order. */
export const RULE_SECTIONS: { section: RuleSection; title: string; fields: RuleField[] }[] = [
  {
    section: "junctions",
    title: "Junctions",
    fields: [
      {
        kind: "order",
        section: "junctions",
        key: "rightOfWay",
        label: "Right of way",
        help: "At stop and give-way junctions, who goes first when paths cross.",
        items: { mainThrough: "Main road, straight on", mainTurning: "Main road, turning", minor: "Side road" },
      },
      {
        kind: "order",
        section: "junctions",
        key: "turnOrder",
        label: "Turn priority",
        help: "On the same green (or both on the main road), which movement goes first.",
        items: { straight: "Straight on", kerb: "Turning kerb-side", across: "Turning across traffic" },
      },
      { kind: "toggle", section: "junctions", key: "amberStopIfSafe", label: "Stop on amber", help: "Stop on amber when there's room to; off, amber is treated as green." },
      { kind: "toggle", section: "junctions", key: "gridlockCheck", label: "Don't block the box", help: "Only enter a junction when there's room on the road out." },
      { kind: "number", section: "junctions", key: "stopHold", label: "Stop sign wait", help: "How long cars stand at a stop line before going.", min: 0, max: 5, step: 0.1, unit: "s" },
      { kind: "number", section: "junctions", key: "yieldHorizon", label: "Give-way look", help: "Give way to priority traffic arriving within this time.", min: 0, max: 8, step: 0.1, unit: "s" },
      { kind: "number", section: "junctions", key: "ringGap", label: "Roundabout gap", help: "Gap wanted before ring traffic reaches an entry.", min: 0.5, max: 6, step: 0.1, unit: "s" },
      { kind: "number", section: "junctions", key: "giveWayTime", label: "Driveway gap", help: "Gap wanted pulling out of a driveway.", min: 0.5, max: 6, step: 0.1, unit: "s" },
      { kind: "number", section: "junctions", key: "turnInGap", label: "Turn-in gap", help: "Gap wanted turning into a driveway across oncoming traffic.", min: 0.5, max: 6, step: 0.1, unit: "s" },
    ],
  },
  {
    section: "signals",
    title: "Traffic lights",
    fields: [
      { kind: "number", section: "signals", key: "green", label: "Green", help: "Seconds of green per phase.", min: 3, max: 30, step: 1, unit: "s" },
      { kind: "number", section: "signals", key: "amber", label: "Amber", help: "Seconds of amber after each green.", min: 0, max: 6, step: 0.5, unit: "s" },
    ],
  },
  {
    section: "lanes",
    title: "Lane choice",
    fields: [
      {
        kind: "order",
        section: "lanes",
        key: "order",
        label: "Lane preference",
        help: "On each road, cars take the lane that goes where they're going and wins on these, in order; later ones only break ties.",
        items: { fewestChanges: "Fewest lane changes ahead", keepLane: "Stay in this lane", leastCongested: "Least held-up lane" },
      },
      { kind: "number", section: "lanes", key: "lookahead", label: "Plan ahead", help: "How many roads ahead cars plan their lanes for.", min: 1, max: 5, step: 1, unit: "roads" },
      { kind: "toggle", section: "lanes", key: "congestionAware", label: "Avoid queues", help: "Count stopped or slow cars ahead in each lane, entering a road." },
      { kind: "number", section: "lanes", key: "sight", label: "Sight distance", help: "How far ahead cars see queues.", min: 30, max: 400, step: 10, unit: "u" },
    ],
  },
  {
    section: "laneChange",
    title: "Lane changes",
    fields: [
      { kind: "number", section: "laneChange", key: "minSafeGap", label: "Safe gap", help: "Space wanted in the other lane, before and behind, on top of the car's length.", min: 0, max: 20, step: 0.5, unit: "u" },
      { kind: "number", section: "laneChange", key: "reaction", label: "Reaction time", help: "Seconds of the closing speed added to the gap wanted (more: fewer, safer merges).", min: 0.2, max: 3, step: 0.1, unit: "s" },
      { kind: "toggle", section: "laneChange", key: "urgency", label: "Get pushy near the turn", help: "When a lane change is needed for the route, accept smaller gaps the nearer the road's end." },
      { kind: "number", section: "laneChange", key: "minReaction", label: "Pushiest reaction time", help: "The reaction time accepted at the last moment.", min: 0, max: 2, step: 0.1, unit: "s" },
      { kind: "number", section: "laneChange", key: "urgencyStart", label: "Get pushy from", help: "How far before the last chance to change lane cars start accepting smaller gaps.", min: 0, max: 600, step: 10, unit: "u" },
      { kind: "toggle", section: "laneChange", key: "deadlockReroute", label: "Give up and reroute", help: "A car stuck waiting to change lane finds another way from the lane it's in." },
      { kind: "number", section: "laneChange", key: "rerouteWait", label: "Wait before rerouting", help: "How long a car waits for a gap before rerouting.", min: 3, max: 60, step: 1, unit: "s" },
      { kind: "toggle", section: "laneChange", key: "stuckChange", label: "Move over when stuck", help: "A car standing still moves into the lane beside it, if that lane still goes where it's going and there's room." },
      { kind: "number", section: "laneChange", key: "stuckAfter", label: "Stuck after", help: "How long a car stands still before moving over.", min: 2, max: 60, step: 1, unit: "s" },
    ],
  },
  {
    section: "following",
    title: "Car following",
    fields: [
      { kind: "number", section: "following", key: "headway", label: "Following time", help: "Time gap kept to the car ahead.", min: 0.3, max: 3, step: 0.1, unit: "s" },
      { kind: "number", section: "following", key: "minGap", label: "Standstill gap", help: "Space left to the car ahead when stopped.", min: 0, max: 15, step: 0.5, unit: "u" },
      { kind: "number", section: "following", key: "accel", label: "Acceleration", help: "How hard cars pull away.", min: 5, max: 40, step: 1, unit: "u/s²" },
      { kind: "number", section: "following", key: "brake", label: "Comfortable braking", help: "How hard cars like to brake.", min: 10, max: 60, step: 1, unit: "u/s²" },
    ],
  },
  {
    section: "routing",
    title: "Route choice",
    fields: [
      { kind: "toggle", section: "routing", key: "speedLimits", label: "Prefer faster roads", help: "Time each road by its speed limit; off, every road counts as 50 km/h." },
      { kind: "number", section: "routing", key: "turnKerb", label: "Kerb-side turn cost", help: "Seconds a route is charged for each turn towards the kerb.", min: 0, max: 30, step: 0.5, unit: "s" },
      { kind: "number", section: "routing", key: "turnAcross", label: "Turn across traffic cost", help: "Seconds a route is charged for each turn across oncoming traffic.", min: 0, max: 30, step: 0.5, unit: "s" },
      { kind: "number", section: "routing", key: "delayNone", label: "Uncontrolled junction cost", help: "Seconds a route is charged for passing one.", min: 0, max: 20, step: 0.5, unit: "s" },
      { kind: "number", section: "routing", key: "delayYield", label: "Give-way junction cost", help: "Seconds a route is charged for passing one.", min: 0, max: 20, step: 0.5, unit: "s" },
      { kind: "number", section: "routing", key: "delayStop", label: "Stop junction cost", help: "Seconds a route is charged for passing one.", min: 0, max: 20, step: 0.5, unit: "s" },
      { kind: "number", section: "routing", key: "delaySignals", label: "Signals cost", help: "Seconds a route is charged for passing one.", min: 0, max: 20, step: 0.5, unit: "s" },
    ],
  },
  {
    section: "trips",
    title: "Trips",
    fields: [
      { kind: "number", section: "trips", key: "parkMin", label: "Shortest stay", help: "Shortest time a car stays parked.", min: 5, max: 300, step: 5, unit: "s" },
      { kind: "number", section: "trips", key: "parkMax", label: "Longest stay", help: "Longest time a car stays parked.", min: 5, max: 300, step: 5, unit: "s" },
      { kind: "number", section: "trips", key: "signalAhead", label: "Indicate from", help: "How far before a turn or lane change cars indicate.", min: 0, max: 200, step: 10, unit: "u" },
    ],
  },
];

/**
 * Rules read from a saved map: anything missing or invalid takes its default, numbers are kept
 * in range, and orders must list each choice once. Never throws, so a map always loads.
 */
export function parseRules(raw: unknown): TrafficRules {
  const rules = structuredClone(DEFAULT_RULES);
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, Record<string, unknown> | undefined>;
  for (const { section, fields } of RULE_SECTIONS) {
    const given = input[section];
    if (!given || typeof given !== "object") continue;
    const target = rules[section] as unknown as Record<string, unknown>;
    for (const field of fields) {
      const value = given[field.key];
      if (field.kind === "number" && typeof value === "number" && Number.isFinite(value)) {
        target[field.key] = Math.min(field.max, Math.max(field.min, value));
      } else if (field.kind === "toggle" && typeof value === "boolean") {
        target[field.key] = value;
      } else if (field.kind === "order" && Array.isArray(value)) {
        const items = Object.keys(field.items);
        if (value.length === items.length && items.every((i) => value.includes(i))) target[field.key] = [...value];
      }
    }
  }
  if (rules.trips.parkMax < rules.trips.parkMin) rules.trips.parkMax = rules.trips.parkMin;
  return rules;
}

/** True when `rules` are the defaults (so a map needn't save them). */
export function isDefaultRules(rules: TrafficRules): boolean {
  return JSON.stringify(rules) === JSON.stringify(DEFAULT_RULES);
}
