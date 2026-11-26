import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { DrivingSide } from "../core/roadGraph";
import { DEFAULT_ROAD_SPEC, type RoadSpec } from "../core/roadSpec";
import type { TrafficStats } from "../core/simulation";
import type { BulldozeMode, RoadMode, TrafficMode } from "../tools/Tool";

/** Parallel road offset limits and step, centre to centre, in world units. */
export const PARALLEL_OFFSET_STEP = 8;
export const PARALLEL_OFFSET_MAX = 512;

export const TOOL_IDS = ["select", "road", "traffic"] as const;
export type ToolId = (typeof TOOL_IDS)[number];

/** A junction or source offering its ⚙ button or options panel, at its screen position in canvas pixels. */
export interface NodeAnchor {
  id: number;
  kind: "junction" | "building";
  x: number;
  y: number;
}
export type SimSpeed = 0 | 1 | 2 | 4;
export const WEATHERS = ["sunny", "cloudy", "rain", "windy"] as const;
export type Weather = (typeof WEATHERS)[number];

export interface Stats {
  fps: number;
  traffic: TrafficStats | null;
}

interface GameState {
  tool: ToolId;
  /** Bulldozing with the Road tool (roads) or the Traffic tool (buildings), instead of building. */
  bulldozing: boolean;
  /** Time of day shown, in hours (0–24): the sun, sky and light. */
  timeOfDay: number;
  weather: Weather;
  setTimeOfDay: (hours: number) => void;
  setWeather: (weather: Weather) => void;
  speed: SimSpeed;
  /** Speed to resume at when unpausing. */
  lastSpeed: Exclude<SimSpeed, 0>;
  /** Road tool: snap endpoints to the grid (otherwise free placement). */
  snapToGrid: boolean;
  /** True while Alt/Option is held, which temporarily flips `snapToGrid`. */
  snapInverted: boolean;
  /** Road tool: settings for newly built roads. */
  roadSpec: RoadSpec;
  roadMode: RoadMode;
  bulldozeMode: BulldozeMode;
  trafficMode: TrafficMode;
  /** Road tool: snap onto roads, guidelines and angles. */
  guideSnapping: boolean;
  /** Short readout next to the cursor (road length and angle while drawing), in canvas pixels. */
  hint: { text: string; x: number; y: number } | null;
  /** Road tool: also build a parallel copy. */
  parallel: boolean;
  /** Signed offset of the parallel copy (positive: right of the direction drawn). Never 0. */
  parallelOffset: number;
  stats: Stats;
  /** Keeping the map in the browser: just changed (saving), kept, or refused (storage blocked or full); null before any change. */
  autosave: "saving" | "saved" | "failed" | null;
  message: string | null;
  /**
   * The junction or source under the cursor (offering its ⚙ button) and the one whose options
   * panel is open, each kept at its current screen position by the engine.
   */
  junctionHover: NodeAnchor | null;
  junctionOpen: NodeAnchor | null;
  /** A sink to point out on the map (hovered in a source's panel). */
  highlightNode: number | null;
  /** The junction whose lanes are being connected with the lane connector (replacing the current tool). */
  laneEditNode: number | null;
  /** Mirrors the map's name (shown by the logo). */
  mapName: string;
  /** Mirrors the map's driving side (the road network owns it and saves it with the map). */
  drivingSide: DrivingSide;
  setTool: (tool: ToolId) => void;
  setBulldozing: (bulldozing: boolean) => void;
  setSpeed: (speed: SimSpeed) => void;
  setSnapToGrid: (snapToGrid: boolean) => void;
  setSnapInverted: (snapInverted: boolean) => void;
  updateRoadSpec: (changes: Partial<RoadSpec>) => void;
  setRoadMode: (mode: RoadMode) => void;
  setBulldozeMode: (mode: BulldozeMode) => void;
  setTrafficMode: (mode: TrafficMode) => void;
  setHighlightNode: (id: number | null) => void;
  setLaneEditNode: (id: number | null) => void;
  setGuideSnapping: (guideSnapping: boolean) => void;
  setHint: (hint: GameState["hint"]) => void;
  setParallel: (parallel: boolean) => void;
  /** Moves the parallel offset one step right (+1) or left (-1), skipping zero. */
  nudgeParallelOffset: (direction: 1 | -1) => void;
  togglePause: () => void;
  setStats: (stats: Stats) => void;
  setAutosave: (autosave: GameState["autosave"]) => void;
  showMessage: (message: string | null) => void;
  setDrivingSide: (side: DrivingSide) => void;
  setMapName: (name: string) => void;
  setJunctionHover: (hover: GameState["junctionHover"]) => void;
  setJunctionOpen: (open: GameState["junctionOpen"]) => void;
  /** The radio station picked (an index into the radio's list). */
  station: number;
  setStation: (station: number) => void;
}

