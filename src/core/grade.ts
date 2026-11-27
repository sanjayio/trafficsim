/**
 * Bridges and tunnels. A road's `level` (in its spec) is 0 on the ground, +1, +2, +3 for bridges a
 * step up, -1, -2, -3 for tunnels a step down. It's at that height all along, its nodes too: roads
 * join only at the same level.
 */

/** Height of one level, in world units; tunnels go deeper per level, for headroom under their roof. */
export const LEVEL_HEIGHT = 10;
export const TUNNEL_DEPTH = 16;
/** Deepest and highest level a road can be on: the road tool's steps. */
export const MAX_LEVEL = 3;
/** Roads crossing with less height than this between them would hit: no crossing there. */
export const CLEARANCE = LEVEL_HEIGHT * 0.8;

/** Height of a road (and its nodes) at `level`: up a bridge's steps, down a tunnel's. Ramps between levels come later. */
export function levelHeight(level: number): number {
  return level * (level > 0 ? LEVEL_HEIGHT : TUNNEL_DEPTH);
}
