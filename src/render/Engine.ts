import { Fog, Scene, WebGLRenderer } from "three";
import { WORLD_SIZE } from "../core/constants";
import type { Vec2 } from "../core/geometry";
import { hasLaneConnector } from "../core/lanes";
import { RoadGraph, type RoadSegment, type SavedMap } from "../core/roadGraph";
import { SIM_DT, Simulation } from "../core/simulation";
import { LaneTool } from "../tools/LaneTool";
import { TrafficTool } from "../tools/TrafficTool";
import { CarLayer } from "./CarLayer";
import { openMapFile, saveMapFile } from "../platform";
import { gameStore, isSnapping, type NodeAnchor, type ToolId } from "../state/store";
import { BulldozeTool } from "../tools/BulldozeTool";
import { RoadTool } from "../tools/RoadTool";
import { SelectTool } from "../tools/SelectTool";
import type { Tool, ToolContext } from "../tools/Tool";
import { Camera } from "./Camera";
import { Grid } from "./Grid";
import { OverlayLayer } from "./OverlayLayer";
import { palette } from "./palette";
import { RoadLayer } from "./RoadLayer";

/** Below this zoom the minor grid is hidden to avoid moiré. */
const MINOR_GRID_MIN_ZOOM = 0.45;
const STATS_INTERVAL_MS = 250;
/** Magnetic snaps (road ends, guidelines) reach this far from the cursor, in screen pixels. */
const SNAP_PIXELS = 10;
/** Offset of the cursor readout from the pointer, in pixels. */
export const HINT_OFFSET = 18;
/** A right-button press that moves less than this (in pixels) is a click (step back), not a pan. */
const CLICK_SLOP_PX = 5;
/** Cap on real time fed to the simulation per frame, so a stall doesn't trigger a catch-up spiral. */
const MAX_FRAME_MS = 250;
/** How close (world units) the cursor must be to a source's road end to offer its options. */
const SOURCE_HOVER_RADIUS = 16;
/** Fog range as multiples of the camera's focus distance: only the far edge of a tilted view fades. */
const FOG_NEAR = 1.6;
const FOG_FAR = 5;

/**
 * Owns the three.js renderer and scene, input routing and the fixed-step simulation loop.
 * React mounts it once and talks to it only through `gameStore`.
 */
export class Engine {
  readonly graph = new RoadGraph();
  // Cars stop on the painted lines, which the road layer knows (it's created below, before any car spawns).
  readonly sim = new Simulation(this.graph, (segment, node) => this.roads.stopLineAt(segment, node), Date.now());

  private renderer!: WebGLRenderer;
  private scene = new Scene();
  private fog = new Fog(palette.ground, 1, 2);
  private grid = new Grid();
  private roads = new RoadLayer(this.graph);
  private cars = new CarLayer();
  private overlay = new OverlayLayer();
  private camera!: Camera;
  private tools!: Record<ToolId, Tool>;
  private ctx!: ToolContext;
  private tool!: Tool;
  /** Last pointer position in canvas pixels, so tools can track the cursor while the camera moves under it. */
  private pointer: Vec2 | null = null;
  /** Where the right button went down, to tell a right-click (cancel) from a right-drag (pan). */
  private rightDownAt: Vec2 | null = null;
  /** Where the left button went down, to tell a click from a drag. */
  private leftDownAt: Vec2 | null = null;

  private lastFrameTime: number | null = null;
  private accumulator = 0;
  private statsElapsed = 0;
  private statsFrames = 0;
  private cleanups: (() => void)[] = [];

