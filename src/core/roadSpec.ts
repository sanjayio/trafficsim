import { MAX_LEVEL } from "./grade";

/** How a road is built. Stored per segment; the simulation will read lanes and direction from it. */
export interface RoadSpec {
  /** Lanes in each direction of travel (for a one-way road, its total lane count). */
  lanes: number;
  /** Traffic flows only from the segment's `a` node to its `b` node. */
  oneWay: boolean;
  /** Raised strip separating the two directions. Two-way roads only. */
  median: boolean;
  /** Sidewalk on both sides. */
  footpath: boolean;
  /** Trees in planters along the footpaths. Roads with footpaths only. */
  trees?: boolean;
  /**
   * A bridge (above 0) or tunnel (below) at that level, see `core/grade`. In the road tool, 1 or -1
   * asks for a bridge or tunnel; building it picks the level over (or under) whatever it crosses.
   */
  level?: number;
  /** Speed limit in km/h, one of `SPEED_LIMITS` (absent: `DEFAULT_SPEED`). Cars drive at it, and routes prefer faster roads. */
  speed?: number;
}

export const SPEED_LIMITS = [30, 50, 70, 90, 110] as const;
export const DEFAULT_SPEED = 50;
/** World units per second per km/h: 50 km/h is a cruise of 40 units/s. */
const SPEED_SCALE = 0.8;

/** A road's speed limit in world units per second. */
export function speedOf(spec: RoadSpec): number {
  return (spec.speed ?? DEFAULT_SPEED) * SPEED_SCALE;
}

export const MAX_LANES = 3;

/** One lane each way, no extras: the original road. */
export const DEFAULT_ROAD_SPEC: RoadSpec = { lanes: 1, oneWay: false, median: false, footpath: false };

export const LANE_WIDTH = 12;
export const MEDIAN_WIDTH = 6;
export const FOOTPATH_WIDTH = 8;

export function hasMedian(spec: RoadSpec): boolean {
  return spec.median && !spec.oneWay;
}

export function totalLanes(spec: RoadSpec): number {
  return spec.lanes * (spec.oneWay ? 1 : 2);
}

/** Width of the drivable surface (lanes plus median). */
export function carriagewayWidth(spec: RoadSpec): number {
  return totalLanes(spec) * LANE_WIDTH + (hasMedian(spec) ? MEDIAN_WIDTH : 0);
}

/** Full width including footpaths. */
export function roadWidth(spec: RoadSpec): number {
  return carriagewayWidth(spec) + (spec.footpath ? 2 * FOOTPATH_WIDTH : 0);
}

export function hasTrees(spec: RoadSpec): boolean {
  return !!spec.trees && spec.footpath;
}

/** Drops settings that don't apply (a median on a one-way road, trees without footpaths), so each road stores what it really is. */
export function normalizeRoadSpec(spec: RoadSpec): RoadSpec {
  const { trees: _, level, speed, ...rest } = spec;
  return {
    ...rest,
    median: hasMedian(spec),
    ...(hasTrees(spec) ? { trees: true } : {}),
    ...(level ? { level } : {}),
    ...(speed !== undefined && speed !== DEFAULT_SPEED ? { speed } : {}),
  };
}

/** Validates a spec read from a saved map. */
export function parseRoadSpec(raw: unknown): RoadSpec {
  const s = raw as Partial<RoadSpec> | null;
  if (
    !s ||
    !Number.isInteger(s.lanes) ||
    s.lanes! < 1 ||
    s.lanes! > MAX_LANES ||
    typeof s.oneWay !== "boolean" ||
    typeof s.median !== "boolean" ||
    typeof s.footpath !== "boolean" ||
    (s.trees !== undefined && typeof s.trees !== "boolean") ||
    (s.level !== undefined && (!Number.isInteger(s.level) || Math.abs(s.level) > MAX_LEVEL)) ||
    (s.speed !== undefined && !(SPEED_LIMITS as readonly number[]).includes(s.speed))
  ) {
    throw new Error("Invalid road settings in map file");
  }
  return normalizeRoadSpec({ lanes: s.lanes!, oneWay: s.oneWay, median: s.median, footpath: s.footpath, trees: s.trees, level: s.level, speed: s.speed });
}
