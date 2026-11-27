import type { BufferGeometry } from "three";
import { distance, segmentCrossing, type Vec2 } from "../core/geometry";
import type { RoundaboutShape } from "../core/junction";
import { LANE_WIDTH, MEDIAN_WIDTH } from "../core/roadSpec";
import { convexGeometry, fill, FlatLayer, KERB_WIDTH, pavedGeometry } from "./flat";
import type { JunctionArm } from "./junctionParts";

const RING_SEGMENTS = 48;
const ISLAND_KERB = 2;
const LINE_WIDTH = 1;
const DASH = 8;
const GAP = 8;

/**
 * At full smoothness: the flare kerbs' size (as a fraction of the ring's outer radius) and the
 * splitter islands' length. Both scale down linearly to nothing.
 */
const FLARE_RATIO_MAX = 2.25;
const SPLITTER_LENGTH_MAX = 75;
/** Splitter islands shorter than this aren't drawn (the approach then meets the ring unsplit). */
const SPLITTER_MIN_LENGTH = 6;
/** Width of a splitter island where it meets the ring; each half of the road moves out by half of it. */
const SPLITTER_WIDTH = 8;
const SPLITTER_KERB = 1;
/** Splitter islands start this far outside the ring. */
const SPLITTER_GAP = 2;
/** How far out along its island a yield sign stands. */
const SIGN_ALONG = 7;
/** Sampling step along approaches, in world units. */
const STEP = 2;
/** Kerbs and splitter islands stay this far short of an arm's far end. */
const ARM_END_MARGIN = 4;
const CURVE_SEGMENTS = 16;
const TOOTH_WIDTH = 3.2;
const TOOTH_LENGTH = 4.5;
const TOOTH_GAP = 1.6;

type Part = "asphalt" | "footpath" | "median" | "laneLine" | "stopLine";

/** An approach to the roundabout, as seen leaving it. */
export interface RoundaboutArm extends JunctionArm {
  twoWay: boolean;
  /** Lanes in each direction (one-way: in total). */
  lanes: number;
  median: boolean;
  /** Side of the arm (sign of `edge` offsets) that traffic entering the roundabout drives on. */
  keep: 1 | -1;
}

export interface RoundaboutLayout {
  parts: { part: Part; order: number; geometry: BufferGeometry }[];
  /** Per arm (same order as `arms`): its yield sign's spot and facing. */
  signs: { position: Vec2; facing: Vec2 }[];
  /**
   * Per arm: where the road's own markings take over from the roundabout's, and whether the road
   * should draw give-way markings there itself (only when it meets the ring unsplit).
   */
  approaches: { inset: number; giveWay: boolean }[];
}

/**
 * A roundabout at `centre`: the ring with a kerbed island and lane lines; each approach flaring
 * into the ring with curved kerbs; and, on two-way approaches, a splitter island with the road
 * splitting round it like a Y — each half moves out by half the island's width (so no lane
 * narrows), taking its lane lines, footpath and give-way markings with it. Everything follows
 * the approach's actual (possibly curved) shape.
 */
