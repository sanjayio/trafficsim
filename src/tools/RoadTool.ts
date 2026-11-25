import { MIN_ROAD_LENGTH, NODE_SNAP_RADIUS } from "../core/constants";
import {
  endTangent,
  offsetCurve,
  quadraticCurve,
  reverseCurve,
  SampledCurve,
  straightCurve,
  tangentArc,
  type Curve,
} from "../core/curve";
import { distance, type Vec2 } from "../core/geometry";
import type { Crossing } from "../core/roadGraph";
import { roadWidth, type RoadSpec } from "../core/roadSpec";
import { palette } from "../render/palette";
import { angleBetween, referenceDirection, snapPoint, type Guide } from "./snapping";
import type { RoadMode, Tool, ToolContext } from "./Tool";

const CLICKS: Record<RoadMode, number> = { straight: 2, curve: 3, complex: 4, continuous: 2 };
/** How far a drawn guideline runs past the snapped point, in screen pixels. */
const GUIDE_OVERSHOOT = 120;

interface PlannedRoad {
  /** Null when the clicks can't make a road (continuous mode clicked behind the current direction). */
  curve: Curve | null;
  spec: RoadSpec;
  valid: boolean;
  crossings: Crossing[];
}

/**
 * Click-click road building, like Cities: Skylines 2:
 * - straight: start, end
 * - curve: start, bend point, end (quadratic Bézier)
 * - complex: start, two bend points, end (cubic Bézier, allows S-bends)
 * - continuous: start, end, then each further click adds a curve leaving smoothly from the last
 * Points snap to road ends, onto roads (T-junctions), to guidelines and angles, then the grid.
 * Built roads form junctions where they cross or end on existing roads. With parallel on, a
 * copy is built offset to the side (a one-way copy runs the opposite way, forming a divided road).
 * Right-click steps back one point (or ends a continuous chain); Esc cancels.
 */
export class RoadTool implements Tool {
  private points: Vec2[] = [];
  /** Continuous mode: direction the chain left off in, once its first road is built. */
  private chainTangent: Vec2 | null = null;

  constructor(private ctx: ToolContext) {}

  onDown(p: Vec2): void {
    const isEnd = this.points.length === CLICKS[this.ctx.roadMode()] - 1;
    const { point, guides } = this.snap(p, isEnd);
    const last = this.points[this.points.length - 1];
    // A click on the previous point adds nothing, so the road stays in progress.
    if (last && distance(last, point) < 1) return this.drawPreview(point, guides);

    if (!isEnd) {
      this.points.push(point);
      return this.drawPreview(point, guides);
    }

    const roads = this.plan([...this.points, point]);
    if (!roads.every((r) => r.valid)) return this.drawPreview(point, guides);
    for (const road of roads) this.ctx.graph.buildRoad(road.curve!, road.spec);

    if (this.ctx.roadMode() === "continuous") {
      // Carry on from the end, in the direction the road arrived.
      this.chainTangent = endTangent(roads[0].curve!);
      this.points = [point];
    } else {
      this.points = [];
    }
    this.drawPreview(point, guides);
  }

  onMove(p: Vec2): void {
    const { point, guides } = this.snap(p, this.points.length === CLICKS[this.ctx.roadMode()] - 1);
    this.drawPreview(point, guides);
  }

  onUp(): void {}

  busy(): boolean {
    return this.points.length > 0;
  }

  back(): void {
    // In a continuous chain the only placed point is the chain's end, so stepping back ends it.
    if (this.chainTangent) return this.cancel();
    this.points.pop();
    if (this.points.length === 0) this.cancel();
  }

  cancel(): void {
    this.points = [];
    this.chainTangent = null;
    this.ctx.overlay.clear();
    this.ctx.setHint(null);
  }

  private snap(p: Vec2, isEnd: boolean): { point: Vec2; guides: Guide[] } {
    const isRoadEnd = this.points.length === 0 || isEnd;
    const previous = this.points[this.points.length - 1];
    // A continuous chain's direction is fixed, so angle guidelines would only fight it.
    const from = previous && !this.chainTangent ? { point: previous, reference: this.reference() } : undefined;
    return snapPoint(p, {
      graph: this.ctx.graph,
      grid: this.ctx.snapToGrid(),
      guides: this.ctx.guideSnapping(),
      tolerance: this.ctx.snapTolerance(),
      isRoadEnd,
      from,
    });
  }

