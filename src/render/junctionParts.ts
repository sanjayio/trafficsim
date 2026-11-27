import type { BufferGeometry } from "three";
import { segmentCrossing, type Vec2 } from "../core/geometry";
import { convexGeometry, fill, KERB_WIDTH, pavedGeometry } from "./flat";

/** One road as it leaves a junction. */
export interface JunctionArm {
  /** Unit direction the road leaves the junction in. */
  dir: Vec2;
  /** Half the drivable width (lanes and median). */
  halfWidth: number;
  /** Footpath width each side (0 without footpaths). */
  footpath: number;
  /** Length of the road, which limits how far a corner can reach along it. */
  length: number;
  /**
   * Point `along` units from the junction along the road, `offset` units to the right of the
   * direction leaving the junction. Follows the road's curve, so corners hug curved edges.
   */
  edge: (offset: number, along: number) => Vec2;
}

/** A corner may use at most this fraction of either road's length. */
const MAX_CORNER_SHARE = 0.4;
/** Roads this close to straight-through (radians short of 180°) leave no corner to round. */
const STRAIGHT_THROUGH = (10 * Math.PI) / 180;
/** How far along each road its edge is traced when looking for the corner, and the step. */
const EDGE_REACH = 320;
const EDGE_STEP = 2;
const ARC_SEGMENTS = 12;

type Polyline = Vec2[];

/**
 * Fills the sharp inside corners between neighbouring roads at a junction (or a bend where two
 * roads meet) up to a smooth kerb curve tangent to both road edges. Edges are traced along each
 * road's actual (possibly curved) shape, so corners stay flush with curved roads.
 */
export function buildJunctionParts(
  arms: JunctionArm[],
  /** Kerb radius at the corners (the footpath's back edge is concentric, this minus the footpath width); 0 for sharp corners. */
  cornerRadius: number,
): {
  parts: { part: "asphalt" | "footpath"; geometry: BufferGeometry }[];
  /**
   * Per arm (same order as `arms`), how far along it the junction's paved corners reach, so its
   * markings can start clear of the junction.
   */
  reach: number[];
  /** Each corner's outer edge (the footpath's back, or the kerb without one: `footpath`): where a bridge's or tunnel's walls go round it. */
  corners: { edge: Vec2[]; footpath: boolean }[];
  /** Per arm, how far along it the corners on its right and left (leaving the junction) start: its walls stop there. */
  sides: { right: number; left: number }[];
} {
  const reachOut = arms.map(() => 0);
  const corners: { edge: Vec2[]; footpath: boolean }[] = [];
  const sides = arms.map(() => ({ right: 0, left: 0 }));
  if (arms.length < 2) return { parts: [], reach: reachOut, corners, sides };
  const angleOf = (a: JunctionArm) => Math.atan2(a.dir.y, a.dir.x);
  const order = arms.map((_, i) => i).sort((p, q) => angleOf(arms[p]) - angleOf(arms[q]));
  const asphalt: Vec2[][] = [];
  const footpath: Vec2[][] = [];
  const kerbs: Vec2[][] = [];
  // The kerb's face round each corner (the roads' own run along their edges).
  const faces: Vec2[][] = [];

  for (let k = 0; k < order.length; k++) {
    const ia = order[k];
    const ib = order[(k + 1) % order.length];
    const a = arms[ia];
    const b = arms[ib];
    let gap = angleOf(b) - angleOf(a);
    if (gap <= 0) gap += Math.PI * 2;
    if (gap >= Math.PI - STRAIGHT_THROUGH) continue;

    const reach = Math.min(EDGE_REACH, a.length * MAX_CORNER_SHARE * 2, b.length * MAX_CORNER_SHARE * 2);
    const maxShare = Math.min(a.length, b.length) * MAX_CORNER_SHARE;
    // a's right edge and b's left edge face each other across the gap.
    const kerb = fillet(trace(a, a.halfWidth, reach), trace(b, -b.halfWidth, reach), cornerRadius, maxShare);
    if (kerb) {
      asphalt.push(...kerb.triangles);
      reachOut[ia] = Math.max(reachOut[ia], kerb.alongA);
      reachOut[ib] = Math.max(reachOut[ib], kerb.alongB);
    }

    const walk = Math.min(a.footpath, b.footpath);
    if (walk > 0 && kerb) {
      // The footpath's back edge follows the kerb round (concentric with it), by the kerb's actual
      // radius: a corner squeezed between short roads is tighter than asked for.
      const outer = fillet(
        trace(a, a.halfWidth + walk, reach),
        trace(b, -(b.halfWidth + walk), reach),
        kerb.radius - walk,
        maxShare,
      );
      if (outer) {
        footpath.push(...outer.triangles);
        corners.push({ edge: outer.curve, footpath: true });
        sides[ia].right = outer.alongA;
        sides[ib].left = outer.alongB;
      }
      // The kerb stones round the corner, the same way (the asphalt covers all but their outer edge).
      const stones = fillet(
        trace(a, a.halfWidth + KERB_WIDTH, reach),
        trace(b, -(b.halfWidth + KERB_WIDTH), reach),
        kerb.radius - KERB_WIDTH,
        maxShare,
      );
      if (stones) kerbs.push(...stones.triangles);
      faces.push(kerb.curve);
    } else if (kerb) {
      corners.push({ edge: kerb.curve, footpath: false });
      sides[ia].right = kerb.alongA;
      sides[ib].left = kerb.alongB;
    }
  }

  const parts: { part: "asphalt" | "footpath"; geometry: BufferGeometry }[] = [];
  if (footpath.length) parts.push({ part: "footpath", geometry: pavedGeometry(footpath, kerbs, faces) });
  if (asphalt.length) parts.push({ part: "asphalt", geometry: convexGeometry(asphalt) });
  return { parts, reach: reachOut, corners, sides };
}