export function buildRoundaboutParts(
  centre: Vec2,
  shape: RoundaboutShape,
  arms: RoundaboutArm[],
  /** 0–1: how far approaches flare and how long their splitter islands are (0: neither). */
  smoothness: number,
): RoundaboutLayout {
  const asphalt: Vec2[][] = [circle(centre, shape.outer)];
  const footpath: Vec2[][] = [];
  // Kerb stones along the footpaths' road edges: built like the footpath, a kerb's width wide.
  const kerbStones: Vec2[][] = [];
  // The kerb's face round the ring and along the split approaches (where flares meet the ring, the
  // asphalt drawn over the ring's face hides it).
  const faces: Vec2[][] = [];
  const lines: Vec2[][] = [];
  const teeth: Vec2[][] = [];
  const kerbs: Vec2[][] = [];
  const islands: Vec2[][] = [];
  // Round each splitter island's edge, its kerb's face (islands stand raised, like the footpaths).
  const islandEdges: Vec2[][] = [];
  for (let k = 1; k < shape.lanes; k++) lines.push(...dashedCircle(centre, shape.island + k * LANE_WIDTH + 2));
  const walkWidth = Math.max(0, ...arms.map((a) => a.footpath));
  if (walkWidth > 0) {
    footpath.push(circle(centre, shape.outer + walkWidth));
    kerbStones.push(circle(centre, shape.outer + KERB_WIDTH));
    const ring = circle(centre, shape.outer);
    faces.push([...ring, ring[0]]);
  }

  const signs: RoundaboutLayout["signs"] = [];
  const approaches: RoundaboutLayout["approaches"] = [];
  const plans = arms.map((arm) => {
    const start = shape.outer + SPLITTER_GAP;
    // Never past the arm's far end, where its edges stop (a short arm leads straight into another road).
    const length = Math.min(SPLITTER_LENGTH_MAX * smoothness, arm.length * 0.5, arm.length - start - ARM_END_MARGIN);
    const split = arm.twoWay && length >= SPLITTER_MIN_LENGTH;
    const end = split ? start + length : start;
    // How far each half of the road moves out at `along`: the full half-island up to the island,
    // easing to nothing at its tip.
    const shift = (along: number): number => {
      if (!split) return 0;
      if (along <= start) return SPLITTER_WIDTH / 2;
      if (along >= end) return 0;
      const u = 1 - (along - start) / length;
      return (SPLITTER_WIDTH / 2) * u * u * (3 - 2 * u);
    };
    const at = (offset: (along: number) => number) => (along: number) => arm.edge(offset(along), along);
    const road = ([1, -1] as const).map((side) => at((a) => side * (arm.halfWidth + shift(a))));
    const walk = ([1, -1] as const).map((side) => at((a) => side * (arm.halfWidth + shift(a) + arm.footpath)));
    const kerb = ([1, -1] as const).map((side) => at((a) => side * (arm.halfWidth + shift(a) + KERB_WIDTH)));
    return { arm, start, length, split, end, shift, road, walk, kerb };
  });
  // Every road edge (and footpath edge) meeting the ring, for the kerbs between them.
  const roadEdges: KerbEdge[] = [];
  const walkEdges: KerbEdge[] = [];
  const kerbEdges: KerbEdge[] = [];

  plans.forEach(({ arm, start, split, end, shift, road, walk, kerb }, index) => {
    if (split) {
      // The widened road under the split (the island draws over its middle).
      asphalt.push(...band(arm, (a) => -(arm.halfWidth + shift(a)), (a) => arm.halfWidth + shift(a), 0, end));
      if (arm.footpath > 0) {
        for (const side of [1, -1]) {
          footpath.push(
            ...band(arm, (a) => side * (arm.halfWidth + shift(a)), (a) => side * (arm.halfWidth + shift(a) + arm.footpath), 0, end),
          );
          kerbStones.push(
            ...band(arm, (a) => side * (arm.halfWidth + shift(a)), (a) => side * (arm.halfWidth + shift(a) + KERB_WIDTH), 0, end),
          );
          const line: Vec2[] = [];
          for (let a = 0; a < end; a += STEP) line.push(arm.edge(side * (arm.halfWidth + shift(a)), a));
          line.push(arm.edge(side * (arm.halfWidth + shift(end)), end));
          faces.push(line);
        }
      }
      kerbs.push(...island(arm, (a) => shift(a), start, end, 0));
      islandEdges.push(islandOutline(arm, (a) => shift(a), start, end));
      islands.push(...island(arm, (a) => shift(a), start, end, SPLITTER_KERB));

      // Each half's lane lines move out with it; the centre line gives way to the island. They
      // start clear of the give-way triangles, which run right across the entering lanes.
      const middle = arm.median ? MEDIAN_WIDTH / 2 : 0;
      for (let k = 1; k < arm.lanes; k++) {
        for (const side of [1, -1]) {
          lines.push(...dashed(arm, (a) => side * (middle + shift(a) + k * LANE_WIDTH), start + TOOTH_LENGTH + 2, end));
        }
      }
      // Give way across the entering half, just outside the ring.
      teeth.push(
        ...giveWay(arm, start, arm.keep * (middle + shift(start)), arm.keep * (arm.halfWidth + shift(start))),
      );
    }

    // The (shifted) road edges flare into the ring, and footpaths with them.
    const reach = Math.min(shape.outer * FLARE_RATIO_MAX * smoothness, arm.length * 0.5);
    ([1, -1] as const).forEach((side, i) => {
      roadEdges.push({ edge: road[i], road: index, side, reach, limit: arm.length });
      if (walkWidth > 0 && arm.footpath > 0) {
        walkEdges.push({ edge: walk[i], road: index, side, reach, limit: arm.length });
        kerbEdges.push({ edge: kerb[i], road: index, side, reach, limit: arm.length });
      }
    });

    approaches.push({ inset: split ? end : shape.outer, giveWay: !split });
    signs.push(
      split
        ? { position: arm.edge(0, start + SIGN_ALONG), facing: arm.dir }
        : // At the kerb on the driving side, just outside the ring.
          { position: arm.edge(arm.keep * (arm.halfWidth + Math.max(3, arm.footpath / 2)), shape.outer + 3), facing: arm.dir },
    );
  });

  asphalt.push(...kerbsBetween(centre, shape.outer, roadEdges));
  if (walkWidth > 0) {
    footpath.push(...kerbsBetween(centre, shape.outer + walkWidth, walkEdges));
    kerbStones.push(...kerbsBetween(centre, shape.outer + KERB_WIDTH, kerbEdges));
  }

  const parts: RoundaboutLayout["parts"] = [
    { part: "asphalt", order: FlatLayer.asphalt + 0.5, geometry: convexGeometry(asphalt) },
    // The ring island's kerb sits above the asphalt; the island draws over it.
    { part: "footpath", order: FlatLayer.markings + 0.1, geometry: pavedGeometry([circle(centre, shape.island)], [], [[...circle(centre, shape.island), circle(centre, shape.island)[0]]]) },
    { part: "median", order: FlatLayer.markings + 0.2, geometry: pavedGeometry([circle(centre, shape.island - ISLAND_KERB)]) },
  ];
  if (footpath.length) parts.push({ part: "footpath", order: FlatLayer.footpath, geometry: pavedGeometry(footpath, kerbStones, faces) });
  if (lines.length) parts.push({ part: "laneLine", order: FlatLayer.markings + 0.1, geometry: convexGeometry(lines) });
  if (teeth.length) parts.push({ part: "stopLine", order: FlatLayer.markings + 0.1, geometry: convexGeometry(teeth) });
  if (islands.length) {
    parts.push({ part: "footpath", order: FlatLayer.markings + 0.3, geometry: pavedGeometry(kerbs, [], islandEdges) });
    parts.push({ part: "median", order: FlatLayer.markings + 0.4, geometry: pavedGeometry(islands) });
  }
  return { parts, signs, approaches };
}

