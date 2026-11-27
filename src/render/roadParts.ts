import type { BufferGeometry } from "three";
import { SampledCurve, type Curve, type PathFrame } from "../core/curve";
import type { DrivingSide } from "../core/roadGraph";
import type { Vec2 } from "../core/geometry";
import {
  carriagewayWidth,
  FOOTPATH_WIDTH,
  hasMedian,
  LANE_WIDTH,
  MEDIAN_WIDTH,
  roadWidth,
  type RoadSpec,
} from "../core/roadSpec";
import { laneOffsets, type Turn } from "../core/lanes";
import { convexGeometry, FlatLayer, KERB_WIDTH, pavedGeometry } from "./flat";
import { palette } from "./palette";

export type RoadPart = "footpath" | "asphalt" | "median" | "centerLine" | "laneLine" | "arrow" | "stopLine";

/** How markings finish at one end of a road. */
export interface RoadEnd {
  /** Distance from the end where markings stop (0 where the road simply continues). */
  inset: number;
  /**
   * Marking across the lanes entering a junction here: a solid stop line ("stop", also used at
   * traffic signals), give-way triangles ("yield"), or nothing.
   */
  entry: "none" | "stop" | "yield";
  /**
   * A dead end on a two-way road: lane lines loop round the rounded end so it reads as a
   * turnaround, and the centre line or median runs to its middle. `inset` is then unused.
   */
  turnaround?: boolean;
  /**
   * A zebra crossing across the road, in the `CROSSING_ROOM` between where its markings stop
   * (the stop line, where cars wait) and the junction, with tactile paving on the footpaths at each end.
   */
  crossing?: boolean;
  /**
   * At a junction, the turns each lane arriving here may make (by lane index for the direction of
   * travel towards this end), painted as arrows just before the line.
   */
  turns?: Turn[][];
}

export const ROAD_PART_STYLE: Record<RoadPart, { color: number; layer: number }> = {
  footpath: { color: palette.footpath, layer: FlatLayer.footpath },
  asphalt: { color: palette.asphalt, layer: FlatLayer.asphalt },
  median: { color: palette.median, layer: FlatLayer.markings },
  centerLine: { color: palette.centerLine, layer: FlatLayer.markings },
  laneLine: { color: palette.laneLine, layer: FlatLayer.markings },
  arrow: { color: palette.laneLine, layer: FlatLayer.markings },
  stopLine: { color: palette.laneLine, layer: FlatLayer.markings },
};

const CENTER_LINE_WIDTH = 1;
const LANE_LINE_WIDTH = 1;
/** On roads without footpaths, a solid white line along each edge, this far in from it (to its middle). */
export const EDGE_LINE_INSET = 1.5;
const DASH_LENGTH = 8;
const DASH_GAP = 8;
const ARROW_SPACING = 72;
const ARROW_HEAD_LENGTH = 7;
const ARROW_HEAD_WIDTH = 6;
const ARROW_SHAFT_LENGTH = 7;
const ARROW_SHAFT_WIDTH = 1.6;
const CAP_SEGMENTS = 12;
const STOP_LINE_WIDTH = 2;
/** A zebra crossing: how deep its stripes are (along the road), and the clear gap either side of it. */
const ZEBRA_DEPTH = 6;
const ZEBRA_GAP = 1.5;
/** How much further back a road's markings (and the cars waiting) stop for a crossing at its end (see `RoadEnd.crossing`). */
export const CROSSING_ROOM = ZEBRA_DEPTH + ZEBRA_GAP * 2;
/** The yellow tactile paving at each end of a crossing: how far across the footpath it reaches, from just past the kerb. */
const TACTILE_DEPTH = 4;

/**
 * Geometry for every visible piece of a road along `path`. Offsets are measured to the right
 * of the direction of travel (a → b). Two-way traffic keeps to `side`; one-way roads flow a → b.
 */
