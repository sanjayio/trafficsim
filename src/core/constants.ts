/** Size of one grid cell in world units. Road endpoints snap to this grid. */
export const GRID_SIZE = 32;
/** Cells between major grid lines. */
export const GRID_MAJOR_EVERY = 8;
/** Width/height of the buildable world in world units. */
export const WORLD_SIZE = GRID_SIZE * 256;
/** Shortest road that can be placed. Grid-snapped roads are always at least one cell long. */
export const MIN_ROAD_LENGTH = 8;
/** Roads can't cross more shallowly than this (degrees); the junction would be a long sliver. */
export const MIN_CROSSING_ANGLE = 20;
/** A road endpoint placed this close to an existing node attaches to it. */
export const NODE_SNAP_RADIUS = 12;
/** Points closer than this are treated as the same node. */
export const NODE_MERGE_DIST = 1;
