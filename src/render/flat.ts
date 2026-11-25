import { BufferGeometry, DoubleSide, Float32BufferAttribute, MeshBasicMaterial, ShapeUtils, Vector2 } from "three";
import type { Vec2 } from "../core/geometry";

/**
 * Everything on the ground is flat and sits at y = 0. Instead of offsetting heights (which
 * flickers at a distance), flat layers skip depth writes and draw in a fixed order.
 * Future 3D objects (cars, buildings) use normal depth testing and draw on top.
 */
export const FlatLayer = {
  grid: 0,
  footpath: 1,
  asphalt: 2,
  markings: 3,
  /** Previews draw above everything; their own parts keep the same relative order. */
  overlay: 10,
} as const;

const CAP_SEGMENTS = 12;

export function flatMaterial(color: number, opacity = 1): MeshBasicMaterial {
  return new MeshBasicMaterial({
    color,
    opacity,
    transparent: opacity < 1,
    depthWrite: false,
    side: DoubleSide,
  });
}

/**
 * Triangles exactly covering the polygon `outline` (closed back to its start), whatever its shape:
 * kerbs along curved roads can fold back as seen from any single point, so a fan won't do.
 */
export function fill(outline: Vec2[]): Vec2[][] {
  const points = outline.filter((p, i) => i === 0 || Math.hypot(p.x - outline[i - 1].x, p.y - outline[i - 1].y) > 1e-3);
  while (points.length > 1 && Math.hypot(points[0].x - points[points.length - 1].x, points[0].y - points[points.length - 1].y) <= 1e-3) points.pop();
  if (points.length < 3) return [];
  const contour = points.map((p) => new Vector2(p.x, p.y));
  return ShapeUtils.triangulateShape(contour, []).map(([i, j, k]) => [points[i], points[j], points[k]]);
}

/** A strip of `width` from `a` to `b` with round caps, lying on the ground. A circle when a = b. */
export function capsuleGeometry(a: Vec2, b: Vec2, width: number): BufferGeometry {
  const h = width / 2;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const ux = len > 0 ? (b.x - a.x) / len : 1;
  const uy = len > 0 ? (b.y - a.y) / len : 0;
  // Sweep each cap from the left side (normal n) through the end direction to the right side.
  const angleN = Math.atan2(ux, -uy);
  const outline: Vec2[] = [];
  for (const [end, start] of [
    [b, angleN],
    [a, angleN - Math.PI],
  ] as const) {
    for (let i = 0; i <= CAP_SEGMENTS; i++) {
      const theta = start - (Math.PI * i) / CAP_SEGMENTS;
      outline.push({ x: end.x + h * Math.cos(theta), y: end.y + h * Math.sin(theta) });
    }
  }
  return convexGeometry([outline]);
}

/** Outline of a flat rectangle of `width` from `a` to `b` (no caps). */
export function stripOutline(a: Vec2, b: Vec2, width: number): Vec2[] {
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const nx = (-(b.y - a.y) / len) * (width / 2);
  const ny = ((b.x - a.x) / len) * (width / 2);
  return [
    { x: a.x + nx, y: a.y + ny },
    { x: b.x + nx, y: b.y + ny },
    { x: b.x - nx, y: b.y - ny },
    { x: a.x - nx, y: a.y - ny },
  ];
}

/**
 * One geometry holding several convex polygons (e.g. all dashes of a lane line), so they
 * cost a single draw call. World (x, y) maps to three.js (x, 0, y).
 */
export function convexGeometry(outlines: Vec2[][]): BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const outline of outlines) {
    // Triangle fan from the outline's centroid.
    const base = positions.length / 3;
    const cx = outline.reduce((sum, p) => sum + p.x, 0) / outline.length;
    const cy = outline.reduce((sum, p) => sum + p.y, 0) / outline.length;
    positions.push(cx, 0, cy);
    for (const p of outline) positions.push(p.x, 0, p.y);
    for (let i = 0; i < outline.length; i++) {
      indices.push(base, base + i + 1, base + ((i + 1) % outline.length) + 1);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  return geometry;
}
