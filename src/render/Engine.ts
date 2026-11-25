import { Fog, LinearToneMapping, Scene, Vector3, WebGLRenderer } from "three";
import { atmosphere, type Atmosphere } from "./atmosphere";
import { Rain } from "./Rain";
import { WORLD_SIZE } from "../core/constants";
import type { Vec2 } from "../core/geometry";
import { hasLaneConnector } from "../core/lanes";
import { RoadGraph, type DrivingSide, type NodeId, type RoadSegment, type SavedMap } from "../core/roadGraph";
import { SIM_DT, Simulation } from "../core/simulation";
import { LaneTool } from "../tools/LaneTool";
import { TrafficTool } from "../tools/TrafficTool";
import { ZoneMap } from "../core/zoning";
import { levelUp } from "../core/growth";
import { slipRoad } from "../core/junction";
import { CarLayer } from "./CarLayer";
import { ZoneLayer } from "./ZoneLayer";
import { loadAutosave, loadView, openMapFile, saveAutosave, saveMapFile, saveView } from "../platform";
import { gameStore, isSnapping, WEATHERS, type NodeAnchor, type ToolId, type Weather } from "../state/store";
import { BulldozeTool } from "../tools/BulldozeTool";
import { RoadTool } from "../tools/RoadTool";
import { SelectTool } from "../tools/SelectTool";
import type { Tool, ToolContext } from "../tools/Tool";
import { Camera } from "./Camera";
import { Grid } from "./Grid";
import { FlatLayer } from "./flat";
import { Ground } from "./Ground";
import { Sky } from "./Sky";
import { swayUniforms } from "./buildings";
import { StreetLights } from "./StreetLights";
import { installCloudShadows, SunShadows } from "./shadows";
import { OverlayLayer } from "./OverlayLayer";
import { palette } from "./palette";
import { RoadLayer } from "./RoadLayer";