/** An arm's edge `offset` right of its direction, from the junction outwards. */
function trace(arm: JunctionArm, offset: number, reach: number): Polyline {
  const points: Polyline = [];
  for (let d = 0; d < reach; d += EDGE_STEP) points.push(arm.edge(offset, d));
  points.push(arm.edge(offset, reach));
  return points;
}

/**
 * Triangles filling the sharp corner where two edges cross, up to a kerb curve that leaves each
 * edge tangentially about `radius` (scaled by the corner's angle) from the corner, plus how far
 * from the junction (along each road) the kerb meets its edge. Null when the edges don't cross
 * within reach.
 */
function fillet(
  edgeA: Polyline,
  edgeB: Polyline,
  radius: number,
  maxShare: number,
): { triangles: Vec2[][]; curve: Vec2[]; alongA: number; alongB: number; radius: number } | null {
  if (radius <= 0.5) return null;
  const crossing = crossPolylines(edgeA, edgeB);
  if (!crossing) return null;
  const { point: corner, i, j } = crossing;
  // Each edge beyond the corner, heading away from the junction.
  const restA = [corner, ...edgeA.slice(i + 1)];
  const restB = [corner, ...edgeB.slice(j + 1)];

  // Over a whole step: the corner can fall just short of a traced point, leaving a first leg too
  // short to give a direction (and a wrong angle, and so a far wider corner than asked for).
  const ahead = (rest: Polyline) => walk(rest, EDGE_STEP).slice(-1);
  const dirA = direction([corner, ...ahead(restA)]);
  const dirB = direction([corner, ...ahead(restB)]);
  const cos = Math.max(-1, Math.min(1, dirA.x * dirB.x + dirA.y * dirB.y));
  const halfGap = Math.acos(cos) / 2;
  if (halfGap < 1e-3 || halfGap > Math.PI / 2 - STRAIGHT_THROUGH / 2) return null;
  const tangentLength = Math.min(radius / Math.tan(halfGap), maxShare, length(restA), length(restB));
  if (tangentLength <= 0.5) return null;

  const sideA = walk(restA, tangentLength);
  const sideB = walk(restB, tangentLength);
  const t1 = sideA[sideA.length - 1];
  const t2 = sideB[sideB.length - 1];
  // Quadratic kerb from t1 to t2 whose control is where the edges' tangents there meet, so it
  // leaves both edges without a kink (for straight edges, that's the corner itself).
  const meet = lineIntersection(t1, direction(sideA.slice(-2)), t2, direction(sideB.slice(-2)));
  // Nearly parallel tangents meet far off; the corner is a safe stand-in.
  const control = meet && Math.hypot(meet.x - corner.x, meet.y - corner.y) <= tangentLength * 2 ? meet : corner;
  const kerb: Vec2[] = [];
  for (let k = 0; k <= ARC_SEGMENTS; k++) {
    const t = k / ARC_SEGMENTS;
    const m = 1 - t;
    kerb.push({
      x: m * m * t1.x + 2 * m * t * control.x + t * t * t2.x,
      y: m * m * t1.y + 2 * m * t * control.y + t * t * t2.y,
    });
  }

  // Boundary: corner → along a's edge → kerb → back along b's edge. Triangulated rather than fanned
  // from the corner: along curved roads a wide kerb's outline can fold back as seen from it.
  const triangles = fill([...sideA, ...kerb.slice(1, -1), ...sideB.slice(1).reverse()]);
  return {
    triangles,
    curve: kerb,
    alongA: alongAt(edgeA, i, corner) + tangentLength,
    alongB: alongAt(edgeB, j, corner) + tangentLength,
    // The radius it was drawn with (smaller than asked for where the roads are short).
    radius: tangentLength * Math.tan(halfGap),
  };
}

