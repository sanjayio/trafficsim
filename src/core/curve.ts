import { distance, distanceToSegment, type Vec2 } from "./geometry";

/**
 * A road's centre line: a cubic Bézier from `a` to `b` shaped by `c1` and `c2`.
 * Straight roads have their controls on the line; quadratic curves are stored as cubics.
 */
export interface Curve {
  a: Vec2;
  c1: Vec2;
  c2: Vec2;
  b: Vec2;
}

const lerp = (p: Vec2, q: Vec2, t: number): Vec2 => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });

export function straightCurve(a: Vec2, b: Vec2): Curve {
  return { a, c1: lerp(a, b, 1 / 3), c2: lerp(a, b, 2 / 3), b };
}

/** The exact cubic form of the quadratic Bézier a → (control q) → b. */
export function quadraticCurve(a: Vec2, q: Vec2, b: Vec2): Curve {
  return { a, c1: lerp(a, q, 2 / 3), c2: lerp(b, q, 2 / 3), b };
}

export function reverseCurve(c: Curve): Curve {
  return { a: c.b, c1: c.c2, c2: c.c1, b: c.a };
}

/** True when both controls lie on the a–b line (within `tolerance` world units). */
export function isStraight(c: Curve, tolerance = 0.01): boolean {
  return distanceToSegment(c.c1, c.a, c.b) <= tolerance && distanceToSegment(c.c2, c.a, c.b) <= tolerance;
}

export function curvePoint(c: Curve, t: number): Vec2 {
  const m = 1 - t;
  const w0 = m * m * m;
  const w1 = 3 * m * m * t;
  const w2 = 3 * m * t * t;
  const w3 = t * t * t;
  return {
    x: w0 * c.a.x + w1 * c.c1.x + w2 * c.c2.x + w3 * c.b.x,
    y: w0 * c.a.y + w1 * c.c1.y + w2 * c.c2.y + w3 * c.b.y,
  };
}

function curveDerivative(c: Curve, t: number): Vec2 {
  const m = 1 - t;
  const w0 = 3 * m * m;
  const w1 = 6 * m * t;
  const w2 = 3 * t * t;
  return {
    x: w0 * (c.c1.x - c.a.x) + w1 * (c.c2.x - c.c1.x) + w2 * (c.b.x - c.c2.x),
    y: w0 * (c.c1.y - c.a.y) + w1 * (c.c2.y - c.c1.y) + w2 * (c.b.y - c.c2.y),
  };
}

function curveSecondDerivative(c: Curve, t: number): Vec2 {
  const m = 1 - t;
  return {
    x: 6 * m * (c.c2.x - 2 * c.c1.x + c.a.x) + 6 * t * (c.b.x - 2 * c.c2.x + c.c1.x),
    y: 6 * m * (c.c2.y - 2 * c.c1.y + c.a.y) + 6 * t * (c.b.y - 2 * c.c2.y + c.c1.y),
  };
}

/**
 * Right-hand normal of a direction. World y points down the screen (top-down, unrotated),
 * so facing +x, the right side is +y.
 */
export function rightNormal(u: Vec2): Vec2 {
  return { x: -u.y, y: u.x };
}

function normalize(v: Vec2): Vec2 {
  const len = Math.hypot(v.x, v.y);
  return len > 0 ? { x: v.x / len, y: v.y / len } : { x: 1, y: 0 };
}

/** Splits a curve at parameter t into two curves that together trace the same path (de Casteljau). */
export function splitCurve(c: Curve, t: number): [Curve, Curve] {
  const ab = lerp(c.a, c.c1, t);
  const bc = lerp(c.c1, c.c2, t);
  const cd = lerp(c.c2, c.b, t);
  const abc = lerp(ab, bc, t);
  const bcd = lerp(bc, cd, t);
  const mid = lerp(abc, bcd, t);
  return [
    { a: c.a, c1: ab, c2: abc, b: mid },
    { a: mid, c1: bcd, c2: cd, b: c.b },
  ];
}

/** The point `d` units to the right (negative: left) of the curve at parameter t. */
function offsetPoint(c: Curve, t: number, d: number): Vec2 {
  const p = curvePoint(c, t);
  const n = rightNormal(normalize(curveDerivative(c, t)));
  return { x: p.x + n.x * d, y: p.y + n.y * d };
}

