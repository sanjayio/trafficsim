/** Buildings cars come out of. */
export type SourceBuilding = "villa" | "townhouse" | "apartment";
/** Buildings cars drive to. */
export type SinkBuilding = "smallShop" | "largeShop" | "smallOffice" | "largeOffice";
export type Building = SourceBuilding | SinkBuilding;

export const SOURCE_BUILDINGS: SourceBuilding[] = ["villa", "townhouse", "apartment"];
export const SINK_BUILDINGS: SinkBuilding[] = ["smallShop", "largeShop", "smallOffice", "largeOffice"];

export const BUILDING_LABEL: Record<Building, string> = {
  villa: "Villa",
  townhouse: "Townhouse",
  apartment: "Apartment",
  smallShop: "Small shop",
  largeShop: "Large shop",
  smallOffice: "Small office",
  largeOffice: "Large office",
};

/** Cars per minute each kind of home sends out. */
export const SOURCE_RATE: Record<SourceBuilding, number> = { villa: 1, townhouse: 3, apartment: 6 };
/** Cars per minute a home sends at the top level; in between, it rises evenly from SOURCE_RATE. */
export const SOURCE_RATE_MAX: Record<SourceBuilding, number> = { villa: 3, townhouse: 6, apartment: 12 };

/** Cars per minute a home of `building` sends at `level`. */
export function sourceRate(building: SourceBuilding, level: number): number {
  return SOURCE_RATE[building] + ((SOURCE_RATE_MAX[building] - SOURCE_RATE[building]) * (level - 1)) / (MAX_LEVEL - 1);
}

/** Zoning tiles beside roads: their size, and how many rows deep they go. */
export const TILE = 18;
export const ZONE_ROWS = 4;

/** How many tiles each building takes: along the road, and back from it. */
export const BUILDING_TILES: Record<Building, [number, number]> = {
  villa: [2, 2],
  townhouse: [3, 2],
  apartment: [3, 3],
  smallShop: [2, 4],
  largeShop: [4, 4],
  smallOffice: [2, 3],
  largeOffice: [3, 4],
};

/** Gap between the road's edge and the building's front (its front yard, crossed by the driveway). */
export const LOT_SETBACK = 8;

/** Driveways' width, from the road to a building's door. */
export const DRIVEWAY_WIDTH = 14;
/** Shops and offices: the row of parking bays between the front yard and the building, and each bay's width. */
export const PARKING_DEPTH = 15;
export const BAY_WIDTH = 8;
/** Width of the path down a building's side to a car park behind it, and of the lane along the back. */
export const SIDE_PATH = 9;
export const REAR_AISLE = 8;
/** Buildings with a car park behind them too. */
const REAR_PARKING = new Set<Building>(["smallShop", "largeShop"]);
/** Buildings that park cars underground (out of sight, through an entrance at the driveway), and how many. */
export const UNDERGROUND_PARKING: Partial<Record<Building, number>> = { smallOffice: 12, largeOffice: 30 };
/** Depth of the plaza (trees and benches) in front of a building with underground parking. */
export const PLAZA_DEPTH = 16;
/** With a car park behind, a front row of bays too only if it leaves the building at least this deep. */
const MIN_BUILDING_DEPTH = 20;

/** Each building's footprint, along the road and back from it: its tiles, less the front yard and a little space round it. */
export const BUILDING_SIZE = Object.fromEntries(
  Object.entries(BUILDING_TILES).map(([b, [w, d]]) => [b, { length: w * TILE - 4, depth: d * TILE - LOT_SETBACK - 2 }]),
) as Record<Building, { length: number; depth: number }>;

/**
 * A traffic source or sink, saved with the map: on a road's dead end, or anywhere along a road (a
 * node where two roads join, where its driveway meets the road). Along a road, `side` is which
 * side its building stands (1 to the right, -1 to the left, of the direction
 * `RoadGraph.terminalDirection` gives) and `offset` how far along that direction its centre is
 * from the driveway, so it sits on its zoning tiles.
 */
export type Terminal =
  | ({ kind: "sink"; building: SinkBuilding; side?: 1 | -1; offset?: number } & BuildingDetails)
  | ({
      kind: "source";
      building: SourceBuilding;
      side?: 1 | -1;
      offset?: number;
      enabled: boolean;
      /** Cars per minute: its building's at its level (see `sourceRate`). */
      rate: number;
      /** Sinks its cars may head to when `to` is "custom" (one picked at random per car). */
      sinks: number[];
      /** Where its cars go: any shop or office, only shops, only offices, or the `sinks` listed. Missing: "custom" if any are listed, else "any". */
      to?: Destinations;
    } & BuildingDetails);

