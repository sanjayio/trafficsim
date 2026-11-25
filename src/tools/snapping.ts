import { rampLength } from "../core/grade";
import { GRID_SIZE, NODE_SNAP_RADIUS } from "../core/constants";
import { rightNormal, SampledCurve, straightCurve } from "../core/curve";
import { distance, snapToGrid, type Vec2 } from "../core/geometry";
import type { RoadGraph } from "../core/roadGraph";

/** An infinite line through `origin` along unit direction `dir`. */
export interface Guide {
  origin: Vec2;
  dir: Vec2;
}

export interface SnapResult {
  point: Vec2;
  /** Guidelines the point snapped to (to draw them). */
  guides: Guide[];
}

export interface SnapOptions {
  graph: RoadGraph;
  /** Snap to the grid when nothing better applies. */
  grid: boolean;
  /** Snap onto roads, guidelines and angles. */
  guides: boolean;
  /** How close (world units) the cursor must be for magnetic snaps; scales with zoom. */
  tolerance: number;
  /** Road ends attach to existing nodes and roads; bend points don't. */
  isRoadEnd: boolean;
  /** The previous point of the road being drawn, for angle guidelines. */
  from?: { point: Vec2; reference: Vec2 };
}

/** Angle guidelines from the previous point, relative to its reference direction. */
const ANGLE_STEP = Math.PI / 4;
/** Nodes this far from the cursor (in world units) contribute guidelines. */
const GUIDE_REACH = 800;
const MAX_GUIDE_NODES = 24;
/** Two guidelines only snap to their crossing if it's this much closer than `tolerance` allows. */
const CROSSING_TOLERANCE_FACTOR = 1.5;
/**
 * Guidelines must cross at least this steeply (sine of the angle, ~30°) to snap to their crossing.
 * Nearly parallel lines cross at a point that slides far with tiny changes, so it's no use.
 */
const MIN_CROSSING_SINE = 0.5;

/**
 * Where a click at `p` should go, in priority order:
 * 1. an existing road end (nodes) — road ends only
 * 2. a point on an existing road's centre line, forming a T-junction — road ends, with guides on
 * 3. where two guidelines cross, then a single guideline — with guides on
 * 4. the grid, when enabled; otherwise exactly `p` (to 0.01 units)
 */
export function snapPoint(p: Vec2, o: SnapOptions): SnapResult {
  if (o.isRoadEnd) {
    const node = o.graph.nodeNear(p, Math.max(NODE_SNAP_RADIUS, o.tolerance));
    if (node) return { point: { x: node.x, y: node.y }, guides: [] };
  }

  if (o.guides) {
    const near = guidesNear(p, o).filter((g) => distanceToLine(p, g) <= o.tolerance);

    if (o.isRoadEnd) {
      const segment = o.graph.segmentAt(p);
      if (segment && !segment.spec.level) return snapOntoRoad(p, o.graph.path(segment), near, o);
      // A bridge or tunnel can only be joined at its ends: over either ramp, to that end.
      if (segment) {
        const path = o.graph.path(segment);
        const s = path.nearest(p).s;
        const ramp = rampLength(segment.spec.level!, path.length);
        const end = s <= ramp ? segment.a : path.length - s <= ramp ? segment.b : null;
        if (end !== null) {
          const node = o.graph.node(end);
          return { point: { x: node.x, y: node.y }, guides: [] };
        }
      }
    }

    let best: SnapResult | null = null;
    for (let i = 0; i < near.length; i++) {
      for (let j = i + 1; j < near.length; j++) {
        if (Math.abs(near[i].dir.x * near[j].dir.y - near[i].dir.y * near[j].dir.x) < MIN_CROSSING_SINE) continue;
        const x = lineIntersection(near[i], near[j]);
        if (!x || distance(x, p) > o.tolerance * CROSSING_TOLERANCE_FACTOR) continue;
        if (!best || distance(x, p) < distance(best.point, p)) best = { point: x, guides: [near[i], near[j]] };
      }
    }
    if (best) return best;
    if (near.length) {
      const closest = near.reduce((a, b) => (distanceToLine(p, a) <= distanceToLine(p, b) ? a : b));
      return { point: projectOntoLine(p, closest), guides: [closest] };
    }
  }

  return { point: snapToGrid(p, o.grid ? GRID_SIZE : 0.01), guides: [] };
}

/**
 * Where on a road (its centre line) to attach a road end aimed at `p`: where a nearby guideline
 * crosses it (so e.g. a 90° guide from the start gives a square T-junction), else level with the
 * nearest grid point when the grid is on, else straight under the cursor.
 */