const OFFSET_FIT_SAMPLES = 32;
const OFFSET_FIT_ITERATIONS = 4;
const OFFSET_MAX_DEPTH = 4;

/**
 * A parallel curve `d` units to the right (negative: left), as one or more cubic pieces that
 * join end to end. A single cubic can't follow every offset (an S-bend's, say), so a piece
 * that strays more than `tolerance` from the true offset is split in half and refitted.
 */
export function offsetCurve(c: Curve, d: number, tolerance = Math.max(0.5, Math.abs(d) * 0.01), depth = 0): Curve[] {
  const fit = fitOffset(c, d);
  if (depth >= OFFSET_MAX_DEPTH || isStraight(c)) return [fit];
  const sampled = new SampledCurve(fit);
  for (let i = 1; i < OFFSET_FIT_SAMPLES; i++) {
    if (sampled.distanceTo(offsetPoint(c, i / OFFSET_FIT_SAMPLES, d)) > tolerance) {
      const [first, second] = splitCurve(c, 0.5);
      return [...offsetCurve(first, d, tolerance, depth + 1), ...offsetCurve(second, d, tolerance, depth + 1)];
    }
  }
  return [fit];
}

/**
 * The single cubic closest to the curve's true offset: ends and end directions match exactly,
 * and the two control distances are a least-squares fit to sampled offset points, with the
 * samples' parameters refined by Newton steps so they line up with the fitted curve.
 */
function fitOffset(c: Curve, d: number): Curve {
  const n = OFFSET_FIT_SAMPLES;
  const t0 = normalize(curveDerivative(c, 0));
  const t3 = normalize(curveDerivative(c, 1));
  const pts = Array.from({ length: n + 1 }, (_, i) => offsetPoint(c, i / n, d));
  const p0 = pts[0];
  const p3 = pts[n];
  const straight = (): Curve => straightCurve(p0, p3);

  // Start from chord-length parameters.
  const lengths = [0];
  for (let i = 1; i <= n; i++) lengths.push(lengths[i - 1] + distance(pts[i - 1], pts[i]));
  const total = lengths[n];
  if (total < 1e-9) return straight();
  let params = lengths.map((l) => l / total);

  let fit = straight();
  for (let iteration = 0; iteration <= OFFSET_FIT_ITERATIONS; iteration++) {
    // B(t) = (w0 + w1)·p0 + (w2 + w3)·p3 + α·w1·t0 − β·w2·t3, linear in α and β.
    let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
    for (let i = 1; i < n; i++) {
      const t = params[i];
      const m = 1 - t;
      const w0 = m * m * m, w1 = 3 * m * m * t, w2 = 3 * m * t * t, w3 = t * t * t;
      const rx = pts[i].x - (w0 + w1) * p0.x - (w2 + w3) * p3.x;
      const ry = pts[i].y - (w0 + w1) * p0.y - (w2 + w3) * p3.y;
      const ux = w1 * t0.x, uy = w1 * t0.y;
      const vx = -w2 * t3.x, vy = -w2 * t3.y;
      a11 += ux * ux + uy * uy;
      a12 += ux * vx + uy * vy;
      a22 += vx * vx + vy * vy;
      b1 += ux * rx + uy * ry;
      b2 += vx * rx + vy * ry;
    }
    const det = a11 * a22 - a12 * a12;
    if (Math.abs(det) < 1e-12) return straight();
    const alpha = (b1 * a22 - b2 * a12) / det;
    const beta = (a11 * b2 - a12 * b1) / det;
    fit = { a: p0, c1: { x: p0.x + alpha * t0.x, y: p0.y + alpha * t0.y }, c2: { x: p3.x - beta * t3.x, y: p3.y - beta * t3.y }, b: p3 };

    // Newton step per sample towards the closest point on the current fit.
    params = params.map((t, i) => {
      if (i === 0 || i === n) return t;
      const e = curvePoint(fit, t);
      const d1 = curveDerivative(fit, t);
      const d2 = curveSecondDerivative(fit, t);
      const ex = e.x - pts[i].x, ey = e.y - pts[i].y;
      const denominator = d1.x * d1.x + d1.y * d1.y + ex * d2.x + ey * d2.y;
      if (Math.abs(denominator) < 1e-12) return t;
      return Math.min(1, Math.max(0, t - (ex * d1.x + ey * d1.y) / denominator));
    });
  }
  return fit;
}