/** Quads between two offset functions along an arm, from `a0` to `a1`. */
function band(arm: JunctionArm, inner: (a: number) => number, outer: (a: number) => number, a0: number, a1: number): Vec2[][] {
  const quads: Vec2[][] = [];
  for (let a = a0; a < a1; a += STEP) {
    const b = Math.min(a + STEP, a1);
    quads.push([arm.edge(inner(a), a), arm.edge(inner(b), b), arm.edge(outer(b), b), arm.edge(outer(a), a)]);
  }
  return quads;
}

/**
 * A splitter island between offsets ±(half(a) − inset) from `a0` to its tip at `a1`, with a
 * round nose towards the ring. Built from quads and a fan, so it can follow a curved road.
 */
function island(arm: JunctionArm, half: (a: number) => number, a0: number, a1: number, inset: number): Vec2[][] {
  const width = (a: number) => Math.max(0, half(a) - inset);
  const shapes = band(arm, (a) => -width(a), (a) => width(a), a0, a1);
  // Round nose: a half disc at the ring end, bulging towards the ring.
  const r = width(a0);
  const nose: Vec2[] = [];
  for (let i = 0; i <= CURVE_SEGMENTS; i++) {
    const angle = (Math.PI * i) / CURVE_SEGMENTS;
    nose.push(arm.edge(r * Math.cos(angle), a0 - r * Math.sin(angle)));
  }
  if (r > 0) shapes.push(nose);
  return shapes;
}