function snapOntoRoad(p: Vec2, road: SampledCurve, near: Guide[], o: SnapOptions): SnapResult {
  let best: SnapResult | null = null;
  const reach = o.tolerance * 4;
  const along = road.at(road.nearest(p).s).tangent;
  for (const g of near) {
    // A guideline running along the road (e.g. its own extension) has no single crossing point.
    if (Math.abs(g.dir.x * along.y - g.dir.y * along.x) < MIN_CROSSING_SINE) continue;
    const at = projectOntoLine(p, g);
    const span = new SampledCurve(
      straightCurve(
        { x: at.x - g.dir.x * reach, y: at.y - g.dir.y * reach },
        { x: at.x + g.dir.x * reach, y: at.y + g.dir.y * reach },
      ),
    );
    for (const hit of span.intersections(road)) {
      if (!best || distance(hit.point, p) < distance(best.point, p)) best = { point: hit.point, guides: [g] };
    }
  }
  if (best) return best;
  return { point: road.nearest(o.grid ? snapToGrid(p, GRID_SIZE) : p).point, guides: [] };
}

/**
 * The direction angles are measured from at `point`: the road leaving an existing node there; on
 * a road (a road started partway along one, as a T-junction), that road's direction there, so its
 * guidelines include the square-on one; otherwise east (+x).
 */
export function referenceDirection(graph: RoadGraph, point: Vec2): Vec2 {
  const node = graph.nodeNear(point, 0.5);
  const segment = node ? graph.segmentsAt(node.id)[0] : undefined;
  if (segment) return graph.directionAway(segment, node!.id);
  const road = graph.segmentAt(point);
  if (road) {
    const path = graph.path(road);
    const nearest = path.nearest(point);
    if (nearest.distance < 0.5) return path.at(nearest.s).tangent;
  }
  return { x: 1, y: 0 };
}

/** Unsigned angle between two directions, in whole degrees (0–180). */
export function angleBetween(u: Vec2, v: Vec2): number {
  const lu = Math.hypot(u.x, u.y);
  const lv = Math.hypot(v.x, v.y);
  if (lu === 0 || lv === 0) return 0;
  const cos = Math.max(-1, Math.min(1, (u.x * v.x + u.y * v.y) / (lu * lv)));
  return Math.round((Math.acos(cos) * 180) / Math.PI);
}

function guidesNear(p: Vec2, o: SnapOptions): Guide[] {
  const guides: Guide[] = [];
  if (o.from) {
    const base = Math.atan2(o.from.reference.y, o.from.reference.x);
    // Steps k and k + 4 lie on the same line, so four lines cover every 45°.
    for (let k = 0; k < 4; k++) {
      const a = base + k * ANGLE_STEP;
      guides.push({ origin: o.from.point, dir: { x: Math.cos(a), y: Math.sin(a) } });
    }
  }

  // Each road end nearby extends straight on, and has a perpendicular through it.
  const nodes = [...o.graph.nodes.values()]
    .map((node) => ({ node, d: distance(node, p) }))
    .filter(({ d }) => d <= GUIDE_REACH)
    .sort((a, b) => a.d - b.d)
    .slice(0, MAX_GUIDE_NODES);
  for (const { node } of nodes) {
    for (const segment of o.graph.segmentsAt(node.id)) {
      const dir = o.graph.directionAway(segment, node.id);
      guides.push({ origin: { x: node.x, y: node.y }, dir }, { origin: { x: node.x, y: node.y }, dir: rightNormal(dir) });
    }
  }
  return guides;
}

function projectOntoLine(p: Vec2, g: Guide): Vec2 {
  const k = (p.x - g.origin.x) * g.dir.x + (p.y - g.origin.y) * g.dir.y;
  return { x: g.origin.x + g.dir.x * k, y: g.origin.y + g.dir.y * k };
}

function distanceToLine(p: Vec2, g: Guide): number {
  return Math.abs((p.x - g.origin.x) * g.dir.y - (p.y - g.origin.y) * g.dir.x);
}

function lineIntersection(g: Guide, h: Guide): Vec2 | null {
  const cross = g.dir.x * h.dir.y - g.dir.y * h.dir.x;
  if (Math.abs(cross) < 1e-6) return null;
  const t = ((h.origin.x - g.origin.x) * h.dir.y - (h.origin.y - g.origin.y) * h.dir.x) / cross;
  return { x: g.origin.x + g.dir.x * t, y: g.origin.y + g.dir.y * t };
}