export function buildRoadParts(
  path: SampledCurve,
  spec: RoadSpec,
  /** How markings finish at each end. Defaults to a dead end at both. */
  ends?: { start: RoadEnd; end: RoadEnd },
  side: DrivingSide = "right",
  /** Round off each end (start, end): left square where a bridge or tunnel meets a road it's drawn over. */
  caps: [boolean, boolean] = [true, true],
  /** The stretch of road paved (the rest is drawn by a bend at that end, see `buildBendSurface`). */
  paved: [number, number] = [0, path.length],
): { part: RoadPart; geometry: BufferGeometry }[] {
  const parts: { part: RoadPart; geometry: BufferGeometry }[] = [];
  const carriageway = carriagewayWidth(spec);
  const length = path.length;
  const deadEnd: RoadEnd = { inset: carriageway / 2, entry: "none", turnaround: true };
  const { start, end } = ends ?? { start: deadEnd, end: deadEnd };

  if (spec.footpath) {
    // Footpath and kerb stones beside the road only (none under it: on a bridge, drawn with depth, a
    // raised footpath under the road would hide it), and the kerb's face along both edges and round
    // each rounded end.
    const half = carriageway / 2;
    const faces = [edgeLine(path, half, paved), edgeLine(path, -half, paved)];
    if (caps[0]) faces.push(halfDisc(path.at(paved[0]), half, -1));
    if (caps[1]) faces.push(halfDisc(path.at(paved[1]), half, 1));
    parts.push({
      part: "footpath",
      geometry: pavedGeometry(beside(path, half, roadWidth(spec) / 2, caps, paved), beside(path, half, half + KERB_WIDTH, caps, paved), faces),
    });
  }
  parts.push({ part: "asphalt", geometry: convexGeometry(surface(path, carriageway, caps, paved)) });

  // Markings stop short of junctions so they don't run through them. At a two-way dead end they
  // run to the end, where lane lines loop round (one-way roads have no turnaround).
  const turnStart = !!start.turnaround && !spec.oneWay;
  const turnEnd = !!end.turnaround && !spec.oneWay;
  // When the two ends want more than the whole road, they share it in proportion (a short road
  // into a roundabout, continuing straight on at its other end, keeps its whole inset there).
  const want0 = turnStart ? 0 : start.inset;
  const want1 = turnEnd ? 0 : end.inset;
  const fit = Math.min(1, length / (want0 + want1 || 1));
  const s0 = want0 * fit;
  const s1 = length - want1 * fit;
  if (s1 <= s0) return parts;

  // Entry markings span the lanes heading into the junction: at the end, lanes travelling a → b;
  // at the start, lanes travelling b → a. Those keep to the driving side of their direction of
  // travel: right of centre (positive offsets) for a → b under right-hand traffic, and mirrored
  // for left-hand. One-way roads only enter at the end, across their whole width.
  const middle = hasMedian(spec) ? MEDIAN_WIDTH / 2 : 0;
  const keep = side === "right" ? 1 : -1;
  const entryMarks: Vec2[][] = [];
  /** Marks across offsets from..to; `s` is the junction-side edge, `towardTraffic` the way back from it. */
  const markAcross = (style: RoadEnd["entry"], s: number, towardTraffic: 1 | -1, from: number, to: number) => {
    if (style === "stop") {
      const back = s + towardTraffic * STOP_LINE_WIDTH;
      entryMarks.push(...ribbon(path, (from + to) / 2, Math.abs(to - from), Math.min(s, back), Math.max(s, back)));
    } else if (style === "yield") {
      entryMarks.push(...giveWayTeeth(path, s, towardTraffic, Math.min(from, to), Math.max(from, to)));
    }
  };
  if (spec.oneWay) markAcross(end.entry, s1, -1, -carriageway / 2, carriageway / 2);
  else {
    markAcross(end.entry, s1, -1, keep * middle, (keep * carriageway) / 2);
    markAcross(start.entry, s0, 1, (-keep * carriageway) / 2, -keep * middle);
  }
  if (entryMarks.length) parts.push({ part: "stopLine", geometry: convexGeometry(entryMarks) });

  const dashes = (offset: number, width = LANE_LINE_WIDTH): Vec2[][] => {
    const out: Vec2[][] = [];
    for (let s = s0; s < s1; s += DASH_LENGTH + DASH_GAP) {
      out.push(...ribbon(path, offset, width, s, Math.min(s + DASH_LENGTH, s1)));
    }
    return out;
  };

  const laneLines: Vec2[][] = [];
  // Yellow paint, in one mesh: the centre line and crossings' tactile paving.
  const yellow: Vec2[][] = [];
  if (spec.oneWay) {
    // Lanes span the carriageway; dividers between them, arrows down each lane's centre.
    const left = -carriageway / 2;
    for (let k = 1; k < spec.lanes; k++) laneLines.push(...dashes(left + k * LANE_WIDTH));

    const arrows: Vec2[][] = [];
    const markLength = s1 - s0;
    const count = Math.max(1, Math.floor(markLength / ARROW_SPACING));
    const span = ARROW_SHAFT_LENGTH + ARROW_HEAD_LENGTH;
    // Keep clear of the turn arrows by the far end.
    const last = end.turns ? s1 - TURN_ARROW_BACK - TURN_ARROW_LENGTH - 4 : s1;
    for (let lane = 0; lane < spec.lanes; lane++) {
      const offset = left + (lane + 0.5) * LANE_WIDTH;
      for (let i = 0; i < count; i++) {
        const tail = s0 + ((i + 0.5) * markLength) / count - span / 2;
        if (tail < s0 || tail + span > last) continue;
        arrows.push(...arrow(path, offset, tail));
      }
    }
    if (arrows.length) parts.push({ part: "arrow", geometry: convexGeometry(arrows) });
  } else {
    if (hasMedian(spec)) {
      // At a turnaround the median ends in a rounded tip, like an island; elsewhere square.
      parts.push({ part: "median", geometry: raisedMedian(path, s0, s1, [turnStart ? "round" : "square", turnEnd ? "round" : "square"]) });
    } else {
      yellow.push(...dashes(0, CENTER_LINE_WIDTH));
    }
    for (let k = 1; k < spec.lanes; k++) {
      const offset = middle + k * LANE_WIDTH;
      laneLines.push(...dashes(offset), ...dashes(-offset));
      // Join each pair of matching lane lines round the dead end.
      if (turnStart) laneLines.push(...dashedArc(path.at(0), offset, -1));
      if (turnEnd) laneLines.push(...dashedArc(path.at(length), offset, 1));
    }
  }
  // Zebra crossings at junction ends: white stripes across the carriageway, tactile paving (yellow,
  // with the centre line) on the footpath either side.
  for (const [ends, from] of [[end, s1 + ZEBRA_GAP], [start, s0 - ZEBRA_GAP - ZEBRA_DEPTH]] as const) {
    if (!ends.crossing) continue;
    const to = from + ZEBRA_DEPTH;
    const stripes = Math.max(3, Math.round(carriageway / 4));
    const pitch = carriageway / stripes;
    for (let i = 0; i < stripes; i++) laneLines.push(...ribbon(path, -carriageway / 2 + pitch * (i + 0.5), pitch * 0.55, from, to));
    if (spec.footpath) for (const side of [1, -1]) yellow.push(...ribbon(path, side * (carriageway / 2 + 1 + TACTILE_DEPTH / 2), TACTILE_DEPTH, from + 1.5, to - 1.5));
  }
  // Without footpaths, a solid line along each edge (looping round a two-way dead end, as the lane lines do).
  if (!spec.footpath) {
    const offset = carriageway / 2 - EDGE_LINE_INSET;
    laneLines.push(...ribbon(path, offset, LANE_LINE_WIDTH, s0, s1), ...ribbon(path, -offset, LANE_LINE_WIDTH, s0, s1));
    if (turnStart) laneLines.push(...dashedArc(path.at(0), offset, -1, Infinity));
    if (turnEnd) laneLines.push(...dashedArc(path.at(length), offset, 1, Infinity));
  }
  if (yellow.length) parts.push({ part: "centerLine", geometry: convexGeometry(yellow) });
  if (laneLines.length) parts.push({ part: "laneLine", geometry: convexGeometry(laneLines) });

  // Turn arrows on the lanes arriving at each junction end. Lane offsets are right of the direction
  // of travel: along the path towards the end (b), against it towards the start (a).
  const turnArrows: Vec2[][] = [];
  const offsets = laneOffsets(spec, side);
  const kerbRight = side === "right";
  for (const [ends, s, forward] of [[end, s1 - TURN_ARROW_BACK, true], [start, s0 + TURN_ARROW_BACK, false]] as const) {
    if (!ends.turns || (spec.oneWay && !forward) || s1 - s0 < TURN_ARROW_LENGTH + TURN_ARROW_BACK * 2) continue;
    const f = path.at(s);
    const sign = forward ? 1 : -1;
    const travel = { x: f.tangent.x * sign, y: f.tangent.y * sign };
    const right = { x: f.normal.x * sign, y: f.normal.y * sign };
    ends.turns.forEach((turns, lane) => {
      if (!turns.length) return;
      const tip = { x: f.p.x + right.x * offsets[lane], y: f.p.y + right.y * offsets[lane] };
      const kinds = new Set(turns.map((t) => (t === "straight" ? 0 : (t === "kerb") === kerbRight ? 1 : -1)));
      turnArrows.push(...turnArrow(tip, travel, right, kinds));
    });
  }
  if (turnArrows.length) parts.push({ part: "arrow", geometry: convexGeometry(turnArrows) });

  return parts;
}

