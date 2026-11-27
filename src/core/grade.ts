/**
 * Bridges and tunnels. A road's `level` (in its spec) is 0 on the ground, +1, +2, +3 for bridges a
 * step up, -1, -2, -3 for tunnels a step down. It's at that height all along, its nodes too: roads
 * join only at the same level. A ramp (`from` in its spec, the level at its start) runs level for a
 * landing at each end, its ends' heights, and climbs (or dips) between them at `RAMP_GRADE`.
 */

/** Height of one level, in world units; tunnels go deeper per level, for headroom under their roof. */
export const LEVEL_HEIGHT = 10;
export const TUNNEL_DEPTH = 16;
/** Deepest and highest level a road can be on: the road tool's steps. */
export const MAX_LEVEL = 3;
/** Roads crossing with less height than this between them would hit: no crossing there. */
export const CLEARANCE = LEVEL_HEIGHT * 0.8;

/** Height of a road (and its nodes) at `level`: up a bridge's steps, down a tunnel's. */
export function levelHeight(level: number): number {
  return level * (level > 0 ? LEVEL_HEIGHT : TUNNEL_DEPTH);
}

/** A ramp's slope: up (or down) this much per unit along it, a bridge's step every 60. */
export const RAMP_GRADE = LEVEL_HEIGHT / 60;
/** A ramp runs level this far at each end, so it meets the roads there as a level road would. */
export const LANDING = 20;

/** How far along a ramp from level `from` to `to` climbs (or dips). */
export function rampClimb(from: number, to: number): number {
  return Math.abs(levelHeight(to) - levelHeight(from)) / RAMP_GRADE;
}

/** The shortest a road from level `from` to `to` can be: its landings and climb (0 for a level road). */
export function minRampLength(from: number, to: number): number {
  return from === to ? 0 : 2 * LANDING + rampClimb(from, to);
}

/** Height `s` along a road from level `from` (at its start) to `to`: level, climbing, then level to its end. */
export function heightAlong(from: number, to: number, s: number): number {
  const [a, b] = [levelHeight(from), levelHeight(to)];
  if (a === b) return a;
  const t = Math.max(0, Math.min(1, (s - LANDING) / rampClimb(from, to)));
  return a + (b - a) * t;
}
