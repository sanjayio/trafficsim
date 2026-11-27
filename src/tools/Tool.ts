import type { Curve } from "../core/curve";
import type { Vec2 } from "../core/geometry";
import type { NodeId, RoadGraph, RoadSegment } from "../core/roadGraph";
import type { RoadSpec } from "../core/roadSpec";
import type { Building } from "../core/terminal";
import type { ZoneMap } from "../core/zoning";

/** Transient previews and highlights drawn above the road network. Implemented by the renderer. */
export interface Overlay {
  /** Clears the overlay, and drops it back to the ground (see `raise`). */
  clear(): void;
  /** Draws what follows `height` up (or down): a bridge's or tunnel's preview at its height. */
  raise(height: number): void;
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

/** Traffic tool: the building to place (homes are sources, where cars come from; shops and offices sinks, where they go). */
export type TrafficMode = Building;

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
  trafficMode: () => TrafficMode;
  /** The zoning tiles beside roads, where the Traffic tool places buildings. */
  zones: ZoneMap;
  /**
   * The ground area under the screen rectangle spanned by two ground points (as a convex quad).
   * Screen-aligned, so it matches what the player sees even when the camera is rotated or tilted.
   */
  screenRect: (a: Vec2, b: Vec2) => Vec2[];
  /** Where cars stop on `segment` before junction `node` (the painted line), as a distance from the node. */
  stopLineAt: (segment: RoadSegment, node: NodeId) => number;
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