/** What every building may have set or earned: its name and colours, and how far it has grown. */
export interface BuildingDetails {
  /** Shops and offices only: shown on the sign on their front. */
  name?: string;
  colors?: { primary: number; secondary: number };
  /** 1 to MAX_LEVEL; 1 if missing. */
  level?: number;
  /** Tiles of width gained by growing (some levels grow taller instead, when there's no room or by turn). */
  wide?: number;
  /** Customers served (cars parked at a shop or office) or trips home completed (a home). */
  served?: number;
}

export const MAX_LEVEL = 5;
export const MAX_NAME = 30;
/** Customers (or trips) needed to reach each level: LEVEL_NEEDS[level - 1]. */
export const LEVEL_NEEDS = [0, 25, 75, 150, 300];

export const levelOf = (t: BuildingDetails): number => t.level ?? 1;
/** How much more parking an office has under it at its level. */
export const levelFactor = (t: BuildingDetails): number => 1 + 0.5 * (levelOf(t) - 1);
/** Levels gained by growing taller rather than wider. */
export const tallSteps = (t: BuildingDetails): number => levelOf(t) - 1 - (t.wide ?? 0);

/** The building's footprint at its size: its tiles (with any gained by growing), less the front yard and a little round it. */
export function buildingSize(t: { building: Building } & BuildingDetails): { length: number; depth: number } {
  const [w, d] = BUILDING_TILES[t.building];
  return { length: (w + (t.wide ?? 0)) * TILE - 4, depth: d * TILE - LOT_SETBACK - 2 };
}

const NAMES: Record<SinkBuilding, string[]> = {
  smallShop: ["Corner Mart", "Daily Deli", "Fresh Grocer", "Book Nook", "Bean Café"],
  largeShop: ["MegaMart", "Home & Garden", "City Market", "Value Store"],
  smallOffice: ["Northwind Ltd", "Bright Studio", "Pixel & Co", "Summit Partners"],
  largeOffice: ["Harbour Offices", "Apex Tower", "Meridian House", "Atlas Centre"],
};

/** A name for a shop or office that hasn't been given one: the same one each time for the same spot. */
export function defaultName(building: SinkBuilding, nodeId: number): string {
  const names = NAMES[building];
  return names[Math.abs(nodeId) % names.length];
}

export type Source = Extract<Terminal, { kind: "source" }>;

export const DESTINATIONS = ["any", "shops", "offices", "custom"] as const;
export type Destinations = (typeof DESTINATIONS)[number];
const SHOPS: Building[] = ["smallShop", "largeShop"];

/** Where a home's cars go (see `Source.to`). */
export function destinationsOf(source: Source): Destinations {
  return source.to ?? (source.sinks.length ? "custom" : "any");
}

/** Whether a home's cars may head to `sink` (a shop's or office's node, of `building`), going by its choice of destinations. */
export function headsTo(source: Source, sink: number, building: Building): boolean {
  switch (destinationsOf(source)) {
    case "any":
      return true;
    case "shops":
      return SHOPS.includes(building);
    case "offices":
      return !SHOPS.includes(building);
    case "custom":
      return source.sinks.includes(sink);
  }
}

/** How far along the road from its driveway cars join (or leave) the road. */
export const DRIVEWAY_BLEND = 14;

/** Where a source's or sink's building stands, beside its road. */
export interface Lot {
  building: Building;
  level: number;
  centre: { x: number; y: number };
  /** Unit direction along the road (away from its end, on a dead end). */
  along: { x: number; y: number };
  /** How far along `along` from the node the driveway meets the road. */
  at: number;
  /** Where the driveway meets the building's front. */
  door: { x: number; y: number };
  /** Unit direction from the road towards the building. */
  out: { x: number; y: number };
  /** Distance from the road's centre line to the building's front. */
  front: number;
  /** The building's footprint along the road, and back from it. */
  length: number;
  depth: number;
}

export function isSourceBuilding(building: Building): building is SourceBuilding {
  return (SOURCE_BUILDINGS as Building[]).includes(building);
}