/** The edge round a splitter island (as `island` with no inset), closed: down one side, back up the other, round the nose. */
function islandOutline(arm: JunctionArm, half: (a: number) => number, a0: number, a1: number): Vec2[] {
  const side = (sign: number) => {
    const out: Vec2[] = [];
    for (let a = a0; a < a1; a += STEP) out.push(arm.edge(sign * half(a), a));
    out.push(arm.edge(sign * half(a1), a1));
    return out;
  };
  const r = half(a0);
  const nose: Vec2[] = [];
  for (let i = 0; i <= CURVE_SEGMENTS; i++) {
    const angle = (Math.PI * i) / CURVE_SEGMENTS;
    nose.push(arm.edge(r * Math.cos(angle), a0 - r * Math.sin(angle)));
  }
  return [...side(-1), ...side(1).reverse(), ...nose];
}

/** Dashed line along an arm at a (possibly varying) offset, from `a0` to `a1`. */
function dashed(arm: JunctionArm, offset: (a: number) => number, a0: number, a1: number): Vec2[][] {
  const quads: Vec2[][] = [];
  for (let a = a0; a < a1; a += DASH + GAP) {
    const b = Math.min(a + DASH, a1);
    quads.push(...band(arm, (s) => offset(s) - LINE_WIDTH / 2, (s) => offset(s) + LINE_WIDTH / 2, a, b));
  }
  return quads;
}

/** Give-way triangles across offsets from..to with bases at `along`, pointing out at oncoming traffic. */
function giveWay(arm: JunctionArm, along: number, from: number, to: number): Vec2[][] {
  const lo = Math.min(from, to);
  const span = Math.abs(to - from);
  const count = Math.max(1, Math.floor((span + TOOTH_GAP) / (TOOTH_WIDTH + TOOTH_GAP)));
  const used = count * TOOTH_WIDTH + (count - 1) * TOOTH_GAP;
  const out: Vec2[][] = [];
  for (let i = 0; i < count; i++) {
    const left = lo + (span - used) / 2 + i * (TOOTH_WIDTH + TOOTH_GAP);
    out.push([arm.edge(left, along), arm.edge(left + TOOTH_WIDTH, along), arm.edge(left + TOOTH_WIDTH / 2, along + TOOTH_LENGTH)]);
  }
  return out;
}

interface KerbEdge {
  edge: (along: number) => Vec2;
  /** Which road the edge belongs to. */
  road: number;
  /** Side of its road the edge is on (1 right, -1 left): its kerb opens away from the road. */
  side: 1 | -1;
  /** How far along the edge its kerb may start. */
  reach: number;
  /** The arm's length: its edge stops there. */
  limit: number;
}

/** A road edge where it leaves the ring. `turn`: which way round the ring is away from its road. */
interface Corner extends KerbEdge {
  along: number;
  point: Vec2;
  angle: number;
  turn: 1 | -1;
}

/**
 * Smooth kerbs filling the sharp corners where road edges meet a ring of radius `ring`. Each gap
 * between neighbouring roads gets one kerb from edge to edge, as large as clears the ring (so close
 * roads never leave a point where two kerbs cross); where none does (wide gaps), each edge flares
 * into the ring on its own, taking at most half the gap.
 */
function kerbsBetween(centre: Vec2, ring: number, edges: KerbEdge[]): Vec2[][] {
  const corners = edges.map((e) => cornerOf(centre, ring, e)).filter((c): c is Corner => c !== null && c.reach > 0.5);
  const done = new Set<Corner>();
  const out: Vec2[][] = [];
  for (const c of corners) {
    if (c.turn !== 1) continue;
    const partner = facing(c, corners);
    if (!partner) continue;
    // Roads this close can cross each other's edges just outside the ring: the kerb starts there.
    const [a, b] = meet(c, partner);
    // Tighter kerbs if a full-size one would cut into the ring.
    let kerb: Vec2[][] | null = null;
    for (const k of [1, 0.7, 0.5, 0.35, 0.25]) {
      kerb = fillet(centre, ring, { ...a, reach: a.reach * k }, { ...b, reach: b.reach * k });
      if (kerb) break;
    }
    if (kerb) {
      out.push(...kerb);
      done.add(c).add(partner);
    }
  }
  for (const c of corners) {
    if (done.has(c)) continue;
    const gap = neighbour(c, corners)?.gap ?? Math.PI * 2;
    out.push(...flare(centre, ring, c, gap));
  }
  return out;
}

