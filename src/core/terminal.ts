/**
 * A traffic source or sink, saved with the map: on a road's dead end, or anywhere along a road (a
 * node where two roads join). `side`, along a road, is which side its building stands: 1 to the
 * right, -1 to the left, of the direction `RoadGraph.terminalLot` measures from.
 */
export type Terminal =
  | { kind: "sink"; side?: 1 | -1 }
  | {
      kind: "source";
      side?: 1 | -1;
      enabled: boolean;
      /** Cars per minute. */
      rate: number;
      /** Sinks its cars may head to (one picked at random per car); empty means any reachable sink. */
      sinks: number[];
    };

export type Source = Extract<Terminal, { kind: "source" }>;

/** Footprint of the building standing beside a source or sink: along the road, and back from it. */
export const LOT_LENGTH = 30;
export const LOT_DEPTH = 22;
/** Gap between the road's edge and the building's front. */
export const LOT_SETBACK = 8;
/** How far along the road from its driveway cars join (or leave) the road. */
export const DRIVEWAY_BLEND = 14;

/** Where a source's or sink's building stands, beside its road. */
export interface Lot {
  centre: { x: number; y: number };
  /** Unit direction along the road (away from its end, on a dead end). */
  along: { x: number; y: number };
  /** How far along `along` from the node the building (and its driveway) stands. */
  at: number;
  /** Unit direction from the road towards the building. */
  out: { x: number; y: number };
  /** Distance from the road's centre line to the building's front. */
  front: number;
}

export const MAX_SOURCE_RATE = 60;

export const DEFAULT_SOURCE: Source = { kind: "source", enabled: true, rate: 10, sinks: [] };
export const SINK: Terminal = { kind: "sink" };

/** Validates a terminal read from a saved map. */
export function parseTerminal(raw: unknown): Terminal {
  const t = (raw ?? {}) as Record<string, unknown>;
  if (t.side !== undefined && t.side !== 1 && t.side !== -1) throw new Error("Invalid source or sink in map file");
  const side = t.side === undefined ? {} : { side: t.side as 1 | -1 };
  if (t.kind === "sink") return { ...SINK, ...side };
  if (
    t.kind === "source" &&
    typeof t.enabled === "boolean" &&
    Number.isFinite(t.rate) &&
    (t.rate as number) >= 0 &&
    (t.rate as number) <= MAX_SOURCE_RATE &&
    Array.isArray(t.sinks) &&
    t.sinks.every((id) => Number.isSafeInteger(id))
  ) {
    return { kind: "source", enabled: t.enabled, rate: t.rate as number, sinks: [...(t.sinks as number[])], ...side };
  }
  throw new Error("Invalid source or sink in map file");
}