/** A marking carried round a bend where two roads join: the centre line, the median, or a lane line. */
export interface BendLine {
  kind: "centerLine" | "median" | "laneLine" | "edgeLine";
  pieces: Curve[];
}

/** Markings round a bend, along the curves given (solid median, dashed centre and lane lines). */
export function buildBendMarkings(lines: BendLine[]): { part: RoadPart; geometry: BufferGeometry }[] {
  const shapes: Record<"centerLine" | "laneLine", Vec2[][]> = { centerLine: [], laneLine: [] };
  const medians: SampledCurve[] = [];
  for (const { kind, pieces } of lines) {
    for (const piece of pieces) {
      const path = new SampledCurve(piece);
      if (kind === "median") medians.push(path);
      // White paint, solid.
      else if (kind === "edgeLine") shapes.laneLine.push(...ribbon(path, 0, LANE_LINE_WIDTH, 0, path.length));
      else {
        const width = kind === "laneLine" ? LANE_LINE_WIDTH : CENTER_LINE_WIDTH;
        for (let s = 0; s < path.length; s += DASH_LENGTH + DASH_GAP) {
          shapes[kind].push(...ribbon(path, 0, width, s, Math.min(s + DASH_LENGTH, path.length)));
        }
      }
    }
  }
  const parts: { part: RoadPart; geometry: BufferGeometry }[] = (Object.keys(shapes) as (keyof typeof shapes)[])
    .filter((kind) => shapes[kind].length)
    .map((kind) => ({ part: kind, geometry: convexGeometry(shapes[kind]) }));
  // Round a bend the median carries on from the roads' either side: open ends.
  for (const path of medians) parts.push({ part: "median", geometry: raisedMedian(path, 0, path.length, ["open", "open"]) });
  return parts;
}