function cornerOf(centre: Vec2, ring: number, e: KerbEdge): Corner | null {
  let a = 0;
  while (a < ring * 3 && distance(e.edge(a), centre) < ring) a += 0.5;
  if (a >= ring * 3) return null;
  const point = e.edge(a);
  const angle = Math.atan2(point.y - centre.y, point.x - centre.x);
  // The kerb must leave the edge before the arm ends: beyond it the edge has no direction.
  const reach = Math.min(e.reach, e.limit - a - ARM_END_MARGIN);
  const away = unit(sub(e.edge(a + 1), point));
  const outward = { x: -away.y * e.side, y: away.x * e.side };
  const probe = { x: centre.x + Math.cos(angle + 0.1) * ring, y: centre.y + Math.sin(angle + 0.1) * ring };
  const turn = (probe.x - point.x) * outward.x + (probe.y - point.y) * outward.y > 0 ? 1 : -1;
  return { ...e, reach, along: a, point, angle, turn };
}

/**
 * The edge across the gap from `c` (turning +1): the nearest edge of another road turning back
 * towards it. It may lie slightly behind `c` round the ring, when the two edges cross just
 * outside it.
 */
function facing(c: Corner, corners: Corner[]): Corner | null {
  let best: Corner | null = null;
  let bestGap = Infinity;
  for (const other of corners) {
    if (other.turn !== -1 || other.road === c.road) continue;
    let d = (other.angle - c.angle) % (Math.PI * 2);
    if (d <= -Math.PI) d += Math.PI * 2;
    if (d > Math.PI) d -= Math.PI * 2;
    if (d > -0.6 && d < bestGap) {
      best = other;
      bestGap = d;
    }
  }
  // Nothing else may sit between them.
  if (best && corners.some((o) => o !== c && o !== best && angleWithin(o.angle, c.angle, best.angle))) return null;
  return best;
}

/** Whether `x` lies strictly between angles `from` and `to` going anticlockwise. */
function angleWithin(x: number, from: number, to: number): boolean {
  const tau = Math.PI * 2;
  const span = (((to - from) % tau) + tau) % tau;
  const at = (((x - from) % tau) + tau) % tau;
  return span < Math.PI && at > 1e-3 && at < span - 1e-3;
}

