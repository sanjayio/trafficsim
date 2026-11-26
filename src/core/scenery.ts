import type { NodeId, RoadGraph, RoadSegment } from "./roadGraph";
import { roadWidth } from "./roadSpec";

/**
 * Trees and bushes: static scenery saved with the map. Planted in clusters beside roads as
 * they're built; cleared from under new roads, junctions and buildings, and never grown back.
 */
export const PLANT_KINDS = ["broadleaf", "conifer", "poplar", "bush"] as const;
export type PlantKind = (typeof PLANT_KINDS)[number];

export interface Plant {
  x: number;
  y: number;
  kind: PlantKind;
  /** Scale (about 0.7–1.3), turn about upright (radians), and which of its kind's colours. */
  size: number;
  turn: number;
  colour: number;
}

/** Plants grow in a band beside each road: from this far past its footpath, out to this far. */
const BAND_START = 3;
const BAND_DEPTH = 60;
/** About one cluster every this far along each side of a road. */
const CLUSTER_SPACING = 40;
/** A cluster's plants stand within this of its middle; no two plants nearer than PLANT_GAP. */
const CLUSTER_RADIUS = 9;
const PLANT_GAP = 4;
/** Clear of a road's edge (and a building's lot) by this much. */
const CLEARANCE = 2;
/** Colours to pick from, per kind (see the leaf colours in render/buildings). */
const COLOURS = 10;
/** Grid cell for finding nearby plants. */
const CELL = 16;

/**
 * Looks after a map's scenery: plants beside each new road, clears plants from under new roads,
 * junctions and buildings, and plants an old map (saved before scenery) once when it's opened.
 */
export class SceneryKeeper {
  private unsubscribe: () => void;

  constructor(graph: RoadGraph) {
    this.unsubscribe = graph.subscribe((e) => {
      if (e.type === "reset") {
        if (!graph.sceneryUnplanted) return;
        // A map from before scenery: plant beside every road, then clear lots and junctions.
        const plants: Plant[] = [];
        for (const segment of graph.segments.values()) plants.push(...plantBeside(graph, segment, plants));
        graph.setScenery(clearAll(graph, plants));
      } else if (e.type === "segment-added") {
        const planted = [...graph.scenery, ...plantBeside(graph, e.segment, graph.scenery)];
        graph.setScenery(planted.filter((p) => !onRoad(graph, e.segment, p) && !nearJunction(graph, [e.segment.a, e.segment.b], p)));
      } else if (e.type === "terminal-changed" || e.type === "junction-changed") {
        const node = e.nodeId;
        const kept = graph.scenery.filter((p) => !onLot(graph, node, p) && !nearJunction(graph, [node], p));
        if (kept.length !== graph.scenery.length) graph.setScenery(kept);
      }
    });
  }

  dispose(): void {
    this.unsubscribe();
  }
}

/** `plants` clear of every road, junction and building lot. */
function clearAll(graph: RoadGraph, plants: Plant[]): Plant[] {
  const segments = [...graph.segments.values()];
  const nodes = [...graph.nodes.keys()];
  const lots = [...graph.allTerminals().keys()];
  return plants.filter(
    (p) => !segments.some((s) => onRoad(graph, s, p)) && !nearJunction(graph, nodes, p) && !lots.some((n) => onLot(graph, n, p)),
  );
}

/** Whether `p` stands on `segment` (its road and footpaths, with a little room). */
function onRoad(graph: RoadGraph, segment: RoadSegment, p: Plant): boolean {
  const reach = roadWidth(segment.spec) / 2 + CLEARANCE;
  const path = graph.drawnPath(segment);
  // Quick reject: outside the box round the curve's control points (the road never leaves it).
  const { a, c1, c2, b } = path.curve;
  const xs = [a.x, c1.x, c2.x, b.x];
  const ys = [a.y, c1.y, c2.y, b.y];
  if (p.x < Math.min(...xs) - reach || p.x > Math.max(...xs) + reach || p.y < Math.min(...ys) - reach || p.y > Math.max(...ys) + reach) return false;
  return path.nearest(p).distance < reach;
}

/** Whether `p` stands in a junction (or roundabout) at one of `nodes`. */
function nearJunction(graph: RoadGraph, nodes: NodeId[], p: Plant): boolean {
  return nodes.some((id) => {
    const node = graph.nodes.get(id);
    if (!node || graph.segmentsAt(id).length < 3) return false;
    const widest = Math.max(...graph.segmentsAt(id).map((s) => roadWidth(s.spec)));
    return Math.hypot(p.x - node.x, p.y - node.y) < graph.junctionRadius(id) + widest / 2 + CLEARANCE;
  });
}

