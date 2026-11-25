import type { Vec2 } from "../core/geometry";
import type { RoadSegment } from "../core/roadGraph";
import { roadWidth } from "../core/roadSpec";
import { palette } from "../render/palette";
import type { Tool, ToolContext } from "./Tool";

/** A drag shorter than this (in screen pixels) counts as a click. */
const CLICK_SLOP_PX = 4;
const HIGHLIGHT_ALPHA = 0.55;
const AREA_ALPHA = 0.12;

/**
 * Removes roads.
 * - single: hover to highlight a road, click to remove it
 * - area: press, drag a rectangle, release to remove every road it touches (a click still
 *   removes the road under the cursor). Esc or right-click abandons the drag.
 */
export class BulldozeTool implements Tool {
  private dragStart: Vec2 | null = null;

  constructor(private ctx: ToolContext) {}

  onDown(p: Vec2): void {
    if (this.ctx.bulldozeMode() === "area") {
      this.dragStart = p;
      this.drawArea(p);
      return;
    }
    this.removeAt(p);
    this.hover(p);
  }

  onMove(p: Vec2): void {
    if (this.dragStart) this.drawArea(p);
    else this.hover(p);
  }

  onUp(p: Vec2): void {
    if (!this.dragStart) return;
    const start = this.dragStart;
    this.dragStart = null;
    this.ctx.setHint(null);
    const moved = Math.hypot(p.x - start.x, p.y - start.y) / this.ctx.worldPerPixel();
    if (moved < CLICK_SLOP_PX) this.removeAt(p);
    else for (const segment of this.selected(start, p)) this.ctx.graph.removeSegment(segment.id);
    this.hover(p);
  }

  back(): void {
    this.cancel();
  }

  cancel(): void {
    this.dragStart = null;
    this.ctx.overlay.clear();
    this.ctx.setHint(null);
  }

  private removeAt(p: Vec2): void {
    const segment = this.ctx.graph.segmentAt(p);
    if (segment) this.ctx.graph.removeSegment(segment.id);
  }

  private selected(a: Vec2, b: Vec2): RoadSegment[] {
    return this.ctx.graph.segmentsInPolygon(this.ctx.screenRect(a, b));
  }

  private hover(p: Vec2): void {
    this.ctx.overlay.clear();
    const segment = this.ctx.graph.segmentAt(p);
    if (segment) this.highlight(segment);
  }

  private drawArea(p: Vec2): void {
    const { overlay } = this.ctx;
    overlay.clear();
    const start = this.dragStart!;
    overlay.area(this.ctx.screenRect(start, p), palette.danger, AREA_ALPHA);
    const selected = this.selected(start, p);
    for (const segment of selected) this.highlight(segment);
    this.ctx.setHint(`${selected.length} road${selected.length === 1 ? "" : "s"}`);
  }

  private highlight(segment: RoadSegment): void {
    const { graph, overlay } = this.ctx;
    overlay.highlight(graph.curveOf(segment), roadWidth(segment.spec) + 4, palette.danger, HIGHLIGHT_ALPHA);
  }
}
