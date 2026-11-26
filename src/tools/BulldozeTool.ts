import { pointInConvexPolygon, type Vec2 } from "../core/geometry";
import type { NodeId, RoadSegment } from "../core/roadGraph";
import { roadWidth } from "../core/roadSpec";
import { palette } from "../render/palette";
import type { Tool, ToolContext } from "./Tool";

/** A drag shorter than this (in screen pixels) counts as a click. */
const CLICK_SLOP_PX = 4;
const HIGHLIGHT_ALPHA = 0.55;
const AREA_ALPHA = 0.12;
/** How much bigger than a building its bulldoze highlight is drawn. */
const BUILDING_APRON = 1.5;

/**
 * Removes roads (bulldozing with the Road tool) or source and sink buildings (with the Traffic
 * tool), and only those.
 * - single: hover to highlight one, click to remove it
 * - area: press, drag a rectangle, release to remove every road it touches (or every building in
 *   it; a click still removes what's under the cursor). Esc or right-click abandons the drag.
 */
export class BulldozeTool implements Tool {
  private dragStart: Vec2 | null = null;

  constructor(
    private ctx: ToolContext,
    private target: "roads" | "buildings",
  ) {}

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
    else {
      const { roads, buildings } = this.selected(start, p);
      for (const id of buildings) this.ctx.graph.setTerminal(id, null);
      for (const segment of roads) this.ctx.graph.removeSegment(segment.id);
    }
    this.hover(p);
  }

  back(): void {
    this.cancel();
  }

  busy(): boolean {
    return this.dragStart !== null;
  }

  cancel(): void {
    this.dragStart = null;
    this.ctx.overlay.clear();
    this.ctx.setHint(null);
  }

  private removeAt(p: Vec2): void {
    const { graph } = this.ctx;
    if (this.target === "buildings") {
      const building = graph.terminalAt(p);
      if (building !== undefined) graph.setTerminal(building, null);
      return;
    }
    const segment = graph.segmentAt(p);
    if (segment) graph.removeSegment(segment.id);
  }

  /** Roads touching the dragged area, and source and sink buildings standing in it. */
  private selected(a: Vec2, b: Vec2): { roads: RoadSegment[]; buildings: NodeId[] } {
    const { graph } = this.ctx;
    const area = this.ctx.screenRect(a, b);
    if (this.target === "roads") return { roads: graph.segmentsInPolygon(area), buildings: [] };
    const buildings = [...graph.allTerminals().keys()].filter((id) => {
      const lot = graph.terminalLot(id);
      return lot && pointInConvexPolygon(lot.centre, area);
    });
    return { roads: [], buildings };
  }

  private hover(p: Vec2): void {
    this.ctx.overlay.clear();
    if (this.target === "buildings") {
      const building = this.ctx.graph.terminalAt(p);
      if (building !== undefined) this.highlightBuilding(building);
      return;
    }
    const segment = this.ctx.graph.segmentAt(p);
    if (segment) this.highlight(segment);
  }

  /** A red apron round the building (the building itself would hide one drawn under it). */
  private highlightBuilding(id: NodeId): void {
    const corners = this.ctx.graph.lotCorners(id);
    const cx = corners.reduce((sum, c) => sum + c.x, 0) / corners.length;
    const cy = corners.reduce((sum, c) => sum + c.y, 0) / corners.length;
    const grown = corners.map((c) => ({ x: cx + (c.x - cx) * BUILDING_APRON, y: cy + (c.y - cy) * BUILDING_APRON }));
    this.ctx.overlay.area(grown, palette.danger, HIGHLIGHT_ALPHA);
  }

  private drawArea(p: Vec2): void {
    const { overlay } = this.ctx;
    overlay.clear();
    const start = this.dragStart!;
    overlay.area(this.ctx.screenRect(start, p), palette.danger, AREA_ALPHA);
    const { roads, buildings } = this.selected(start, p);
    for (const segment of roads) this.highlight(segment);
    for (const id of buildings) this.highlightBuilding(id);
    const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
    this.ctx.setHint(this.target === "roads" ? count(roads.length, "road") : count(buildings.length, "building"));
  }

  private highlight(segment: RoadSegment): void {
    const { graph, overlay } = this.ctx;
    overlay.highlight(graph.curveOf(segment), roadWidth(segment.spec) + 4, palette.danger, HIGHLIGHT_ALPHA);
  }
}