/** A new source or sink of the given building. */
export function newTerminal(building: Building, side?: 1 | -1, offset?: number): Terminal {
  const sided = { ...(side === undefined ? {} : { side }), ...(offset === undefined ? {} : { offset }) };
  if (isSourceBuilding(building)) {
    return { kind: "source", building, enabled: true, rate: SOURCE_RATE[building], sinks: [], ...sided };
  }
  return { kind: "sink", building, ...sided };
}

export const DEFAULT_SOURCE = newTerminal("villa") as Source;
export const SINK = newTerminal("smallShop");

/**
 * Validates a terminal read from a saved map. Maps from before buildings: a source becomes the home
 * whose rate is nearest its own, a sink a small shop.
 */
export function parseTerminal(raw: unknown): Terminal {
  const t = (raw ?? {}) as Record<string, unknown>;
  const fail = (): never => {
    throw new Error("Invalid source or sink in map file");
  };
  if (t.side !== undefined && t.side !== 1 && t.side !== -1) fail();
  if (t.offset !== undefined && !Number.isFinite(t.offset)) fail();
  const side = {
    ...(t.side === undefined ? {} : { side: t.side as 1 | -1 }),
    ...(t.offset === undefined ? {} : { offset: t.offset as number }),
    ...parseDetails(t, fail),
  };
  if (t.kind === "sink") {
    const building = t.building ?? "smallShop";
    if (!(SINK_BUILDINGS as unknown[]).includes(building)) fail();
    return { kind: "sink", building: building as SinkBuilding, ...side };
  }
  if (
    t.kind === "source" &&
    typeof t.enabled === "boolean" &&
    Number.isFinite(t.rate) &&
    (t.rate as number) >= 0 &&
    Array.isArray(t.sinks) &&
    t.sinks.every((id) => Number.isSafeInteger(id))
  ) {
    const rate = t.rate as number;
    const nearest = SOURCE_BUILDINGS.reduce((a, b) => (Math.abs(SOURCE_RATE[b] - rate) < Math.abs(SOURCE_RATE[a] - rate) ? b : a));
    const building = t.building ?? nearest;
    if (!(SOURCE_BUILDINGS as unknown[]).includes(building)) fail();
    if (t.to !== undefined && !(DESTINATIONS as readonly unknown[]).includes(t.to)) fail();
    const to = t.to === undefined ? {} : { to: t.to as Destinations };
    // No more than its kind of home sends at the top level (older maps let levels multiply it).
    const capped = Math.min(rate, SOURCE_RATE_MAX[building as SourceBuilding]);
    return { kind: "source", building: building as SourceBuilding, enabled: t.enabled, rate: capped, sinks: [...(t.sinks as number[])], ...to, ...side };
  }
  return fail();
}

/** A parking bay, as offsets from its lot's centre: `a` along the road, `z` away from it. Rear bays are reached by the side path. */
export interface Bay {
  a: number;
  z: number;
  rear: boolean;
  /** In an underground car park: driven into through the entrance at the driveway, out of sight. */
  underground?: boolean;
  /** Rear bays: which way a parked car points, away from the road (1) or towards it (-1): to the lane between the rows. */
  facing?: 1 | -1;
}

/**
 * A shop's or office's car park, as offsets from its lot's centre (`a` along the road, `z` away
 * from it). A row of bays across the front (behind the front yard, where the door is) and, for the
 * bigger buildings, a row across the back, along a lane reached by a path down one side. No bay
 * blocks the driveway or the path. Also where that leaves the building.
 */
