export interface Vec2 {
  x: number;
  y: number;
}

export function snapToGrid(p: Vec2, step: number): Vec2 {
  return { x: Math.round(p.x / step) * step, y: Math.round(p.y / step) * step };
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Shortest distance from `p` to the line segment `a`–`b`. */
export function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return distance(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}

/** Whether `p` lies inside (or on) a convex polygon, given in either winding order. */
export function pointInConvexPolygon(p: Vec2, polygon: Vec2[]): boolean {
  let sign = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (cross === 0) continue;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return true;
}

/** Where segments p0–p1 and q0–q1 cross, as fractions along each; null if they don't. */
export function segmentCrossing(p0: Vec2, p1: Vec2, q0: Vec2, q1: Vec2): { u: number; v: number } | null {
  const rx = p1.x - p0.x, ry = p1.y - p0.y;
  const sx = q1.x - q0.x, sy = q1.y - q0.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const u = ((q0.x - p0.x) * sy - (q0.y - p0.y) * sx) / den;
  const v = ((q0.x - p0.x) * ry - (q0.y - p0.y) * rx) / den;
  return u >= 0 && u <= 1 && v >= 0 && v <= 1 ? { u, v } : null;
}

/** Whether segments p0–p1 and q0–q1 touch or cross. */
export function segmentsIntersect(p0: Vec2, p1: Vec2, q0: Vec2, q1: Vec2): boolean {
  const orient = (a: Vec2, b: Vec2, c: Vec2) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  const onSegment = (a: Vec2, b: Vec2, c: Vec2) =>
    Math.min(a.x, b.x) <= c.x && c.x <= Math.max(a.x, b.x) && Math.min(a.y, b.y) <= c.y && c.y <= Math.max(a.y, b.y);
  const d1 = orient(q0, q1, p0);
  const d2 = orient(q0, q1, p1);
  const d3 = orient(p0, p1, q0);
  const d4 = orient(p0, p1, q1);
  if (d1 !== d2 && d3 !== d4) return true;
  return (
    (d1 === 0 && onSegment(q0, q1, p0)) ||
    (d2 === 0 && onSegment(q0, q1, p1)) ||
    (d3 === 0 && onSegment(p0, p1, q0)) ||
    (d4 === 0 && onSegment(p0, p1, q1))
  );
}

/**
 * Whether two convex polygons overlap by more than `margin` (separating-axis test): polygons that
 * only touch, as neighbouring tiles sharing an edge, don't count.
 */
export function convexOverlap(a: Vec2[], b: Vec2[], margin = 0.5): boolean {
  for (const polygon of [a, b]) {
    for (let i = 0; i < polygon.length; i++) {
      const p = polygon[i];
      const q = polygon[(i + 1) % polygon.length];
      const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
      const axis = { x: (p.y - q.y) / len, y: (q.x - p.x) / len };
      const range = (poly: Vec2[]) => {
        const d = poly.map((v) => v.x * axis.x + v.y * axis.y);
        return [Math.min(...d), Math.max(...d)];
      };
      const [aMin, aMax] = range(a);
      const [bMin, bMax] = range(b);
      if (Math.min(aMax, bMax) - Math.max(aMin, bMin) <= margin) return false;
    }
  }
  return true;
}