/** The next corner round the ring from `c` in its turn direction, and the angle between them. */
function neighbour(c: Corner, corners: Corner[]): { corner: Corner; gap: number } | null {
  let best: { corner: Corner; gap: number } | null = null;
  for (const other of corners) {
    if (other === c) continue;
    const d = (((c.turn * (other.angle - c.angle)) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    if (d > 1e-3 && (!best || d < best.gap)) best = { corner: other, gap: d };
  }
  return best;
}

/**
 * Two neighbouring corners, moved out to where their edges cross if they do (beyond the ring);
 * unchanged otherwise.
 */
function meet(a: Corner, b: Corner): [Corner, Corner] {
  const span = Math.max(a.reach, b.reach) + STEP;
  for (let s = a.along; s < a.along + span; s += STEP) {
    const p0 = a.edge(s);
    const p1 = a.edge(s + STEP);
    for (let t = b.along; t < b.along + span; t += STEP) {
      const hit = segmentCrossing(p0, p1, b.edge(t), b.edge(t + STEP));
      if (hit) {
        const sa = s + hit.u * STEP;
        const sb = t + hit.v * STEP;
        const point = a.edge(sa);
        return [
          { ...a, along: sa, point, reach: Math.max(0.5, a.reach - (sa - a.along)) },
          { ...b, along: sb, point, reach: Math.max(0.5, b.reach - (sb - b.along)) },
        ];
      }
    }
  }
  return [a, b];
}

/** Where a corner's kerb leaves its edge, and the edge's direction there (away from the ring). */
function kerbStart(c: Corner): { at: Vec2; dir: Vec2 } {
  const s = c.along + c.reach;
  return { at: c.edge(s), dir: unit(sub(c.edge(s + 1), c.edge(s - 1))) };
}

/**
 * One kerb across the gap between neighbouring edges `a` and `b`: a curve leaving each edge
 * tangentially at its reach. Null when the curve would cut inside the ring (the gap is wide; the
 * edges then flare into the ring separately).
 */
function fillet(centre: Vec2, ring: number, a: Corner, b: Corner): Vec2[][] | null {
  const ka = kerbStart(a);
  const kb = kerbStart(b);
  const handle = distance(ka.at, kb.at) * 0.45;
  const curve = cubic(ka.at, sub(ka.at, scale(ka.dir, handle)), sub(kb.at, scale(kb.dir, handle)), kb.at);
  if (curve.some((p) => distance(p, centre) < ring - 0.5)) return null;
  // Out along one edge, across the kerb, back down the other; closed across the ring.
  return fill([...along(a), ...curve.slice(1, -1), ...along(b).reverse()]);
}

/**
 * An edge flaring into the ring on its own: a curve that leaves the edge at its reach heading
 * along it, and joins the ring tangentially about as far round — at most half of `gap`.
 */
function flare(centre: Vec2, ring: number, c: Corner, gap: number): Vec2[][] {
  const sweep = Math.min(c.reach / ring, Math.PI / 2, gap / 2);
  if (sweep <= 0.01) return [];
  const { at: t1, dir: d1 } = kerbStart(c);
  const angle2 = c.angle + c.turn * sweep;
  const t2 = { x: centre.x + Math.cos(angle2) * ring, y: centre.y + Math.sin(angle2) * ring };
  // Direction of travel round the ring at t2, moving away from the corner.
  const d2 = { x: -Math.sin(angle2) * c.turn, y: Math.cos(angle2) * c.turn };
  // Each handle in proportion to the stretch its end covers, so a flare cut short round the ring
  // doesn't overshoot it.
  const kerb = cubic(t1, sub(t1, scale(d1, c.reach * 0.55)), sub(t2, scale(d2, ring * sweep * 0.55)), t2);
  // Out along the edge to t1, round the kerb to t2; closed back to the corner inside the ring.
  return fill([...along(c).slice(0, -1), ...kerb]);
}

/** Points along a corner's edge, from the ring out to where its kerb starts. */
function along(c: Corner): Vec2[] {
  const points: Vec2[] = [];
  for (let s = c.along; s < c.along + c.reach; s += STEP) points.push(c.edge(s));
  points.push(c.edge(c.along + c.reach));
  return points;
}

function cubic(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2): Vec2[] {
  const points: Vec2[] = [];
  for (let i = 0; i <= CURVE_SEGMENTS; i++) {
    const t = i / CURVE_SEGMENTS;
    const m = 1 - t;
    points.push({
      x: m * m * m * p0.x + 3 * m * m * t * p1.x + 3 * m * t * t * p2.x + t * t * t * p3.x,
      y: m * m * m * p0.y + 3 * m * m * t * p1.y + 3 * m * t * t * p2.y + t * t * t * p3.y,
    });
  }
  return points;
}

function circle(centre: Vec2, radius: number): Vec2[] {
  return Array.from({ length: RING_SEGMENTS }, (_, i) => {
    const a = (i / RING_SEGMENTS) * Math.PI * 2;
    return { x: centre.x + Math.cos(a) * radius, y: centre.y + Math.sin(a) * radius };
  });
}

function dashedCircle(centre: Vec2, radius: number): Vec2[][] {
  const quads: Vec2[][] = [];
  const around = (a: number, r: number) => ({ x: centre.x + Math.cos(a) * r, y: centre.y + Math.sin(a) * r });
  const inner = radius - LINE_WIDTH / 2;
  const outer = radius + LINE_WIDTH / 2;
  // A whole number of dashes, spaced evenly, so no gap is left over where the circle closes.
  const count = Math.max(1, Math.round((Math.PI * 2 * radius) / (DASH + GAP)));
  const pitch = (Math.PI * 2) / count;
  const dash = pitch * (DASH / (DASH + GAP));
  for (let i = 0; i < count; i++) {
    const a0 = i * pitch;
    const a1 = a0 + dash;
    quads.push([around(a0, inner), around(a1, inner), around(a1, outer), around(a0, outer)]);
  }
  return quads;
}

function sub(p: Vec2, q: Vec2): Vec2 {
  return { x: p.x - q.x, y: p.y - q.y };
}

function scale(v: Vec2, k: number): Vec2 {
  return { x: v.x * k, y: v.y * k };
}

function unit(v: Vec2): Vec2 {
  const len = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / len, y: v.y / len };
}