export function carPark(lot: Lot): {
  bays: Bay[];
  /** Painted lines between bays. */
  lines: { a: number; z: number }[];
  /** Middle of the side path (along), and of the lane behind the building (back from the centre); null without a rear car park. */
  path: number | null;
  aisle: number;
  building: { a0: number; a1: number; z0: number; z1: number };
} {
  const { length: l, depth: d } = lot;
  const doorAt = (lot.door.x - lot.centre.x) * lot.along.x + (lot.door.y - lot.centre.y) * lot.along.y;
  const base = UNDERGROUND_PARKING[lot.building];
  if (base) {
    // The garage grows with the building's level.
    const underground = Math.round(base * levelFactor({ level: lot.level }));
    // All bays below ground, entered at the driveway; the building stands behind a plaza.
    return {
      bays: Array.from({ length: underground }, () => ({ a: doorAt, z: -d / 2 + PLAZA_DEPTH, rear: false, underground: true })),
      lines: [],
      path: null,
      aisle: 0,
      building: { a0: -l / 2, a1: l / 2, z0: -d / 2 + PLAZA_DEPTH, z1: d / 2 },
    };
  }
  const rear = REAR_PARKING.has(lot.building);
  // Two rows of bays either side of a lane, the cars in each facing it.
  const rearDepth = rear ? REAR_AISLE + PARKING_DEPTH * 2 : 0;
  const front = !rear || d - rearDepth - PARKING_DEPTH >= MIN_BUILDING_DEPTH;
  // The path down the side away from the driveway.
  const path = rear ? (doorAt > 0 ? -1 : 1) * (l / 2 - SIDE_PATH / 2) : null;
  const bays: Bay[] = [];
  const lines: { a: number; z: number }[] = [];
  const row = (z: number, isRear: boolean, clear: (a: number, half: number) => boolean, facing?: 1 | -1) => {
    const count = Math.floor(l / BAY_WIDTH);
    const first = -(count * BAY_WIDTH) / 2;
    for (let i = 0; i <= count; i++) if (clear(first + i * BAY_WIDTH, 0)) lines.push({ a: first + i * BAY_WIDTH, z });
    for (let i = 0; i < count; i++) {
      const a = first + (i + 0.5) * BAY_WIDTH;
      if (clear(a, BAY_WIDTH / 2)) bays.push({ a, z, rear: isRear, ...(facing ? { facing } : {}) });
    }
  };
  const clearOf = (at: number, width: number) => (a: number, half: number) => Math.abs(a - at) >= width / 2 + half;
  if (front) {
    const driveway = clearOf(doorAt, DRIVEWAY_WIDTH);
    const side = path === null ? () => true : clearOf(path, SIDE_PATH);
    row(-d / 2 + PARKING_DEPTH / 2, false, (a, half) => driveway(a, half) && side(a, half));
  }
  // Right behind the path's end, a car would have no room to turn in; the rest of the row is fine.
  if (path !== null) {
    const clearOfPath = (a: number, half: number) => Math.abs(a - path) >= (half ? BAY_WIDTH : BAY_WIDTH / 2);
    row(d / 2 - rearDepth + PARKING_DEPTH / 2, true, clearOfPath, 1);
    row(d / 2 - PARKING_DEPTH / 2, true, clearOfPath, -1);
  }
  const beside = path === null ? { a0: -l / 2, a1: l / 2 } : path > 0 ? { a0: -l / 2, a1: path - SIDE_PATH / 2 - 1 } : { a0: path + SIDE_PATH / 2 + 1, a1: l / 2 };
  return {
    bays,
    lines,
    path,
    aisle: d / 2 - PARKING_DEPTH - REAR_AISLE / 2,
    building: { ...beside, z0: -d / 2 + (front ? PARKING_DEPTH : 0), z1: d / 2 - rearDepth },
  };
}

/** The ground point at offsets (`a` along the road, `z` away from it) from lot `lot`'s centre. */
export function lotPoint(lot: Lot, a: number, z: number): { x: number; y: number } {
  return { x: lot.centre.x + lot.along.x * a + lot.out.x * z, y: lot.centre.y + lot.along.y * a + lot.out.y * z };
}

/** The optional building details of a saved terminal, checked. */
function parseDetails(t: Record<string, unknown>, fail: () => never): BuildingDetails {
  const details: BuildingDetails = {};
  const colour = (c: unknown) => Number.isInteger(c) && (c as number) >= 0 && (c as number) <= 0xffffff;
  const count = (n: unknown, max: number) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= max;
  if (t.name !== undefined) {
    if (typeof t.name !== "string" || t.name.length > MAX_NAME) fail();
    details.name = t.name as string;
  }
  if (t.colors !== undefined) {
    const c = (t.colors ?? {}) as Record<string, unknown>;
    if (!colour(c.primary) || !colour(c.secondary)) fail();
    details.colors = { primary: c.primary as number, secondary: c.secondary as number };
  }
  if (t.level !== undefined) {
    if (!count(t.level, MAX_LEVEL) || (t.level as number) < 1) fail();
    details.level = t.level as number;
  }
  if (t.wide !== undefined) {
    if (!count(t.wide, MAX_LEVEL - 1) || (t.wide as number) > (details.level ?? 1) - 1) fail();
    details.wide = t.wide as number;
  }
  if (t.served !== undefined) {
    if (!count(t.served, Number.MAX_SAFE_INTEGER)) fail();
    details.served = t.served as number;
  }
  return details;
}