/** Below this zoom the minor grid is hidden to avoid moiré. */
const MINOR_GRID_MIN_ZOOM = 0.45;
const STATS_INTERVAL_MS = 250;
const VIEW_CHECK_MS = 1000;
/** How often customers counted since the last save are kept (they change nothing else, so nothing else saves them). */
const VISITS_SAVE_MS = 10_000;
/** Magnetic snaps (road ends, guidelines) reach this far from the cursor, in screen pixels. */
const SNAP_PIXELS = 10;
/** Offset of the cursor readout from the pointer, in pixels. */
export const HINT_OFFSET = 18;
/** A right-button press that moves less than this (in pixels) is a click (step back), not a pan. */
const CLICK_SLOP_PX = 5;
/** Cap on real time fed to the simulation per frame, so a stall doesn't trigger a catch-up spiral. */
const MAX_FRAME_MS = 250;
/** How close (world units) the cursor must be to a source's road end to offer its options. */
/** The map is kept in the browser this long after the last change. */
const AUTOSAVE_DELAY_MS = 500;
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
  private ground = new Ground(FlatLayer.ground);
  private sky = new Sky(FlatLayer.sky);
  /** Drawn after buildings and cars (which are at 20). */
  private rain = new Rain(30);
  /** The look for the current time of day and weather, worked out again when either changes. */
  private look: { key: string; value: Atmosphere } | null = null;
  private tmpFocus = new Vector3();
  private shadows!: SunShadows;
  private streetLights = new StreetLights(this.graph);
  /** Roads changed since the streetlights were placed: rebuilt once, next frame. */
  private streetLightsDirty = true;
  /** The view last kept (see keepView), and time since it was last checked. */
  private keptView = "";
  private viewCheck = 0;
  private visitsCheck = 0;
  private roads = new RoadLayer(this.graph);
  private cars = new CarLayer();
  private zones = new ZoneMap(this.graph);
  private zoneLayer = new ZoneLayer(this.graph, this.zones);
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
    // Scales the scene's brightness for the time of day and weather; lights opt out (toneMapped: false).
    renderer.toneMapping = LinearToneMapping;
    this.renderer = renderer;
    installCloudShadows();
    // Over the ground, roads and their markings; under the zoning tiles, buildings and cars.
    this.shadows = new SunShadows(renderer, FlatLayer.markings + 0.5);

    const canvas = renderer.domElement;
    canvas.style.display = "block";
    canvas.style.touchAction = "none";
    host.appendChild(canvas);

    this.scene.fog = this.fog;
    this.cleanups.push(this.graph.subscribe(() => (this.streetLightsDirty = true)));
    this.scene.add(this.streetLights, ...this.shadows.objects, this.sky, this.rain, this.ground, this.grid, this.roads, this.zoneLayer, this.cars, this.overlay);

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
      zones: this.zones,
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

    // The logo shows the map's name: keep it up to date as maps load (and here, for the first one).
    gameStore.getState().setMapName(this.graph.name);
    this.cleanups.push(this.graph.subscribe((e) => e.type === "reset" && gameStore.getState().setMapName(this.graph.name)));
    this.restoreAutosave();
    renderer.setAnimationLoop(this.frame);
  }

  /** Starts an empty map called `name`, driving on `side` (the last one is gone unless it was saved to a file). */
  newMap(name: string, side: DrivingSide): void {
    this.tool.cancel();
    this.graph.load({ version: 3, name, drivingSide: side, nodes: [], segments: [] });
    gameStore.getState().setDrivingSide(this.graph.drivingSide);
  }

  /**
   * Brings back the map kept in the browser from last time, then keeps every change there (a
   * moment after the last one), so the city is still there next visit without saving a file.
   */
  private restoreAutosave(): void {
    this.restoreView();
    const saved = loadAutosave();
    if (saved) {
      try {
        this.graph.load(JSON.parse(saved) as SavedMap);
        gameStore.getState().setDrivingSide(this.graph.drivingSide);
      } catch {
        gameStore.getState().showMessage("Couldn't restore your last map");
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let warned = false;
    const unsubscribe = this.graph.subscribe(() => {
      clearTimeout(timer);
      gameStore.getState().setAutosave("saving");
      timer = setTimeout(() => {
        const saved = saveAutosave(JSON.stringify(this.graph.toJSON()));
        gameStore.getState().setAutosave(saved ? "saved" : "failed");
        if (saved || warned) return;
        warned = true;
        gameStore.getState().showMessage("Couldn't keep the map in this browser: use Save map");
      }, AUTOSAVE_DELAY_MS);
    });
    this.cleanups.push(() => {
      clearTimeout(timer);
      unsubscribe();
    });
  }

  async saveMap(): Promise<boolean> {
    return saveMapFile(JSON.stringify(this.graph.toJSON(), null, 2), this.graph.name);
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
    this.zoneLayer.dispose();
    this.zones.dispose();
    this.sim.dispose();
    this.overlay.dispose();
    this.grid.dispose();
    this.ground.dispose();
    this.sky.dispose();
    this.rain.dispose();
    this.shadows.dispose();
    this.streetLights.dispose();
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

  /**
   * Buildings that have served enough go up a level (wider if there's room, else taller); and
   * customers counted since the last save are kept every so often (counting them fires no event).
   */
  private grow(deltaMS: number): void {
    for (const id of this.sim.levelUps.splice(0)) levelUp(this.graph, this.zones, id);
    this.visitsCheck += deltaMS;
    if (this.visitsCheck < VISITS_SAVE_MS) return;
    this.visitsCheck = 0;
    if (this.graph.visits === 0) return;
    this.graph.visits = 0;
    saveAutosave(JSON.stringify(this.graph.toJSON()));
  }

  /** The view (camera, time of day, weather) as last kept, then kept again whenever it changes. */
  private restoreView(): void {
    try {
      const view = JSON.parse(loadView() ?? "{}") as Record<string, unknown>;
      const state = gameStore.getState();
      if (typeof view.timeOfDay === "number" && view.timeOfDay >= 0 && view.timeOfDay <= 24) state.setTimeOfDay(view.timeOfDay);
      if (WEATHERS.includes(view.weather as Weather)) state.setWeather(view.weather as Weather);
      if (view.camera && typeof view.camera === "object") this.camera.setView(view.camera as Record<string, unknown>);
    } catch {
      // A broken view just starts from the default.
    }
    this.keptView = this.currentView();
  }

  private currentView(): string {
    const { timeOfDay, weather } = gameStore.getState();
    return JSON.stringify({ timeOfDay, weather, camera: this.camera.view });
  }

  /** Keeps the view a moment after it last changed (checked once a second, not every frame). */
  private keepView(deltaMS: number): void {
    this.viewCheck += deltaMS;
    if (this.viewCheck < VIEW_CHECK_MS) return;
    this.viewCheck = 0;
    const view = this.currentView();
    if (view === this.keptView) return;
    this.keptView = view;
    saveView(view);
  }

  /** The look for the chosen time of day and weather, applied to the scene when it changes. */
  private atmosphere(): Atmosphere {
    const { timeOfDay, weather } = gameStore.getState();
    const key = `${timeOfDay}:${weather}`;
    if (this.look?.key === key) return this.look.value;
    const value = atmosphere(timeOfDay, weather);
    this.look = { key, value };
    this.fog.color.copy(value.horizon);
    this.renderer.setClearColor(value.horizon);
    this.renderer.toneMappingExposure = value.exposure;
    return value;
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
    const look = this.atmosphere();
    this.fog.near = distance * FOG_NEAR * look.visibility;
    this.fog.far = distance * FOG_FAR * look.visibility;
    // Well inside the camera's far plane (20 orbit distances).
    this.sky.follow(this.camera.camera.position, distance * 10);
    this.sky.update(look, deltaMS / 1000);
    // Trees sway a little always, hard in the wind.
    swayUniforms.swayTime.value += deltaMS / 1000;
    swayUniforms.swayStrength.value = 0.025 + look.wind * 0.16;
    const focus = this.camera.target;
    this.shadows.update(look.sun, focus.x, focus.y, distance, look.shadow);
    SunShadows.clouds(look.tint, look.cloudShade, look.clouds.cover, this.sky.drift);
    this.rain.update(look.precipitation === "rain", this.tmpFocus.set(focus.x, 0, focus.y), distance, look.wind, Math.min(1, look.exposure + 0.2), deltaMS / 1000);
    // The grid is a guide for drawing roads: shown only with the Road tool.
    this.grid.visible = gameStore.getState().tool === "road";
    this.grid.minor.visible = this.camera.zoom >= MINOR_GRID_MIN_ZOOM;

    this.roads.updateSignals(this.sim.time);
    this.cars.update(this.sim, look.night);
    this.roads.setLights(look.exposure, look.night);
    if (this.streetLightsDirty) {
      this.streetLights.rebuild();
      this.streetLightsDirty = false;
    }
    this.streetLights.setLights(look.exposure, look.night);
    this.zoneLayer.show(gameStore.getState().tool === "traffic" && gameStore.getState().laneEditNode === null);
    this.trackJunctionPositions();
    this.keepView(deltaMS);
    this.grow(deltaMS);
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

  /** The junction under screen point `s`, or failing that the source whose building (or plot) is. */
  private anchorAt(s: Vec2): NodeAnchor | null {
    const world = this.camera.screenToWorld(s);
    const junction = world && this.graph.junctionAt(world);
    // Where a slip road leaves there's nothing to set; where one joins, how it gives way.
    const split = junction && slipRoad(this.graph, junction.id)?.merge === false;
    if (junction && !split) return { id: junction.id, kind: "junction", ...this.camera.worldToScreen(junction) };
    const buildings = this.roads.buildingGroups();
    let hit = this.camera.pick(s, [...buildings.keys()]);
    while (hit && !buildings.has(hit)) hit = hit.parent;
    const id = hit ? buildings.get(hit)! : undefined;
    if (id === undefined || !this.graph.terminal(id)) return null;
    return { id, kind: "building", ...this.camera.worldToScreen(this.anchorPoint(id, "building")!) };
  }

  /** Where a junction's or source's options button sits: on the junction, or on the source's building. */
  private anchorPoint(id: NodeId, kind: NodeAnchor["kind"]): Vec2 | null {
    return kind === "junction" ? (this.graph.nodes.get(id) ?? null) : (this.graph.terminalLot(id)?.centre ?? null);
  }

  private updateJunctionHover(s: Vec2 | null): void {
    const { junctionHover, setJunctionHover } = gameStore.getState();
    const anchor = s && this.junctionHoverAllowed() && !this.camera.isPanning ? this.anchorAt(s) : null;
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
      const point = this.anchorPoint(j.id, j.kind);
      const valid =
        j.kind === "junction" ? this.graph.segmentsAt(j.id).length >= 3 : this.graph.terminal(j.id) !== undefined;
      if (!point || !valid) return null;
      const at = this.camera.worldToScreen(point);
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
        gameStore.getState().setJunctionOpen(gameStore.getState().tool === "select" ? this.anchorAt(up) : null);
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
