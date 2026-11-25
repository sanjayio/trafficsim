import { Mesh } from "three";
import type { RoadGraph } from "../core/roadGraph";
import type { ZoneMap } from "../core/zoning";
import { convexGeometry, flatMaterial, FlatLayer } from "./flat";
import { palette } from "./palette";

/** Tiles draw a little smaller than they are, so the grid between them shows. */
const TILE_GAP = 0.8;
const TILE_ALPHA = 0.16;

/** Draws the free zoning tiles beside roads (while the Traffic tool is in use), rebuilt when the network changes. */
export class ZoneLayer extends Mesh {
  private stale = true;
  private unsubscribe: () => void;

  constructor(
    graph: RoadGraph,
    private zones: ZoneMap,
  ) {
    super(undefined, flatMaterial(palette.preview, TILE_ALPHA));
    this.renderOrder = FlatLayer.markings + 1;
    this.visible = false;
    this.unsubscribe = graph.subscribe(() => (this.stale = true));
  }

  /** Shows or hides the tiles, rebuilding them first if the network changed while they were away. */
  show(visible: boolean): void {
    this.visible = visible;
    if (!visible || !this.stale) return;
    this.stale = false;
    this.geometry.dispose();
    const quads = this.zones
      .all()
      .filter((t) => t.free)
      .map((t) => t.corners.map((c) => ({ x: c.x + (t.centre.x - c.x) * (TILE_GAP / 9), y: c.y + (t.centre.y - c.y) * (TILE_GAP / 9) })));
    this.geometry = convexGeometry(quads);
  }

  dispose(): void {
    this.unsubscribe();
    this.geometry.dispose();
    (this.material as { dispose(): void }).dispose();
  }
}
