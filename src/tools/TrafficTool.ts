import type { Vec2 } from "../core/geometry";
import { BUILDING_LABEL, newTerminal } from "../core/terminal";
import { palette } from "../render/palette";
import type { Tool, ToolContext } from "./Tool";

const BLOCK_ALPHA = 0.45;

/**
 * Places the chosen building on the zoning tiles beside a road: a home (a source: cars come out
 * of it) or a shop or office (a sink: cars drive to it). The tiles it would take show green where
 * it fits, red where it doesn't. Clicking a building of the chosen type removes it; of another
 * type, swaps it.
 */
export class TrafficTool implements Tool {
  constructor(private ctx: ToolContext) {}

  onDown(p: Vec2): void {
    const { graph, zones } = this.ctx;
    const chosen = this.ctx.trafficMode();
    const building = graph.terminalAt(p);
    if (building !== undefined) {
      const existing = graph.terminal(building)!;
      let swapped = newTerminal(chosen, existing.side, existing.offset);
      // A home swapped for another keeps where its cars go and whether it's sending them.
      if (swapped.kind === "source" && existing.kind === "source") {
        swapped = { ...swapped, enabled: existing.enabled, sinks: existing.sinks };
      }
      if (existing.building === chosen) graph.setTerminal(building, null);
      else {
        graph.setTerminal(building, swapped);
        // A bigger building may not fit where the old one stood.
        if (!zones.standsClear(building)) graph.setTerminal(building, existing);
      }
    } else {
      const block = zones.blockAt(p, chosen);
      if (block) zones.place(block, chosen);
    }
    this.onMove(p);
  }

  onMove(p: Vec2): void {
    const { graph, overlay, zones } = this.ctx;
    overlay.clear();
    const chosen = this.ctx.trafficMode();
    const name = BUILDING_LABEL[chosen].toLowerCase();
    const building = graph.terminalAt(p);
    if (building !== undefined) {
      const existing = graph.terminal(building)!;
      return this.ctx.setHint(existing.building === chosen ? `Remove ${name}` : `Make a ${name}`);
    }
    const block = zones.blockAt(p, chosen);
    if (!block) return this.ctx.setHint(null);
    for (const tile of block.tiles) overlay.area(tile.corners, block.fits ? palette.source : palette.danger, BLOCK_ALPHA);
    this.ctx.setHint(block.fits ? `Add ${name}` : "Doesn't fit here");
  }

  onUp(): void {}

  cancel(): void {
    this.ctx.overlay.clear();
    this.ctx.setHint(null);
  }
}