/** Turn arrows stand this far before the stop line, and are this long. */
const TURN_ARROW_BACK = 4;
const TURN_ARROW_LENGTH = 11;

/**
 * A painted lane arrow with its tip at `tip`, pointing along `travel`: a shaft, a head straight on
 * (kind 0), and a branch with a head to the right (1) or left (-1) for each turn allowed.
 */
function turnArrow(tip: Vec2, travel: Vec2, right: Vec2, kinds: Set<number>): Vec2[][] {
  // Local coordinates: u along travel (0 at the tip, negative behind), v to the right.
  const at = (u: number, v: number) => ({ x: tip.x + travel.x * u + right.x * v, y: tip.y + travel.y * u + right.y * v });
  const w = ARROW_SHAFT_WIDTH / 2;
  const tail = -TURN_ARROW_LENGTH;
  const straight = kinds.has(0);
  const shaftEnd = straight ? -4 : -4.5;
  const shapes: Vec2[][] = [[at(tail, -w), at(shaftEnd, -w), at(shaftEnd, w), at(tail, w)]];
  if (straight) shapes.push([at(-4.5, -2.6), at(0, 0), at(-4.5, 2.6)]);
  for (const side of [1, -1]) {
    if (!kinds.has(side)) continue;
    // A bar out of the shaft's upper part, then a head pointing sideways.
    shapes.push([at(-6.2, side * w), at(-4.8, side * w), at(-4.8, side * 2.6), at(-6.2, side * 2.6)]);
    shapes.push([at(-8.2, side * 2.6), at(-2.8, side * 2.6), at(-5.5, side * 5.4)]);
  }
  return shapes;
}