export interface PathFrame {
  p: Vec2;
  /** Unit direction of travel (a → b). */
  tangent: Vec2;
  /** Unit right-hand normal. */
  normal: Vec2;
}

interface Sample extends PathFrame {
  /** Arc length from `a`. */
  s: number;
  /** Bézier parameter. */
  t: number;
}

/** The closest point on a path to some query point. */
export interface NearestPoint {
  point: Vec2;
  distance: number;
  /** Arc length and Bézier parameter of `point`. */
  s: number;
  t: number;
}

/** A point where two paths cross, with each path's parameter there. */
export interface PathIntersection {
  point: Vec2;
  tA: number;
  tB: number;
  /** Unit directions of travel of each path at the crossing. */
  tangentA: Vec2;
  tangentB: Vec2;
}

const SAMPLE_STEP = 4;
const MAX_SAMPLES = 512;

/**
 * A curve sampled into a dense polyline with arc lengths, so geometry and (later) vehicles
 * can work in distance along the road instead of the Bézier parameter.
 */
export class SampledCurve {
  readonly samples: Sample[] = [];
  readonly length: number;
  /** Tightest radius of curvature along the curve (Infinity for straight roads). */
  readonly minRadius: number;
  /** Axis-aligned bounds of the centre line, for cheap rejection in hit tests. */
  readonly bounds: { minX: number; minY: number; maxX: number; maxY: number };

  constructor(readonly curve: Curve) {
    const chord = distance(curve.a, curve.c1) + distance(curve.c1, curve.c2) + distance(curve.c2, curve.b);
    const n = Math.min(MAX_SAMPLES, Math.max(1, Math.ceil(chord / SAMPLE_STEP)));
    let s = 0;
    let prev: Vec2 | null = null;
    let minRadius = Infinity;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const p = curvePoint(curve, t);
      const d1 = curveDerivative(curve, t);
      if (prev) s += distance(prev, p);
      const tangent = normalize(Math.hypot(d1.x, d1.y) > 1e-9 ? d1 : { x: curve.b.x - curve.a.x, y: curve.b.y - curve.a.y });
      this.samples.push({ s, t, p, tangent, normal: rightNormal(tangent) });
      prev = p;

      const d2 = curveSecondDerivative(curve, t);
      const speed = Math.hypot(d1.x, d1.y);
      const cross = Math.abs(d1.x * d2.y - d1.y * d2.x);
      if (speed > 1e-6 && cross > 1e-9) minRadius = Math.min(minRadius, (speed * speed * speed) / cross);
    }
    this.length = s;
    this.minRadius = minRadius;
    const xs = this.samples.map((q) => q.p.x);
    const ys = this.samples.map((q) => q.p.y);
    this.bounds = { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
  }

