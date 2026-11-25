/**
 * Bridges and tunnels. A road's `level` (in its spec) is 0 on the ground, +1, +2… for bridges a
 * level up, -1, -2… for tunnels a level down. A bridge or tunnel road starts and ends on the
 * ground and ramps to its level (RAMP_PER_LEVEL along per level), staying there in between.
 */

/** Height of one level, in world units; tunnels go deeper per level, for headroom under their roof. */
export const LEVEL_HEIGHT = 10;
export const TUNNEL_DEPTH = 16;
/** Length of ramp per level climbed (or dug, longer for the deeper tunnels). */
export const RAMP_PER_LEVEL = 50;
export const TUNNEL_RAMP = 75;
/** Deepest and highest level a road can be on. */
export const MAX_LEVEL = 4;
/** Roads crossing with less height than this between them would hit: no crossing there. */
export const CLEARANCE = LEVEL_HEIGHT * 0.8;

/** Height of a road at `level`, `s` along it, `length` long: ramping from 0 at each end to its level. */
export function heightAlong(level: number, s: number, length: number): number {
  if (!level) return 0;
  // A short one ramps more steeply, to fit (see `minGradedLength`).
  const ramp = rampLength(level, length);
  const t = Math.max(0, Math.min(1, Math.min(s, length - s) / ramp));
  // Smooth at the top and the bottom of each ramp.
  return level * (level > 0 ? LEVEL_HEIGHT : TUNNEL_DEPTH) * t * t * (3 - 2 * t);
}

/** Shortest a road at `level` can be: both ramps, and some level stretch between. */
export function minGradedLength(level: number): number {
  return level ? 2 * MIN_RAMP * Math.abs(level) + LEVEL_SPAN : 0;
}

/** A level stretch between the ramps, at least; and the shortest a ramp (per level) is squeezed to. */
const LEVEL_SPAN = 10;
const MIN_RAMP = 20;

/** How long each ramp of a road `length` long at `level` is (shorter than usual if it must squeeze in). */
export function rampLength(level: number, length: number): number {
  return Math.min((level > 0 ? RAMP_PER_LEVEL : TUNNEL_RAMP) * Math.abs(level), (length - LEVEL_SPAN) / 2);
}

/** A tunnel's road this deep is covered over (not drawn, its cars out of sight): the mouth's height. */
export const COVERED = -TUNNEL_DEPTH * 0.8;