/** The line `offset` right of the road from s0 to s1, at the same stations as its surface. */
function edgeLine(path: SampledCurve, offset: number, [s0, s1]: [number, number]): Vec2[] {
  return [s0, ...path.stationsBetween(s0, s1), s1].map((s) => {
    const f = path.at(s);
    return { x: f.p.x + f.normal.x * offset, y: f.p.y + f.normal.y * offset };
  });
}

/**
 * The strips from `inner` to `outer` either side of the road (and round each rounded end), as
 * convex polygons: what's beside the road's surface, not under it.
 */
function beside(path: SampledCurve, inner: number, outer: number, caps: [boolean, boolean], [s0, s1]: [number, number]): Vec2[][] {
  const polygons = [...ribbon(path, (inner + outer) / 2, outer - inner, s0, s1), ...ribbon(path, -(inner + outer) / 2, outer - inner, s0, s1)];
  for (const [cap, s, forward] of [[caps[0], s0, -1], [caps[1], s1, 1]] as const) {
    if (!cap) continue;
    const [a, b] = [halfDisc(path.at(s), inner, forward), halfDisc(path.at(s), outer, forward)];
    for (let i = 1; i < a.length; i++) polygons.push([a[i - 1], a[i], b[i], b[i - 1]]);
  }
  return polygons;
}

/**
 * A median from s0 to s1 along `path`, raised like a footpath (see `pavedGeometry`): its planting,
 * kerb stones along both edges, and their face down to the road; each end rounded (a turnaround),
 * square, or open (it carries on into another piece).
 */
function raisedMedian(path: SampledCurve, s0: number, s1: number, ends: ["round" | "square" | "open", "round" | "square" | "open"]): BufferGeometry {
  const half = MEDIAN_WIDTH / 2;
  const inner = half - KERB_WIDTH;
  const planting = ribbon(path, 0, inner * 2, s0, s1);
  const kerb = [...ribbon(path, half - KERB_WIDTH / 2, KERB_WIDTH, s0, s1), ...ribbon(path, -(half - KERB_WIDTH / 2), KERB_WIDTH, s0, s1)];
  const faces = [edgeLine(path, half, [s0, s1]), edgeLine(path, -half, [s0, s1])];
  ends.forEach((end, i) => {
    const [s, forward] = i === 0 ? [s0, -1 as const] : [s1, 1 as const];
    const f = path.at(s);
    if (end === "round") {
      const [a, b] = [halfDisc(f, inner, forward), halfDisc(f, half, forward)];
      planting.push(a);
      for (let k = 1; k < a.length; k++) kerb.push([a[k - 1], a[k], b[k], b[k - 1]]);
      faces.push(b);
    } else if (end === "square") {
      const across = (o: number) => ({ x: f.p.x + f.normal.x * o, y: f.p.y + f.normal.y * o });
      faces.push([across(-half), across(half)]);
    }
  });
  return pavedGeometry(planting, kerb, faces);
}