  /** Position and direction at arc length `s` (clamped to the curve). */
  at(s: number): PathFrame {
    const { samples } = this;
    if (s <= 0) return samples[0];
    if (s >= this.length) return samples[samples.length - 1];
    let lo = 0;
    let hi = samples.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (samples[mid].s <= s) lo = mid;
      else hi = mid;
    }
    const q0 = samples[lo];
    const q1 = samples[hi];
    const t = (s - q0.s) / (q1.s - q0.s || 1);
    const tangent = normalize(lerp(q0.tangent, q1.tangent, t));
    return { p: lerp(q0.p, q1.p, t), tangent, normal: rightNormal(tangent) };
  }

  /** Arc lengths of the stored samples strictly between `s0` and `s1`. */
  stationsBetween(s0: number, s1: number): number[] {
    return this.samples.filter((q) => q.s > s0 && q.s < s1).map((q) => q.s);
  }

  distanceTo(p: Vec2): number {
    return this.nearest(p).distance;
  }

  nearest(p: Vec2): NearestPoint {
    let best: NearestPoint = { point: this.samples[0].p, distance: Infinity, s: 0, t: 0 };
    for (let i = 1; i < this.samples.length; i++) {
      const q0 = this.samples[i - 1];
      const q1 = this.samples[i];
      const dx = q1.p.x - q0.p.x;
      const dy = q1.p.y - q0.p.y;
      const lenSq = dx * dx + dy * dy;
      const k = lenSq > 0 ? Math.max(0, Math.min(1, ((p.x - q0.p.x) * dx + (p.y - q0.p.y) * dy) / lenSq)) : 0;
      const point = { x: q0.p.x + dx * k, y: q0.p.y + dy * k };
      const d = distance(p, point);
      if (d < best.distance) best = { point, distance: d, s: q0.s + (q1.s - q0.s) * k, t: q0.t + (q1.t - q0.t) * k };
    }
    return best;
  }

  /** Points where this path crosses `other` (polyline intersection; near-duplicates merged). */
  intersections(other: SampledCurve): PathIntersection[] {
    const a = this.bounds;
    const b = other.bounds;
    if (a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY) return [];
    const hits: PathIntersection[] = [];
    for (let i = 1; i < this.samples.length; i++) {
      const p0 = this.samples[i - 1];
      const p1 = this.samples[i];
      const minX = Math.min(p0.p.x, p1.p.x), maxX = Math.max(p0.p.x, p1.p.x);
      const minY = Math.min(p0.p.y, p1.p.y), maxY = Math.max(p0.p.y, p1.p.y);
      // This piece nowhere near the other path: none of its pieces can cross it.
      if (maxX < b.minX || minX > b.maxX || maxY < b.minY || minY > b.maxY) continue;
      for (let j = 1; j < other.samples.length; j++) {
        const q0 = other.samples[j - 1];
        const q1 = other.samples[j];
        if (Math.max(q0.p.x, q1.p.x) < minX || Math.min(q0.p.x, q1.p.x) > maxX) continue;
        if (Math.max(q0.p.y, q1.p.y) < minY || Math.min(q0.p.y, q1.p.y) > maxY) continue;
        const hit = segmentIntersection(p0.p, p1.p, q0.p, q1.p);
        if (!hit) continue;
        const point = { x: p0.p.x + (p1.p.x - p0.p.x) * hit.u, y: p0.p.y + (p1.p.y - p0.p.y) * hit.u };
        if (hits.some((h) => distance(h.point, point) < 1)) continue;
        hits.push({
          point,
          tA: p0.t + (p1.t - p0.t) * hit.u,
          tB: q0.t + (q1.t - q0.t) * hit.v,
          tangentA: normalize(lerp(p0.tangent, p1.tangent, hit.u)),
          tangentB: normalize(lerp(q0.tangent, q1.tangent, hit.v)),
        });
      }
    }
    return hits;
  }
}

/** Where segments p0–p1 and q0–q1 cross, as fractions along each (inclusive), or null. */
function segmentIntersection(p0: Vec2, p1: Vec2, q0: Vec2, q1: Vec2): { u: number; v: number } | null {
  const rx = p1.x - p0.x, ry = p1.y - p0.y;
  const sx = q1.x - q0.x, sy = q1.y - q0.y;
  const denominator = rx * sy - ry * sx;
  if (Math.abs(denominator) < 1e-12) return null;
  const qpx = q0.x - p0.x, qpy = q0.y - p0.y;
  const u = (qpx * sy - qpy * sx) / denominator;
  const v = (qpx * ry - qpy * rx) / denominator;
  return u >= 0 && u <= 1 && v >= 0 && v <= 1 ? { u, v } : null;
}

/**
 * A curve leaving `start` in direction `tangent` (unit) and ending at `end`, with no kink at
 * the start: a quadratic whose control sits on the tangent line, equidistant from both ends
 * (close to a circular arc). Null when `end` is behind or beside the start direction.
 */
export function tangentArc(start: Vec2, tangent: Vec2, end: Vec2): Curve | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const along = dx * tangent.x + dy * tangent.y;
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-6 || along <= chord * 0.05) return null;
  const k = (chord * chord) / (2 * along);
  return quadraticCurve(start, { x: start.x + tangent.x * k, y: start.y + tangent.y * k }, end);
}

/** Direction of travel at the end of a curve. */
export function endTangent(c: Curve): Vec2 {
  return normalize(curveDerivative(c, 1));
}
