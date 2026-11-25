import type { Curve } from "../core/curve";
import type { Vec2 } from "../core/geometry";
import type { RoadGraph } from "../core/roadGraph";
import type { RoadSpec } from "../core/roadSpec";

/** Transient previews and highlights drawn above the road network. Implemented by the renderer. */
export interface Overlay {
  clear(): void;
  /** A translucent version of the road that would be built along `curve`; red when it can't be built. */
  roadPreview(curve: Curve, spec: RoadSpec, valid: boolean): void;
  /** A plain round-capped band along `curve`, e.g. to highlight an existing road. */
  highlight(curve: Curve, width: number, color: number, alpha: number): void;
  /** A thin guide line, e.g. from a road end to its curve control point. */
  line(a: Vec2, b: Vec2, color: number): void;
  /**
   * A snapping guideline from `origin` to `to`: dotted, with an ✕ marking its origin.
   * `pixel` is the size of one screen pixel in world units, so it looks the same at any zoom.
   */
  guide(origin: Vec2, to: Vec2, color: number, pixel: number): void;
  dot(p: Vec2, color: number): void;
  /** A filled convex polygon with an outline, e.g. a selection area. */
  area(points: Vec2[], color: number, alpha: number): void;
}

/**
 * Clicks per road: straight (start, end), curve (start, bend, end), complex (start, 2 bends, end).
 * Continuous: start, end, then every further click adds a curve continuing smoothly from the last.
 */
export type RoadMode = "straight" | "curve" | "complex" | "continuous";

/** Bulldoze one road per click, or every road in a dragged rectangle. */
export type BulldozeMode = "single" | "area";

export interface ToolContext {
  graph: RoadGraph;
  /** Tools own the overlay's contents while active. */
  overlay: Overlay;
  /** Whether road endpoints snap to the grid. Read on every use, so toggling applies immediately. */
  snapToGrid: () => boolean;
  /** Settings for new roads. Read on every use, so changes apply immediately. */
  roadSpec: () => RoadSpec;
  roadMode: () => RoadMode;
  /** Signed centre-to-centre offset of the parallel road (positive: right of travel), or null when off. */
  parallelOffset: () => number | null;
  /** Snap onto roads, guidelines and angles (already off while Alt/Option is held). */
  guideSnapping: () => boolean;
  /** How close the cursor must be for magnetic snaps, in world units at the current zoom. */
  snapTolerance: () => number;
  /** Size of one screen pixel in world units at the current zoom. */
  worldPerPixel: () => number;
  bulldozeMode: () => BulldozeMode;
  /**
   * The ground area under the screen rectangle spanned by two ground points (as a convex quad).
   * Screen-aligned, so it matches what the player sees even when the camera is rotated or tilted.
   */
  screenRect: (a: Vec2, b: Vec2) => Vec2[];
  /** Short readout shown next to the cursor (null hides it). */
  setHint: (text: string | null) => void;
}

/** A build tool. Receives left-button pointer input in world coordinates. */
export interface Tool {
  onDown(p: Vec2): void;
  onMove(p: Vec2): void;
  onUp(p: Vec2): void;
  /** Abort any in-progress action and clear the overlay. */
  cancel(): void;
  /** Undo the last step of an in-progress action (right-click). Defaults to `cancel`. */
  back?(): void;
  /** True while an action is in progress (e.g. a road half drawn), so hover affordances stay out of the way. */
  busy?(): boolean;
}
