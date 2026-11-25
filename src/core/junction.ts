import { LANE_WIDTH, type RoadSpec } from "./roadSpec";

/** How traffic entering a junction is controlled. */
export type JunctionControl = "none" | "yield" | "stop" | "signals";

/** Per-junction settings, saved with the map. */
export interface JunctionSettings {
  control: JunctionControl;
  /** Drawn (and later simulated) as a roundabout; entries give way to the ring. */
  roundabout: boolean;
  /** Corner smoothness, 0 (sharp) to MAX_CORNER_RADIUS; see `kerbRadius` for the radius it gives. */
  cornerRadius: number;
}

export const MAX_CORNER_RADIUS = 40;

/** Up to this setting the kerb radius equals the setting; beyond it the radius grows faster. */
const KERB_LINEAR_UP_TO = 16;
/** Kerb radius at full smoothness: wide sweeping corners that open the junction right out. */
const KERB_RADIUS_MAX = 120;

/**
 * Kerb radius of a plain junction's corners for a corner smoothness setting. Equal to the setting
 * up to the default, then easing up (without a kink) to KERB_RADIUS_MAX at full smoothness.
 */
export function kerbRadius(setting: number): number {
  if (setting <= KERB_LINEAR_UP_TO) return setting;
  const over = setting - KERB_LINEAR_UP_TO;
  const span = MAX_CORNER_RADIUS - KERB_LINEAR_UP_TO;
  return setting + ((KERB_RADIUS_MAX - MAX_CORNER_RADIUS) * over * over) / (span * span);
}

export const DEFAULT_JUNCTION: JunctionSettings = { control: "stop", roundabout: false, cornerRadius: 16 };

const CONTROLS: JunctionControl[] = ["none", "yield", "stop", "signals"];

/** Validates junction settings read from a saved map (missing fields take defaults). */
export function parseJunctionSettings(raw: unknown): JunctionSettings {
  const s = (raw ?? {}) as Partial<JunctionSettings>;
  const control = s.control ?? DEFAULT_JUNCTION.control;
  const roundabout = s.roundabout ?? DEFAULT_JUNCTION.roundabout;
  const cornerRadius = s.cornerRadius ?? DEFAULT_JUNCTION.cornerRadius;
  if (
    !CONTROLS.includes(control) ||
    typeof roundabout !== "boolean" ||
    !Number.isFinite(cornerRadius) ||
    cornerRadius < 0 ||
    cornerRadius > MAX_CORNER_RADIUS
  ) {
    throw new Error("Invalid junction settings in map file");
  }
  return { control, roundabout, cornerRadius };
}

export function isDefaultJunction(s: JunctionSettings): boolean {
  return (
    s.control === DEFAULT_JUNCTION.control &&
    s.roundabout === DEFAULT_JUNCTION.roundabout &&
    s.cornerRadius === DEFAULT_JUNCTION.cornerRadius
  );
}

/** Size of a roundabout serving roads with these specs. */
export interface RoundaboutShape {
  /** Radius of the central island. */
  island: number;
  /** Radius of the ring road's outer edge. */
  outer: number;
  /** Lanes around the ring. */
  lanes: number;
}

export function roundaboutShape(specs: RoadSpec[]): RoundaboutShape {
  const lanes = Math.max(1, ...specs.map((s) => s.lanes));
  const ring = lanes * LANE_WIDTH + 4;
  const island = Math.max(14, ring);
  return { island, outer: island + ring, lanes };
}

/** Seconds of green and of yellow per signal phase. */
export const SIGNAL_GREEN = 8;
export const SIGNAL_YELLOW = 2;

export type SignalLight = "red" | "yellow" | "green";

/**
 * The light shown to each approach (sorted by angle around the junction) at simulation time
 * `time`. Phases cycle round the approaches; with an even count, opposite approaches share one.
 */
export function signalLights(approaches: number, time: number): SignalLight[] {
  const pairs = approaches % 2 === 0 && approaches >= 4;
  const phases = pairs ? approaches / 2 : approaches;
  const cycle = SIGNAL_GREEN + SIGNAL_YELLOW;
  const phase = Math.floor(time / cycle) % phases;
  const inPhase = time % cycle;
  const lit: SignalLight = inPhase < SIGNAL_GREEN ? "green" : "yellow";
  return Array.from({ length: approaches }, (_, i) => ((pairs ? i % phases : i) === phase ? lit : "red"));
}