/** A full-width road surface with rounded ends, as convex polygons. */
export function surface(path: SampledCurve, width: number, caps: [boolean, boolean] = [true, true], [s0, s1] = [0, path.length]): Vec2[][] {
  return [
    ...(caps[0] ? [halfDisc(path.at(s0), width / 2, -1)] : []),
    ...ribbon(path, 0, width, s0, s1),
    ...(caps[1] ? [halfDisc(path.at(s1), width / 2, 1)] : []),
  ];
}

/**
 * The surface round a bend where two roads of the same layout join, from `edge(offset)`: the curve
 * `offset` right of travel from where one road stops to where the other starts. Asphalt between the
 * kerbs and footpaths outside them, each a constant width all the way round.
 */
export function buildBendSurface(spec: RoadSpec, edge: (offset: number) => Curve[]): { part: RoadPart; geometry: BufferGeometry }[] {
  const half = carriagewayWidth(spec) / 2;
  // The point a fraction of the way along a curve made of pieces.
  const along = (curve: Curve[]) => {
    const pieces = curve.map((c) => new SampledCurve(c));
    const total = pieces.reduce((sum, p) => sum + p.length, 0);
    return (f: number): Vec2 => {
      let s = f * total;
      for (const piece of pieces) {
        if (s <= piece.length) return piece.at(s).p;
        s -= piece.length;
      }
      const last = pieces[pieces.length - 1];
      return last.at(last.length).p;
    };
  };
  // Quads between two curves, sampled at the same fractions of the way along.
  const band = (p: Curve[], q: Curve[]): Vec2[][] => {
    const [a, b] = [along(p), along(q)];
    const quads: Vec2[][] = [];
    for (let i = 0; i < BEND_STEPS; i++) {
      const [u, v] = [i / BEND_STEPS, (i + 1) / BEND_STEPS];
      quads.push([a(u), a(v), b(v), b(u)]);
    }
    return quads;
  };
  const parts: { part: RoadPart; geometry: BufferGeometry }[] = [{ part: "asphalt", geometry: convexGeometry(band(edge(-half), edge(half))) }];
  if (spec.footpath) {
    const out = half + FOOTPATH_WIDTH;
    const kerb = half + KERB_WIDTH;
    const lines = (offsets: number[]) =>
      offsets.map((offset) => {
        const at = along(edge(offset));
        return Array.from({ length: BEND_STEPS + 1 }, (_, i) => at(i / BEND_STEPS));
      });
    parts.push({
      part: "footpath",
      geometry: pavedGeometry(
        [...band(edge(-out), edge(-half)), ...band(edge(half), edge(out))],
        [...band(edge(-kerb), edge(-half)), ...band(edge(half), edge(kerb))],
        lines([-half, half]),
      ),
    });
  }
  return parts;
}

/** Quads each piece of a bend's surface is drawn in. */
const BEND_STEPS = 24;

/**
 * Point `radius` from frame `f`'s centre, at angle `theta` measured from its right side round
 * through its forward direction (forward = 1, the road's end) or backward (-1, its start).
 */
function aroundEnd(f: PathFrame, radius: number, theta: number, forward: 1 | -1): Vec2 {
  const c = Math.cos(theta);
  const s = Math.sin(theta) * forward;
  return { x: f.p.x + radius * (f.normal.x * c + f.tangent.x * s), y: f.p.y + radius * (f.normal.y * c + f.tangent.y * s) };
}

/** Half disc rounding off a road end: from the right side, round the end, to the left side. */
function halfDisc(f: PathFrame, radius: number, forward: 1 | -1): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i <= CAP_SEGMENTS; i++) out.push(aroundEnd(f, radius, (Math.PI * i) / CAP_SEGMENTS, forward));
  return out;
}

