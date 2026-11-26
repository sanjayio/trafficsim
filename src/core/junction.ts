import type { LaneConnection } from "./lanes";
import type { NodeId, RoadGraph, SegmentId } from "./roadGraph";
import { carriagewayWidth, LANE_WIDTH, type RoadSpec } from "./roadSpec";

/** How traffic entering a junction is controlled. */
export type JunctionControl = "none" | "yield" | "stop" | "signals";

/** Per-junction settings, saved with the map. */
export interface JunctionSettings {
  control: JunctionControl;
  /** Drawn (and later simulated) as a roundabout; entries give way to the ring. */
  roundabout: boolean;
  /** Corner smoothness, 0 (sharp) to MAX_CORNER_RADIUS; see `kerbRadius` for the radius it gives. */
  cornerRadius: number;
  /** Lane connections set with the lane connector (absent: the defaults, see `defaultConnections`). */
  connections?: LaneConnection[];
  /** Stop or give way: which of the junction's main-road choices (see `mainRoadChoices`) has priority; the rest stop or give way. */
  major?: number;
  /** Where a slip road joins (see `slipRoad`): give way (the default), stop, or signals on every approach. */
  slipControl?: SlipControl;
  /** Under signals: kerb-side turns may go on red, after stopping, giving way to traffic with a green. */
  turnOnRed?: boolean;
}

export const SLIP_CONTROLS = ["yield", "stop", "signals"] as const;
export type SlipControl = (typeof SLIP_CONTROLS)[number];

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

/** Two roads meeting at less than about 45° off straight count as one road carrying on through a junction. */
const STRAIGHT_THROUGH = 0.7;

export const DEFAULT_JUNCTION: JunctionSettings = { control: "stop", roundabout: false, cornerRadius: 16 };

/** How entering traffic is actually controlled: roundabouts always give way. */
export function effectiveControl(s: JunctionSettings): JunctionControl {
  return s.roundabout ? "yield" : s.control;
}

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
  if (s.major !== undefined && (!Number.isInteger(s.major) || s.major < 0 || s.major > 16)) {
    throw new Error("Invalid junction settings in map file");
  }
  if (s.slipControl !== undefined && !(SLIP_CONTROLS as readonly unknown[]).includes(s.slipControl)) {
    throw new Error("Invalid junction settings in map file");
  }
  if (s.turnOnRed !== undefined && typeof s.turnOnRed !== "boolean") throw new Error("Invalid junction settings in map file");
  const major = {
    ...(s.major === undefined ? {} : { major: s.major }),
    ...(s.slipControl === undefined ? {} : { slipControl: s.slipControl }),
    ...(s.turnOnRed ? { turnOnRed: true } : {}),
  };
  if (s.connections === undefined) return { control, roundabout, cornerRadius, ...major };
  const ref = (r: unknown) =>
    !!r && Number.isSafeInteger((r as { segment: unknown }).segment) && Number.isSafeInteger((r as { lane: unknown }).lane);
  if (!Array.isArray(s.connections) || !s.connections.every((c) => ref(c?.from) && ref(c?.to))) {
    throw new Error("Invalid lane connections in map file");
  }
  const connections = s.connections.map((c) => ({
    from: { segment: c.from.segment, lane: c.from.lane },
    to: { segment: c.to.segment, lane: c.to.lane },
  }));
  return { control, roundabout, cornerRadius, connections, ...major };
}

export function isDefaultJunction(s: JunctionSettings): boolean {
  return (
    s.control === DEFAULT_JUNCTION.control &&
    s.roundabout === DEFAULT_JUNCTION.roundabout &&
    s.cornerRadius === DEFAULT_JUNCTION.cornerRadius &&
    s.connections === undefined &&
    s.major === undefined &&
    s.slipControl === undefined &&
    !s.turnOnRed
  );
}

/**
 * The pairs of roads at junction `nodeId` that could be its main road, straightest through first:
 * at a T, just the road carrying on; at a crossroads, the two opposite pairs.
 */
export function mainRoadChoices(graph: RoadGraph, nodeId: NodeId): [SegmentId, SegmentId][] {
  const roads = graph.segmentsAt(nodeId);
  const pairs: { pair: [SegmentId, SegmentId]; straight: number }[] = [];
  for (let i = 0; i < roads.length; i++) {
    for (let j = i + 1; j < roads.length; j++) {
      const a = graph.directionAway(roads[i], nodeId);
      const b = graph.directionAway(roads[j], nodeId);
      pairs.push({ pair: [roads[i].id, roads[j].id], straight: -(a.x * b.x + a.y * b.y) });
    }
  }
  pairs.sort((p, q) => q.straight - p.straight);
  // Pairs running nearly straight through: one at a T, two at a crossroads. Where none do (a Y), any pair.
  const through = pairs.filter((p) => p.straight > STRAIGHT_THROUGH);
  return (through.length ? through : pairs.slice(0, roads.length)).map((p) => p.pair);
}

/**
 * The roads at junction `nodeId` whose traffic stops or gives way: under a stop or give-way
 * control, every road but the chosen main road (see `mainRoadChoices`); at a roundabout, every
 * entry. Empty under signals or no control.
 */