  /** Direction the drawn road's angle is measured from: its continuous chain, else the road it starts on. */
  private reference(): Vec2 {
    return this.chainTangent ?? referenceDirection(this.ctx.graph, this.points[0]);
  }

  /** The road(s) these clicks would build — the main road and its parallel copy — and whether they can be. */
  private plan(points: Vec2[]): PlannedRoad[] {
    const spec = this.ctx.roadSpec();
    const main = this.curveThrough(points);
    const curves: (Curve | null)[] = [main];

    const offset = this.ctx.parallelOffset();
    if (offset !== null && main) {
      // The copy may be several joined pieces (see offsetCurve). Attach its outer ends to
      // existing nodes too, so parallel roads chain together.
      const pieces = offsetCurve(main, offset);
      const attach = (q: Vec2) => {
        const node = this.ctx.graph.nodeNear(q, NODE_SNAP_RADIUS);
        return node ? { x: node.x, y: node.y } : q;
      };
      pieces[0] = { ...pieces[0], a: attach(pieces[0].a) };
      pieces[pieces.length - 1] = { ...pieces[pieces.length - 1], b: attach(pieces[pieces.length - 1].b) };
      // A one-way copy runs the opposite way, so the pair forms a divided road.
      curves.push(...(spec.oneWay ? pieces.map(reverseCurve).reverse() : pieces));
    }

    const width = roadWidth(spec);
    const overlapping = offset !== null && Math.abs(offset) < width;
    return curves.map((curve) => {
      if (!curve) return { curve, spec, valid: false, crossings: [] };
      const path = new SampledCurve(curve);
      const junctions = this.ctx.graph.planRoad(curve);
      // Too short, folded over itself on a tight bend, overlapping its parallel copy, or making a bad junction.
      const valid =
        path.length >= MIN_ROAD_LENGTH && path.minRadius >= width / 2 && !overlapping && junctions.valid;
      return { curve, spec, valid, crossings: junctions.crossings };
    });
  }

  /** Straight line, quadratic, cubic, or (continuing a chain) a smooth arc through the clicked points. */
  private curveThrough(points: Vec2[]): Curve | null {
    const [a, p1, p2, p3] = points;
    if (this.chainTangent) return tangentArc(a, this.chainTangent, p1);
    if (points.length === 2) return straightCurve(a, p1);
    if (points.length === 3) return quadraticCurve(a, p1, p2);
    return { a, c1: p1, c2: p2, b: p3 };
  }

  private drawPreview(cursor: Vec2, guides: Guide[]): void {
    const { overlay } = this.ctx;
    overlay.clear();
    const points = [...this.points, cursor];

    const pixel = this.ctx.worldPerPixel();
    for (const g of guides) {
      const k = (cursor.x - g.origin.x) * g.dir.x + (cursor.y - g.origin.y) * g.dir.y;
      const past = (k >= 0 ? GUIDE_OVERSHOOT : -GUIDE_OVERSHOOT) * pixel;
      const to = { x: g.origin.x + g.dir.x * (k + past), y: g.origin.y + g.dir.y * (k + past) };
      overlay.guide(g.origin, to, palette.guide, pixel);
    }

    if (points.length >= 2 && distance(points[0], cursor) > 0) {
      const roads = this.plan(points);
      for (const road of roads) {
        if (road.curve) overlay.roadPreview(road.curve, road.spec, road.valid);
        // Mark where junctions will form.
        for (const c of road.crossings) overlay.dot(c.point, road.valid ? palette.junction : palette.danger);
      }
      const main = roads[0].curve;
      this.ctx.setHint(
        main
          ? `${Math.round(new SampledCurve(main).length)} long · ${angleBetween(this.reference(), {
              x: points[1].x - points[0].x,
              y: points[1].y - points[0].y,
            })}°`
          : "Click ahead of the road to continue",
      );
    } else {
      this.ctx.setHint(null);
    }

    // Control polygon: guide lines from each road end to its neighbouring bend point.
    if (points.length >= 3) {
      overlay.line(points[0], points[1], palette.preview);
      overlay.line(points[points.length - 2], points[points.length - 1], palette.preview);
    }
    for (const p of points) overlay.dot(p, palette.preview);
  }
}