/** A dashed lane line (dashes `dash` long: Infinity for a solid one) looping round a road end at `radius`, joining the lines on either side. */
function dashedArc(f: PathFrame, radius: number, forward: 1 | -1, dash = DASH_LENGTH): Vec2[][] {
  const arcLength = Math.PI * radius;
  const inner = radius - LANE_LINE_WIDTH / 2;
  const outer = radius + LANE_LINE_WIDTH / 2;
  const quads: Vec2[][] = [];
  for (let a = 0; a < arcLength; a += dash + DASH_GAP) {
    const from = a / radius;
    const to = Math.min(a + dash, arcLength) / radius;
    const steps = Math.max(1, Math.ceil((to - from) / (Math.PI / CAP_SEGMENTS)));
    for (let i = 0; i < steps; i++) {
      const t0 = from + ((to - from) * i) / steps;
      const t1 = from + ((to - from) * (i + 1)) / steps;
      quads.push([
        aroundEnd(f, inner, t0, forward),
        aroundEnd(f, inner, t1, forward),
        aroundEnd(f, outer, t1, forward),
        aroundEnd(f, outer, t0, forward),
      ]);
    }
  }
  return quads;
}

/** Quads covering a strip `width` wide, centred `offset` right of the centre line, between arc lengths s0 and s1. */
export function ribbon(path: SampledCurve, offset: number, width: number, s0: number, s1: number): Vec2[][] {
  const stations = [s0, ...path.stationsBetween(s0, s1), s1];
  const edge = (s: number, side: number): Vec2 => {
    const f = path.at(s);
    const d = offset + (side * width) / 2;
    return { x: f.p.x + f.normal.x * d, y: f.p.y + f.normal.y * d };
  };
  const quads: Vec2[][] = [];
  for (let i = 1; i < stations.length; i++) {
    const [sa, sb] = [stations[i - 1], stations[i]];
    quads.push([edge(sa, -1), edge(sb, -1), edge(sb, 1), edge(sa, 1)]);
  }
  return quads;
}

const TOOTH_WIDTH = 3.2;
const TOOTH_LENGTH = 4.5;
const TOOTH_GAP = 1.6;

/**
 * Give-way markings: a row of triangles across offsets from..to with their bases at arc length
 * `s` (the junction side) and their points towards oncoming traffic (`towardTraffic` along the road).
 */
function giveWayTeeth(path: SampledCurve, s: number, towardTraffic: 1 | -1, from: number, to: number): Vec2[][] {
  const f = path.at(s);
  const at = (offset: number, along: number): Vec2 => ({
    x: f.p.x + f.normal.x * offset + f.tangent.x * along,
    y: f.p.y + f.normal.y * offset + f.tangent.y * along,
  });
  const span = to - from;
  const count = Math.max(1, Math.floor((span + TOOTH_GAP) / (TOOTH_WIDTH + TOOTH_GAP)));
  const used = count * TOOTH_WIDTH + (count - 1) * TOOTH_GAP;
  const teeth: Vec2[][] = [];
  for (let i = 0; i < count; i++) {
    const left = from + (span - used) / 2 + i * (TOOTH_WIDTH + TOOTH_GAP);
    teeth.push([at(left, 0), at(left + TOOTH_WIDTH, 0), at(left + TOOTH_WIDTH / 2, towardTraffic * TOOTH_LENGTH)]);
  }
  return teeth;
}

/** A direction arrow (shaft + head) in the lane `offset` right of centre, starting at arc length `tail`. */
function arrow(path: SampledCurve, offset: number, tail: number): Vec2[][] {
  const head = tail + ARROW_SHAFT_LENGTH;
  const tip = path.at(head + ARROW_HEAD_LENGTH);
  const base = path.at(head);
  const along = (f: typeof base, d: number): Vec2 => ({ x: f.p.x + f.normal.x * d, y: f.p.y + f.normal.y * d });
  return [
    ...ribbon(path, offset, ARROW_SHAFT_WIDTH, tail, head),
    [along(base, offset - ARROW_HEAD_WIDTH / 2), along(tip, offset), along(base, offset + ARROW_HEAD_WIDTH / 2)],
  ];
}
