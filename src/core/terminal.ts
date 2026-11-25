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
  largeShop: [4, 3],
  smallOffice: [2, 2],
  largeOffice: [3, 3],
};

/** Gap between the road's edge and the building's front (its front yard, crossed by the driveway). */
export const LOT_SETBACK = 8;

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