/** Whether `p` stands on the lot of the building at `node`: from the road to the back of it, and a little round. */
function onLot(graph: RoadGraph, node: NodeId, p: Plant): boolean {
  const lot = graph.terminalLot(node);
  if (!lot) return false;
  const dx = p.x - lot.centre.x;
  const dy = p.y - lot.centre.y;
  const u = dx * lot.along.x + dy * lot.along.y;
  const w = dx * lot.out.x + dy * lot.out.y;
  const margin = CLEARANCE + 2;
  return Math.abs(u) < lot.length / 2 + margin && w > -(lot.front + lot.depth / 2) && w < lot.depth / 2 + margin;
}

/**
 * New plants in clusters each side of `segment` (none where `existing` already grow nearby, so
 * a road split in two isn't planted twice), clear of every road and building lot. The same for
 * the same road each time (seeded by its id).
 */
export function plantBeside(graph: RoadGraph, segment: RoadSegment, existing: readonly Plant[]): Plant[] {
  const random = seeded(segment.id * 7919 + 17);
  const path = graph.drawnPath(segment);
  const start = roadWidth(segment.spec) / 2 + BAND_START;
  const near = new Grid(existing);
  const segments = [...graph.segments.values()];
  const lots = [...graph.allTerminals().keys()];
  const blocked = (p: Plant) =>
    near.within(p, PLANT_GAP) || segments.some((s) => onRoad(graph, s, p)) || lots.some((n) => onLot(graph, n, p));
  const planted: Plant[] = [];
  for (const side of [1, -1]) {
    for (let along = CLUSTER_SPACING * random(); along < path.length; along += CLUSTER_SPACING * (0.6 + random() * 0.8)) {
      const f = path.at(along);
      const out = start + random() * BAND_DEPTH;
      const centre = { x: f.p.x + f.normal.x * side * out, y: f.p.y + f.normal.y * side * out };
      // Already wooded here (a road split in two keeps its first planting).
      if (near.within(centre, CLUSTER_RADIUS)) continue;
      const trees = 1 + Math.floor(random() * 3);
      const bushes = 1 + Math.floor(random() * 4);
      for (let k = 0; k < trees + bushes; k++) {
        const angle = random() * Math.PI * 2;
        const r = k === 0 ? 0 : CLUSTER_RADIUS * Math.sqrt(random());
        const tree = k < trees;
        const pick = random();
        const plant: Plant = {
          x: centre.x + Math.cos(angle) * r,
          y: centre.y + Math.sin(angle) * r,
          kind: tree ? (pick < 0.5 ? "broadleaf" : pick < 0.8 ? "conifer" : "poplar") : "bush",
          size: 0.7 + random() * 0.6,
          turn: random() * Math.PI,
          colour: Math.floor(random() * COLOURS),
        };
        if (blocked(plant)) continue;
        planted.push(plant);
        near.add(plant);
      }
    }
  }
  return planted;
}

/** Plants by grid cell, to find those near a point quickly. */
class Grid {
  private cells = new Map<string, Plant[]>();
  constructor(plants: readonly Plant[]) {
    for (const p of plants) this.add(p);
  }
  add(p: Plant): void {
    const key = `${Math.floor(p.x / CELL)}:${Math.floor(p.y / CELL)}`;
    const list = this.cells.get(key);
    if (list) list.push(p);
    else this.cells.set(key, [p]);
  }
  /** Whether any plant stands within `r` (at most CELL) of `p`. */
  within(p: { x: number; y: number }, r: number): boolean {
    const cx = Math.floor(p.x / CELL);
    const cy = Math.floor(p.y / CELL);
    for (let i = cx - 1; i <= cx + 1; i++) {
      for (let j = cy - 1; j <= cy + 1; j++) {
        if (this.cells.get(`${i}:${j}`)?.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < r)) return true;
      }
    }
    return false;
  }
}

/** Small seeded random generator (mulberry32), so a road's planting can be repeated. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Scenery as saved: a compact row per plant, [x, y, kind, size, turn, colour]. */
export function saveScenery(plants: Plant[]): number[][] {
  const round = (v: number, k: number) => Math.round(v * k) / k;
  return plants.map((p) => [round(p.x, 10), round(p.y, 10), PLANT_KINDS.indexOf(p.kind), round(p.size, 100), round(p.turn, 100), p.colour]);
}

/** Scenery read from a saved map; rows that don't make sense are dropped (a map always loads). */
export function parseScenery(raw: unknown): Plant[] {
  if (!Array.isArray(raw)) return [];
  const plants: Plant[] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length !== 6 || !row.every((v) => typeof v === "number" && Number.isFinite(v))) continue;
    const [x, y, kind, size, turn, colour] = row as number[];
    if (!PLANT_KINDS[kind] || size <= 0 || size > 3 || !Number.isInteger(colour) || colour < 0 || colour >= COLOURS) continue;
    plants.push({ x, y, kind: PLANT_KINDS[kind], size, turn, colour });
  }
  return plants;
}