/** Distance from the junction (along the road) of `point`, which lies on traced segment `index`. */
function alongAt(edge: Polyline, index: number, point: Vec2): number {
  // Traced points sit EDGE_STEP apart along the road (the last leg may be shorter).
  const from = edge[index];
  const to = edge[index + 1];
  const leg = Math.hypot(to.x - from.x, to.y - from.y);
  const fraction = leg > 0 ? Math.hypot(point.x - from.x, point.y - from.y) / leg : 0;
  return (index + fraction) * EDGE_STEP;
}

/** First crossing of two polylines, with the indices of the crossing segments' starts. */
function crossPolylines(p: Polyline, q: Polyline): { point: Vec2; i: number; j: number } | null {
  for (let i = 1; i < p.length; i++) {
    for (let j = 1; j < q.length; j++) {
      const hit = segmentCrossing(p[i - 1], p[i], q[j - 1], q[j]);
      if (hit) {
        const [a, b] = [p[i - 1], p[i]];
        return { point: { x: a.x + (b.x - a.x) * hit.u, y: a.y + (b.y - a.y) * hit.u }, i: i - 1, j: j - 1 };
      }
    }
  }
  return null;
}

/** The polyline from its start up to arc length `distance` (ending exactly there). */
function walk(line: Polyline, distance: number): Polyline {
  const out = [line[0]];
  let left = distance;
  for (let k = 1; k < line.length; k++) {
    const step = Math.hypot(line[k].x - line[k - 1].x, line[k].y - line[k - 1].y);
    if (step >= left) {
      const f = step > 0 ? left / step : 0;
      out.push({ x: line[k - 1].x + (line[k].x - line[k - 1].x) * f, y: line[k - 1].y + (line[k].y - line[k - 1].y) * f });
      return out;
    }
    out.push(line[k]);
    left -= step;
  }
  return out;
}

function length(line: Polyline): number {
  let total = 0;
  for (let k = 1; k < line.length; k++) total += Math.hypot(line[k].x - line[k - 1].x, line[k].y - line[k - 1].y);
  return total;
}

/** Unit direction of a polyline's first leg (or of a two-point slice). */
function direction(line: Polyline): Vec2 {
  const a = line[0];
  const b = line[Math.min(1, line.length - 1)];
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
}

/** Intersection of the lines p + s·u and q + t·v (null when parallel). */
function lineIntersection(p: Vec2, u: Vec2, q: Vec2, v: Vec2): Vec2 | null {
  const cross = u.x * v.y - u.y * v.x;
  if (Math.abs(cross) < 1e-9) return null;
  const s = ((q.x - p.x) * v.y - (q.y - p.y) * v.x) / cross;
  return { x: p.x + u.x * s, y: p.y + u.y * s };
}
