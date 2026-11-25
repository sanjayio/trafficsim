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
export const SOURCE_RATE: Record<SourceBuilding, number> = { villa: 1, townhouse: 4, apartment: 12 };

/** Zoning tiles beside roads: their size, and how many rows deep they go. */
export const TILE = 18;
export const ZONE_ROWS = 4;

/** How many tiles each building takes: along the road, and back from it. */
export const BUILDING_TILES: Record<Building, [number, number]> = {
  villa: [2, 2],
  townhouse: [3, 2],
  apartment: [3, 3],
  smallShop: [2, 2],
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
const REAR_PARKING = new Set<Building>(["smallOffice", "largeOffice", "largeShop"]);
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
  | { kind: "sink"; building: SinkBuilding; side?: 1 | -1; offset?: number }
  | {
      kind: "source";
      building: SourceBuilding;
      side?: 1 | -1;
      offset?: number;
      enabled: boolean;
      /** Cars per minute: its building's (see SOURCE_RATE). */
      rate: number;
      /** Sinks its cars may head to (one picked at random per car); empty means any reachable sink. */
      sinks: number[];
    };

export type Source = Extract<Terminal, { kind: "source" }>;

/** How far along the road from its driveway cars join (or leave) the road. */
export const DRIVEWAY_BLEND = 14;

/** Where a source's or sink's building stands, beside its road. */
export interface Lot {
  building: Building;
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
  const side = { ...(t.side === undefined ? {} : { side: t.side as 1 | -1 }), ...(t.offset === undefined ? {} : { offset: t.offset as number }) };
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
    return { kind: "source", building: building as SourceBuilding, enabled: t.enabled, rate, sinks: [...(t.sinks as number[])], ...side };
  }
  return fail();
}

/** A parking bay, as offsets from its lot's centre: `a` along the road, `z` away from it. Rear bays are reached by the side path. */
export interface Bay {
  a: number;
  z: number;
  rear: boolean;
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
  const rear = REAR_PARKING.has(lot.building);
  const rearDepth = rear ? REAR_AISLE + PARKING_DEPTH : 0;
  const front = !rear || d - rearDepth - PARKING_DEPTH >= MIN_BUILDING_DEPTH;
  // The path down the side away from the driveway.
  const path = rear ? (doorAt > 0 ? -1 : 1) * (l / 2 - SIDE_PATH / 2) : null;
  const bays: Bay[] = [];
  const lines: { a: number; z: number }[] = [];
  const row = (z: number, isRear: boolean, clear: (a: number, half: number) => boolean) => {
    const count = Math.floor(l / BAY_WIDTH);
    const first = -(count * BAY_WIDTH) / 2;
    for (let i = 0; i <= count; i++) if (clear(first + i * BAY_WIDTH, 0)) lines.push({ a: first + i * BAY_WIDTH, z });
    for (let i = 0; i < count; i++) {
      const a = first + (i + 0.5) * BAY_WIDTH;
      if (clear(a, BAY_WIDTH / 2)) bays.push({ a, z, rear: isRear });
    }
  };
  const clearOf = (at: number, width: number) => (a: number, half: number) => Math.abs(a - at) >= width / 2 + half;
  if (front) {
    const driveway = clearOf(doorAt, DRIVEWAY_WIDTH);
    const side = path === null ? () => true : clearOf(path, SIDE_PATH);
    row(-d / 2 + PARKING_DEPTH / 2, false, (a, half) => driveway(a, half) && side(a, half));
  }
  // Right behind the path's end, a car would have no room to turn in; the rest of the row is fine.
  if (path !== null) row(d / 2 - PARKING_DEPTH / 2, true, (a, half) => Math.abs(a - path) >= (half ? BAY_WIDTH : BAY_WIDTH / 2));
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