/**
 * Shared between the React HUD (via `useGame`) and the render engine
 * (via `gameStore.getState()` / `gameStore.subscribe`).
 */
export const gameStore = createStore<GameState>()((set, get) => ({
  tool: "select",
  bulldozing: false,
  timeOfDay: 13,
  weather: "sunny",
  setTimeOfDay: (timeOfDay) => set({ timeOfDay }),
  setWeather: (weather) => set({ weather }),
  station: 0,
  setStation: (station) => set({ station }),
  // Starts paused, so the player looks around before traffic moves.
  speed: 0,
  lastSpeed: 1,
  snapToGrid: true,
  snapInverted: false,
  // New roads get footpaths unless switched off.
  roadSpec: { ...DEFAULT_ROAD_SPEC, footpath: true },
  roadMode: "straight",
  bulldozeMode: "single",
  trafficMode: "villa",
  highlightNode: null,
  laneEditNode: null,
  guideSnapping: true,
  hint: null,
  parallel: false,
  parallelOffset: 64,
  stats: { fps: 0, traffic: null },
  autosave: null,
  message: null,
  drivingSide: "right",
  mapName: "",
  junctionHover: null,
  junctionOpen: null,
  // Picking a tool ends any lane connecting; bulldozing carries on between Road and Traffic, not to Select.
  setTool: (tool) => set((s) => ({ tool, laneEditNode: null, bulldozing: s.bulldozing && tool !== "select" })),
  setBulldozing: (bulldozing) => set((s) => ({ bulldozing: bulldozing && s.tool !== "select", laneEditNode: null })),
  setSpeed: (speed) => set(speed === 0 ? { speed } : { speed, lastSpeed: speed }),
  setSnapToGrid: (snapToGrid) => set({ snapToGrid }),
  setSnapInverted: (snapInverted) => set({ snapInverted }),
  updateRoadSpec: (changes) => set((s) => ({ roadSpec: { ...s.roadSpec, ...changes } })),
  setRoadMode: (roadMode) => set({ roadMode }),
  setBulldozeMode: (bulldozeMode) => set({ bulldozeMode }),
  setTrafficMode: (trafficMode) => set({ trafficMode }),
  setHighlightNode: (highlightNode) => set({ highlightNode }),
  setLaneEditNode: (laneEditNode) => set({ laneEditNode }),
  setGuideSnapping: (guideSnapping) => set({ guideSnapping }),
  setHint: (hint) => set({ hint }),
  setParallel: (parallel) => set({ parallel }),
  nudgeParallelOffset: (direction) =>
    set((s) => {
      let next = s.parallelOffset + direction * PARALLEL_OFFSET_STEP;
      if (next === 0) next = direction * PARALLEL_OFFSET_STEP;
      return { parallelOffset: Math.max(-PARALLEL_OFFSET_MAX, Math.min(PARALLEL_OFFSET_MAX, next)) };
    }),
  togglePause: () => {
    const { speed, lastSpeed } = get();
    set({ speed: speed === 0 ? lastSpeed : 0 });
  },
  setStats: (stats) => set({ stats }),
  setAutosave: (autosave) => set({ autosave }),
  showMessage: (message) => set({ message }),
  setDrivingSide: (drivingSide) => set({ drivingSide }),
  setMapName: (mapName) => set({ mapName }),
  setJunctionHover: (junctionHover) => set({ junctionHover }),
  setJunctionOpen: (junctionOpen) => set({ junctionOpen }),
}));

export function useGame<T>(selector: (state: GameState) => T): T {
  return useStore(gameStore, selector);
}

/** Whether road endpoints snap right now: the setting, flipped while Alt/Option is held. */
export function isSnapping(state: Pick<GameState, "snapToGrid" | "snapInverted">): boolean {
  return state.snapToGrid !== state.snapInverted;
}
