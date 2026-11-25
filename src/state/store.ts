import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { DrivingSide } from "../core/roadGraph";
import { DEFAULT_ROAD_SPEC, type RoadSpec } from "../core/roadSpec";
import type { BulldozeMode, RoadMode } from "../tools/Tool";

/** Parallel road offset limits and step, centre to centre, in world units. */
export const PARALLEL_OFFSET_STEP = 8;
export const PARALLEL_OFFSET_MAX = 512;

export type ToolId = "select" | "road" | "bulldoze";
export type SimSpeed = 0 | 1 | 2 | 4;

export interface Stats {
  fps: number;
  nodes: number;
  segments: number;
  simTime: number;
}

interface GameState {
  tool: ToolId;
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
  /** Road tool: snap onto roads, guidelines and angles. */
  guideSnapping: boolean;
  /** Short readout next to the cursor (road length and angle while drawing), in canvas pixels. */
  hint: { text: string; x: number; y: number } | null;
  /** Road tool: also build a parallel copy. */
  parallel: boolean;
  /** Signed offset of the parallel copy (positive: right of the direction drawn). Never 0. */
  parallelOffset: number;
  stats: Stats;
  message: string | null;
  /**
   * The junction under the cursor (offering its ⚙ button) and the junction whose options panel is
   * open, each with its current screen position in canvas pixels (kept up to date by the engine).
   */
  junctionHover: { id: number; x: number; y: number } | null;
  junctionOpen: { id: number; x: number; y: number } | null;
  /** Mirrors the map's driving side (the road network owns it and saves it with the map). */
  drivingSide: DrivingSide;
  setTool: (tool: ToolId) => void;
  setSpeed: (speed: SimSpeed) => void;
  setSnapToGrid: (snapToGrid: boolean) => void;
  setSnapInverted: (snapInverted: boolean) => void;
  updateRoadSpec: (changes: Partial<RoadSpec>) => void;
  setRoadMode: (mode: RoadMode) => void;
  setBulldozeMode: (mode: BulldozeMode) => void;
  setGuideSnapping: (guideSnapping: boolean) => void;
  setHint: (hint: GameState["hint"]) => void;
  setParallel: (parallel: boolean) => void;
  /** Moves the parallel offset one step right (+1) or left (-1), skipping zero. */
  nudgeParallelOffset: (direction: 1 | -1) => void;
  togglePause: () => void;
  setStats: (stats: Stats) => void;
  showMessage: (message: string | null) => void;
  setDrivingSide: (side: DrivingSide) => void;
  setJunctionHover: (hover: GameState["junctionHover"]) => void;
  setJunctionOpen: (open: GameState["junctionOpen"]) => void;
}

/**
 * Shared between the React HUD (via `useGame`) and the render engine
 * (via `gameStore.getState()` / `gameStore.subscribe`).
 */
export const gameStore = createStore<GameState>()((set, get) => ({
  tool: "road",
  speed: 1,
  lastSpeed: 1,
  snapToGrid: true,
  snapInverted: false,
  roadSpec: { ...DEFAULT_ROAD_SPEC },
  roadMode: "straight",
  bulldozeMode: "single",
  guideSnapping: true,
  hint: null,
  parallel: false,
  parallelOffset: 64,
  stats: { fps: 0, nodes: 0, segments: 0, simTime: 0 },
  message: null,
  drivingSide: "right",
  junctionHover: null,
  junctionOpen: null,
  setTool: (tool) => set({ tool }),
  setSpeed: (speed) => set(speed === 0 ? { speed } : { speed, lastSpeed: speed }),
  setSnapToGrid: (snapToGrid) => set({ snapToGrid }),
  setSnapInverted: (snapInverted) => set({ snapInverted }),
  updateRoadSpec: (changes) => set((s) => ({ roadSpec: { ...s.roadSpec, ...changes } })),
  setRoadMode: (roadMode) => set({ roadMode }),
  setBulldozeMode: (bulldozeMode) => set({ bulldozeMode }),
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
  showMessage: (message) => set({ message }),
  setDrivingSide: (drivingSide) => set({ drivingSide }),
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