export function minorRoads(graph: RoadGraph, nodeId: NodeId): Set<SegmentId> {
  const roads = graph.segmentsAt(nodeId);
  const settings = graph.junction(nodeId);
  // A slip road: the main road has priority; traffic merging off the slip road gives way.
  const slip = slipRoad(graph, nodeId);
  if (slip) return new Set(slip.merge && slipControlAt(graph, nodeId) !== "signals" ? [slip.slip] : []);
  const control = effectiveControl(settings);
  if (roads.length < 3 || (control !== "stop" && control !== "yield")) return new Set();
  if (settings.roundabout) return new Set(roads.map((s) => s.id));
  const choices = mainRoadChoices(graph, nodeId);
  const main = choices[(settings.major ?? 0) % choices.length];
  return new Set(roads.filter((s) => !main.includes(s.id)).map((s) => s.id));
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

/**
 * The roads whose traffic enters junction `nodeId`, in the order signal phases go round them
 * (by the direction each leaves the junction). `signalLights` gives the light for each.
 */
export function signalApproaches(graph: RoadGraph, nodeId: NodeId): SegmentId[] {
  const angle = (s: SegmentId) => {
    const d = graph.directionAway(graph.segments.get(s)!, nodeId);
    return Math.atan2(d.y, d.x);
  };
  return graph
    .segmentsAt(nodeId)
    // One-way roads leading away from the junction have no traffic entering here.
    .filter((s) => !s.spec.oneWay || s.b === nodeId)
    .map((s) => s.id)
    .sort((p, q) => angle(p) - angle(q));
}

export type SignalLight = "red" | "yellow" | "green";

/**
 * The light shown to each approach (sorted by angle around the junction) at simulation time
 * `time`, green and amber lasting as `timing` says (seconds). Phases cycle round the approaches; with an even count, opposite approaches share one.
 */
export function signalLights(approaches: number, time: number, timing: { green: number; amber: number }): SignalLight[] {
  const pairs = approaches % 2 === 0 && approaches >= 4;
  const phases = pairs ? approaches / 2 : approaches;
  const cycle = timing.green + timing.amber;
  const phase = Math.floor(time / cycle) % phases;
  const inPhase = time % cycle;
  const lit: SignalLight = inPhase < timing.green ? "green" : "yellow";
  return Array.from({ length: approaches }, (_, i) => ((pairs ? i % phases : i) === phase ? lit : "red"));
}

/** How close to the main road's direction (cosine of ~35°) a one-way road must leave or join it to be a slip road. */
const SLIP_ALONG = 0.82;
/** How straight the main road must run through (cosine of ~25° off straight). */
const SLIP_THROUGH = 0.9;

/**
 * Whether junction `nodeId` is where a one-way slip road leaves (`merge` false) or joins (`merge`
 * true) a main road: exactly three roads, two of them running on straight through, the third one-way
 * and within about 35° of the main road's direction, on the side whose lane runs its way (left
 * of a road under left-hand traffic, right under right-hand). Such a node has no junction: the slip road
 * peels off or tapers in, its traffic giving way where it joins. Not at a roundabout.
 */
export function slipRoad(graph: RoadGraph, nodeId: NodeId): { slip: SegmentId; through: [SegmentId, SegmentId]; merge: boolean } | null {
  const roads = graph.segmentsAt(nodeId);
  if (roads.length !== 3 || graph.junction(nodeId).roundabout) return null;
  const oneWays = roads.filter((s) => s.spec.oneWay);
  if (oneWays.length !== 1) return null;
  const slip = oneWays[0];
  const [a, b] = roads.filter((s) => s !== slip);
  const dir = (s: (typeof roads)[number]) => graph.directionAway(s, nodeId);
  const dot = (p: { x: number; y: number }, q: { x: number; y: number }) => p.x * q.x + p.y * q.y;
  if (-dot(dir(a), dir(b)) < SLIP_THROUGH) return null;
  if (Math.max(dot(dir(slip), dir(a)), dot(dir(slip), dir(b))) < SLIP_ALONG) return null;
  // Only off (or into) the main road's lane running the slip road's way: on the side traffic keeps to.
  const merge = slip.b === nodeId;
  const along = dot(dir(slip), dir(a)) >= dot(dir(slip), dir(b)) ? dir(a) : dir(b);
  const travel = merge ? { x: -along.x, y: -along.y } : along;
  const right = { x: -travel.y, y: travel.x };
  const keep = graph.drivingSide === "right" ? 1 : -1;
  if (dot(dir(slip), right) * keep <= 0) return null;
  return { slip: slip.id, through: [a.id, b.id], merge };
}

/** How traffic joining from a slip road at `nodeId` is controlled. */
export function slipControlAt(graph: RoadGraph, nodeId: NodeId): SlipControl {
  return graph.junction(nodeId).slipControl ?? "yield";
}

/**
 * Where a slip road's end at `nodeId` is drawn and driven from: moved from the main road's centre
 * line (where the node is) out to the middle of the main road's outside lane on the slip road's
 * side, so it peels off (or tapers into) that lane. Null for any other road end.
 */
export function slipShift(graph: RoadGraph, nodeId: NodeId, segmentId: SegmentId): { x: number; y: number } | null {
  const slip = slipRoad(graph, nodeId);
  if (!slip || slip.slip !== segmentId) return null;
  const road = graph.segments.get(segmentId)!;
  const away = graph.directionAway(road, nodeId);
  // The main road's arm running the same way as the slip road, and which side of it the slip road lies.
  const arms = slip.through.map((id) => graph.segments.get(id)!);
  const dot = (s: (typeof arms)[number]) => {
    const d = graph.directionAway(s, nodeId);
    return d.x * away.x + d.y * away.y;
  };
  const arm = dot(arms[0]) >= dot(arms[1]) ? arms[0] : arms[1];
  const along = graph.directionAway(arm, nodeId);
  const side = along.x * away.y - along.y * away.x >= 0 ? 1 : -1;
  const offset = carriagewayWidth(arm.spec) / 2 - LANE_WIDTH / 2;
  return { x: -along.y * side * offset, y: along.x * side * offset };
}