  mount(host: HTMLElement): void {
    const renderer = new WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setClearColor(palette.ground);
    this.renderer = renderer;

    const canvas = renderer.domElement;
    canvas.style.display = "block";
    canvas.style.touchAction = "none";
    host.appendChild(canvas);

    this.scene.fog = this.fog;
    this.scene.add(this.grid, this.roads, this.cars, this.overlay);

    // Left-drag pans with the Select tool, except in the lane connector, which needs left clicks.
    this.camera = new Camera(canvas, () => gameStore.getState().tool === "select" && gameStore.getState().laneEditNode === null);
    const resize = () => {
      renderer.setSize(host.clientWidth, host.clientHeight);
      this.camera.setViewport(host.clientWidth, host.clientHeight);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    this.cleanups.push(() => observer.disconnect());
    this.camera.centerOn(WORLD_SIZE / 2, WORLD_SIZE / 2);

    const ctx = {
      graph: this.graph,
      overlay: this.overlay,
      snapToGrid: () => isSnapping(gameStore.getState()),
      roadSpec: () => gameStore.getState().roadSpec,
      roadMode: () => gameStore.getState().roadMode,
      parallelOffset: () => {
        const { parallel, parallelOffset } = gameStore.getState();
        return parallel ? parallelOffset : null;
      },
      guideSnapping: () => {
        const { guideSnapping, snapInverted } = gameStore.getState();
        // Alt/Option means "place freely": it also switches guides and angles off.
        return guideSnapping && !snapInverted;
      },
      snapTolerance: () => SNAP_PIXELS / this.camera.zoom,
      worldPerPixel: () => 1 / this.camera.zoom,
      bulldozeMode: () => gameStore.getState().bulldozeMode,
      trafficMode: () => gameStore.getState().trafficMode,
      stopLineAt: (segment: RoadSegment, node: number) => this.roads.stopLineAt(segment, node),
      screenRect: (a: Vec2, b: Vec2) => {
        const sa = this.camera.worldToScreen(a);
        const sb = this.camera.worldToScreen(b);
        const corners = [
          { x: sa.x, y: sa.y },
          { x: sb.x, y: sa.y },
          { x: sb.x, y: sb.y },
          { x: sa.x, y: sb.y },
        ];
        // Every screen point hits the ground within the camera's pitch limits; fall back to the drag points.
        return corners.map((c, i) => this.camera.screenToWorld(c) ?? (i < 2 ? a : b));
      },
      setHint: (text: string | null) => {
        const pointer = this.pointer;
        gameStore
          .getState()
          .setHint(text && pointer ? { text, x: pointer.x + HINT_OFFSET, y: pointer.y + HINT_OFFSET } : null);
      },
    };
    this.tools = {
      select: new SelectTool(ctx),
      road: new RoadTool(ctx),
      bulldoze: new BulldozeTool(ctx),
      traffic: new TrafficTool(ctx),
    };
    this.tool = this.tools[gameStore.getState().tool];
    this.ctx = ctx;
    this.cleanups.push(
      gameStore.subscribe((state, prev) => {
        if (state.drivingSide !== prev.drivingSide) this.graph.setDrivingSide(state.drivingSide);
        if (state.highlightNode !== prev.highlightNode) this.showHighlight(state.highlightNode);
        if (
          state.tool !== prev.tool ||
          state.roadMode !== prev.roadMode ||
          state.bulldozeMode !== prev.bulldozeMode ||
          state.trafficMode !== prev.trafficMode ||
          state.laneEditNode !== prev.laneEditNode
        ) {
          // A road in progress can't carry over to a mode with a different number of clicks.
          this.tool.cancel();
          this.tool = state.laneEditNode !== null ? new LaneTool(this.ctx, state.laneEditNode) : this.tools[state.tool];
          this.refreshPreview();
          this.updateJunctionHover(this.pointer);
        } else if (
          state.roadSpec !== prev.roadSpec ||
          state.snapToGrid !== prev.snapToGrid ||
          state.parallel !== prev.parallel ||
          state.parallelOffset !== prev.parallelOffset ||
          state.guideSnapping !== prev.guideSnapping
        ) {
          // Settings changed from the HUD; refresh the preview without waiting for a mouse move.
          this.refreshPreview();
        }
      }),
    );

    // Registered after the camera's listeners, so `isPanning` is already up to date here.
    this.listen(canvas, "pointerdown", this.onPointerDown);
    this.listen(canvas, "pointermove", this.onPointerMove);
    this.listen(canvas, "pointerup", this.onPointerUp);
    this.listen(canvas, "pointercancel", this.onPointerCancel);
    this.listen(canvas, "pointerleave", () => gameStore.getState().setHint(null));
    this.listen(canvas, "contextmenu", (e: Event) => e.preventDefault());
    this.listen(window, "keydown", (e: KeyboardEvent) => {
      // Esc leaves the lane connector; otherwise it cancels what the tool is doing.
      if (e.key === "Escape" && gameStore.getState().laneEditNode !== null) gameStore.getState().setLaneEditNode(null);
      else if (e.key === "Escape") this.tool.cancel();
      if (e.key === "Alt") {
        // Stops Windows/Linux from moving focus to the menu bar.
        e.preventDefault();
        this.setSnapInverted(true);
      }
    });
    this.listen(window, "keyup", (e: KeyboardEvent) => {
      if (e.key === "Alt") {
        e.preventDefault();
        this.setSnapInverted(false);
      }
    });
    // Alt released while the window was in the background never sends keyup.
    this.listen(window, "blur", () => this.setSnapInverted(false));

    renderer.setAnimationLoop(this.frame);
  }

  async saveMap(): Promise<boolean> {
    return saveMapFile(JSON.stringify(this.graph.toJSON(), null, 2));
  }

  async openMap(): Promise<boolean> {
    const contents = await openMapFile();
    if (contents === null) return false;
    this.tool.cancel();
    this.graph.load(JSON.parse(contents) as SavedMap);
    // The map brings its own driving side; reflect it in the settings.
    gameStore.getState().setDrivingSide(this.graph.drivingSide);
    return true;
  }

  destroy(): void {
    if (!this.renderer) return;
    this.renderer.setAnimationLoop(null);
    for (const cleanup of this.cleanups) cleanup();
    this.camera.destroy();
    this.roads.dispose();
    this.cars.dispose();
    this.sim.dispose();
    this.overlay.dispose();
    this.grid.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement | Window,
    type: K,
    handler: (e: HTMLElementEventMap[K]) => void,
  ): void {
    target.addEventListener(type, handler as EventListener);
    this.cleanups.push(() => target.removeEventListener(type, handler as EventListener));
  }

  private frame = (time: number) => {
    const deltaMS = this.lastFrameTime === null ? 0 : Math.min(time - this.lastFrameTime, MAX_FRAME_MS);
    this.lastFrameTime = time;
    const { speed, setStats } = gameStore.getState();

    this.accumulator += (deltaMS / 1000) * speed;
    while (this.accumulator >= SIM_DT) {
      this.sim.step(SIM_DT);
      this.accumulator -= SIM_DT;
    }

    // The cursor now sits over a different ground point; let the tool's preview follow it.
    if (this.camera.update(deltaMS) && this.pointer && !this.camera.isPanning) {
      this.toolMove(this.pointer);
    }

    const distance = this.camera.distance;
    this.fog.near = distance * FOG_NEAR;
    this.fog.far = distance * FOG_FAR;
    this.grid.minor.visible = this.camera.zoom >= MINOR_GRID_MIN_ZOOM;

    this.roads.updateSignals(this.sim.time);
    this.cars.update(this.sim);
    this.trackJunctionPositions();
    this.renderer.render(this.scene, this.camera.camera);

    this.statsFrames++;
    this.statsElapsed += deltaMS;
    if (this.statsElapsed >= STATS_INTERVAL_MS) {
      setStats({ fps: Math.round((this.statsFrames * 1000) / this.statsElapsed) });
      this.statsElapsed = 0;
      this.statsFrames = 0;
    }
  };

  private toCanvas(e: PointerEvent): Vec2 {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  /** Flips road snapping while Alt/Option is held, refreshing the preview without waiting for a mouse move. */
  private setSnapInverted(inverted: boolean): void {
    if (gameStore.getState().snapInverted === inverted) return;
    gameStore.getState().setSnapInverted(inverted);
    this.refreshPreview();
  }

  private refreshPreview(): void {
    if (this.pointer && !this.camera.isPanning) this.toolMove(this.pointer);
  }

  /** Junction and source options are offered with the Select and Traffic tools, and with the Road tool between roads. */
  private junctionHoverAllowed(): boolean {
    const { tool, laneEditNode } = gameStore.getState();
    if (laneEditNode !== null) return false;
    return tool === "select" || tool === "traffic" || (tool === "road" && !this.tool.busy?.());
  }

  /** The junction, or failing that the source, at a ground point. */
  private anchorAt(world: Vec2): NodeAnchor | null {
    const junction = this.graph.junctionAt(world);
    const source = junction ? undefined : this.graph.sourceAt(world, SOURCE_HOVER_RADIUS);
    const node = junction ?? source;
    return node ? { id: node.id, kind: junction ? "junction" : "source", ...this.camera.worldToScreen(node) } : null;
  }

  private updateJunctionHover(s: Vec2 | null): void {
    const { junctionHover, setJunctionHover } = gameStore.getState();
    const world = s && this.junctionHoverAllowed() && !this.camera.isPanning ? this.camera.screenToWorld(s) : null;
    const anchor = world ? this.anchorAt(world) : null;
    if ((anchor?.id ?? null) === (junctionHover?.id ?? null)) return;
    setJunctionHover(anchor);
  }

  /** Points out a sink (hovered in a source's panel) by outlining its road. */
  private showHighlight(nodeId: number | null): void {
    this.overlay.clear();
    const [segment] = nodeId === null ? [] : this.graph.segmentsAt(nodeId);
    if (segment) this.overlay.highlight(this.graph.curveOf(segment), 40, palette.sink, 0.5);
    else this.refreshPreview();
  }

  /**
   * Keeps the hovered and open junctions' screen positions current as the camera moves, and
   * drops them if the junction is gone (bulldozed, or no longer three or more roads).
   */
  private trackJunctionPositions(): void {
    const state = gameStore.getState();
    const follow = (j: NodeAnchor | null) => {
      if (!j) return j;
      const node = this.graph.nodes.get(j.id);
      const valid =
        j.kind === "junction" ? this.graph.segmentsAt(j.id).length >= 3 : this.graph.terminal(j.id)?.kind === "source";
      if (!node || !valid) return null;
      const at = this.camera.worldToScreen(node);
      return Math.abs(at.x - j.x) < 0.5 && Math.abs(at.y - j.y) < 0.5 ? j : { ...j, ...at };
    };
    // The lane connector ends if its junction stops having one (bulldozed, or made a roundabout).
    if (state.laneEditNode !== null && !(this.graph.nodes.has(state.laneEditNode) && hasLaneConnector(this.graph, state.laneEditNode))) {
      state.setLaneEditNode(null);
    }
    const hover = follow(state.junctionHover);
    const open = follow(state.junctionOpen);
    if (hover !== state.junctionHover) state.setJunctionHover(hover);
    if (open !== state.junctionOpen) state.setJunctionOpen(open);
  }

  /** Pointer events carry modifier state, which corrects any Alt press/release the key listeners missed. */
  private syncAlt(e: PointerEvent): void {
    if (e.altKey !== gameStore.getState().snapInverted) gameStore.getState().setSnapInverted(e.altKey);
  }

  private toolMove(s: Vec2): void {
    const p = this.camera.screenToWorld(s);
    if (p) this.tool.onMove(p);
  }

  private onPointerDown = (e: PointerEvent) => {
    // Keep receiving move/up events if a drag leaves the canvas.
    this.renderer.domElement.setPointerCapture(e.pointerId);
    this.syncAlt(e);
    if (e.button === 2) this.rightDownAt = this.toCanvas(e);
    if (e.button === 0) this.leftDownAt = this.toCanvas(e);
    if (e.button !== 0 || this.camera.isPanning) return;
    const p = this.camera.screenToWorld(this.toCanvas(e));
    if (p) this.tool.onDown(p);
  };

  private onPointerMove = (e: PointerEvent) => {
    this.syncAlt(e);
    this.pointer = this.toCanvas(e);
    this.updateJunctionHover(this.pointer);
    if (!this.camera.isPanning) this.toolMove(this.pointer);
  };

  private onPointerUp = (e: PointerEvent) => {
    if (e.button === 0 && this.leftDownAt) {
      const up = this.toCanvas(e);
      const isClick = Math.hypot(up.x - this.leftDownAt.x, up.y - this.leftDownAt.y) < CLICK_SLOP_PX;
      this.leftDownAt = null;
      // A click on the map closes the options panel; with the Select tool, a click on a junction or source opens it.
      if (isClick && gameStore.getState().laneEditNode === null) {
        const world = gameStore.getState().tool === "select" ? this.camera.screenToWorld(up) : null;
        gameStore.getState().setJunctionOpen(world ? this.anchorAt(world) : null);
      }
    }
    if (e.button === 2 && this.rightDownAt) {
      const up = this.toCanvas(e);
      if (Math.hypot(up.x - this.rightDownAt.x, up.y - this.rightDownAt.y) < CLICK_SLOP_PX) {
        if (this.tool.back) this.tool.back();
        else this.tool.cancel();
        this.refreshPreview();
      }
      this.rightDownAt = null;
    }
    if (e.button !== 0 || this.camera.isPanning) return;
    const p = this.camera.screenToWorld(this.toCanvas(e));
    if (p) this.tool.onUp(p);
  };

  private onPointerCancel = () => {
    this.tool.cancel();
  };
}
