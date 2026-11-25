import type { Tool, ToolContext } from "./Tool";

/** No editing; left-drag pans the camera (handled by Camera). */
export class SelectTool implements Tool {
  constructor(private ctx: ToolContext) {}
  onDown(): void {}
  onMove(): void {}
  onUp(): void {}
  cancel(): void {
    this.ctx.overlay.clear();
  }
}
