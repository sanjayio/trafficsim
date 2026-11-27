import { convexOverlap, pointInConvexPolygon, type Vec2 } from "./geometry";
import type { NodeId, RoadGraph, RoadSegment, SegmentId } from "./roadGraph";
import { offGround, roadWidth } from "./roadSpec";
import { MIN_ROAD_LENGTH } from "./constants";
import { BUILDING_TILES, newTerminal, TILE, ZONE_ROWS, type Building } from "./terminal";

/** How far a tile may reach over another road's edge (its front corners sit right on the edge where a road carries on). */
const EDGE_TOLERANCE = 0.5;
/** Pieces of road meeting at less than this angle (cos of about 10°) carry one tile grid on, as one road. */
const SMOOTH = Math.cos((10 * Math.PI) / 180);

/**
 * One zoning tile beside a road (like Cities: Skylines'): in column `column` along its run of road
 * (see `RunPiece`, TILE long each) and row `row` back from it, on `side` (1 right of a → b, -1 left).
 */
export interface Tile {
  /** The road piece the tile starts beside, and the first piece of its run. */
  segment: SegmentId;
  run: SegmentId;
  side: 1 | -1;
  column: number;
  row: number;
  /** Corners, going round: road edge at the column's start, at its end, then the back. */
  corners: Vec2[];
  centre: Vec2;
  /** False under a building already. */
  free: boolean;
}

/**
 * One piece of a run of road: a road split (at buildings' driveways) into pieces that carry on
 * smoothly one into the next, the same way. The tiles run on along the whole run, so a road can be
 * split anywhere without moving them. `start` is how far along the run this piece starts.
 */
export interface RunPiece {
  segment: SegmentId;
  start: number;
  length: number;
}

/** A block of tiles a building would stand on, and whether it can. */
export interface Block {
  side: 1 | -1;
  /** The run of road pieces it's along (see `ZoneMap.run`), its columns counted along the whole run. */
  run: RunPiece[];
  /** First column (along the run), and how many along and deep. */
  column: number;
  width: number;
  depth: number;
  tiles: Tile[];
  fits: boolean;
}

/**
 * The zoning tiles beside every road, worked out again whenever the network changes. A tile is
 * left out where it would overlap a road, lie nearer another road (so the space between two roads
 * is shared out rather than zoned twice), or crowd a junction; and only exists if the tile
 * between it and its road does.
 */
export class ZoneMap {
  private tiles: Tile[] | null = null;
  /** The same tiles, by run (its first piece); and each road piece's run. */
  private byRun = new Map<SegmentId, Tile[]>();
  private runs = new Map<SegmentId, RunPiece[]>();
  private unsubscribe: () => void;

  /** Buildings changed since the tiles' `free` was worked out (the tiles themselves follow the roads only). */
  private buildingsChanged = false;

  constructor(private graph: RoadGraph) {
    this.unsubscribe = graph.subscribe((e) => {
      if (e.type === "terminal-changed") this.buildingsChanged = true;
      else if (e.type !== "rules" && e.type !== "scenery") this.tiles = null;
    });
  }

  dispose(): void {
    this.unsubscribe();
  }

  all(): Tile[] {
    if (this.tiles && this.buildingsChanged) this.markTaken(this.tiles);
    if (!this.tiles) {
      this.runs.clear();
      for (const segment of this.graph.segments.values()) {
        if (this.runs.has(segment.id) || offGround(segment.spec)) continue;
        const run = this.run(segment.id);
        for (const piece of run) this.runs.set(piece.segment, run);
      }
      this.tiles = this.build();
      this.byRun.clear();
      for (const t of this.tiles) {
        const list = this.byRun.get(t.run);
        if (list) list.push(t);
        else this.byRun.set(t.run, [t]);
      }
    }
    return this.tiles;
  }

  /**
   * The block `building` would take with the tile under `p` among its front columns, or null off
   * the tiles. It can run on past where the road is split (as at another building's driveway).
   */
  blockAt(p: Vec2, building: Building): Block | null {
    const under = this.all().find((t) => pointInConvexPolygon(p, t.corners));
    if (!under) return null;
    const [width, depth] = BUILDING_TILES[building];
    const run = this.runs.get(under.segment)!;
    const at = under.column;
    // Centred on the column under the cursor (for an even width, the cursor's half picks the side).
    const half = (p: Vec2) => {
      const [a, b] = under.corners;
      const t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / ((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
      return t < 0.5 ? 0 : 1;
    };
    const centred = width % 2 === 0 ? at - width / 2 + half(p) : at - (width - 1) / 2;
    // Kept on the run, nudged along if need be.
    const first = Math.max(0, Math.min(centred, columnsOf(run) - width));
    const index = new Map<string, Tile>();
    for (const t of this.byRun.get(under.run) ?? []) if (t.side === under.side) index.set(`${t.column}:${t.row}`, t);
    const tiles: Tile[] = [];
    let fits = true;
    for (let c = first; c < first + width; c++) {
      for (let r = 0; r < depth; r++) {
        const tile = index.get(`${c}:${r}`);
        if (tile) tiles.push(tile);
        if (!tile?.free) fits = false;
      }
    }
    return { side: under.side, run, column: first, width, depth, tiles, fits };
  }

  /**
   * Puts `building` on `block`: its driveway meets the road at the block's middle, or (where the
   * building opposite already has its driveway there) just beside it, still in front of the garage;
   * failing those, at a tile boundary within the block nearest its middle. Clear of the run's ends;
   * an existing split there is used as it is, else the road is split there. It stands centred on
   * the block. False if the block doesn't fit, or has no such point.
   */
  place(block: Block, building: Building): boolean {
    const { graph } = this;
    if (!block.fits) return false;
    const last = block.run[block.run.length - 1];
    const total = last.start + last.length;
    const middle = block.column + block.width / 2;
    // Just far enough from a driveway at the middle for the road to be split again.
    const beside = (MIN_ROAD_LENGTH + 1) / TILE;
    const boundaries = Array.from({ length: block.width + 1 }, (_, i) => block.column + i).sort((p, q) => Math.abs(p - middle) - Math.abs(q - middle));
    const spots = [middle, middle - beside, middle + beside, ...boundaries].filter((k) => k * TILE >= MIN_ROAD_LENGTH && total - k * TILE >= MIN_ROAD_LENGTH);
    for (const k of spots) {
      const piece = pieceAt(block.run, k * TILE);
      const segment = graph.segments.get(piece.segment)!;
      const node = graph.nodeOnRoad(graph.path(segment).at(k * TILE - piece.start).p);
      if (!node || graph.terminal(node.id)) continue;
      // Side and offset are measured along the road leaving that node, which runs the run's way.
      // The offset is to the middle of the block's front where it really is (pieces of a road
      // drawn in joined lengths needn't be whole tiles long).
      const front = block.tiles.filter((t) => t.row === 0).flatMap((t) => [t.corners[0], t.corners[1]]);
      const along = graph.terminalDirection(node.id);
      const offset = (centroid(front).x - node.x) * along.x + (centroid(front).y - node.y) * along.y;
      graph.setTerminal(node.id, newTerminal(building, block.side, offset));
      if (this.standsClear(node.id)) return true;
      graph.setTerminal(node.id, null);
      return false;
    }
    return false;
  }

  /**
   * Whether the building at `nodeId` stands clear of every other building and every road. On a
   * curve, or swapped for a bigger one, a (straight) building can stray beyond its tiles.
   */
  standsClear(nodeId: NodeId): boolean {
    const { graph } = this;
    const lot = graph.lotCorners(nodeId);
    const onRoad = [...graph.segments.values()].some((r) =>
      [...lot, centroid(lot)].some((p) => graph.path(r).distanceTo(p) < roadWidth(r.spec) / 2 - EDGE_TOLERANCE),
    );
    return !onRoad && ![...graph.allTerminals().keys()].some((id) => id !== nodeId && convexOverlap(lot, graph.lotCorners(id)));
  }

  /**
   * The run of road pieces `segmentId` is part of: back and on through nodes where just two
   * pieces meet, each carrying on smoothly the same way (as a road split for driveways does),
   * with how far along the whole run each piece starts. Not onto bridges or tunnels.
   */
  private run(segmentId: SegmentId): RunPiece[] {
    const { graph } = this;
    const start = graph.segments.get(segmentId)!;
    const pieces = [start];
    const step = (from: RoadSegment, forward: boolean): RoadSegment | undefined => {
      const node = forward ? from.b : from.a;
      const roads = graph.segmentsAt(node);
      if (roads.length !== 2) return undefined;
      const next = roads.find((r) => r !== from && (forward ? r.a === node : r.b === node));
      if (!next || offGround(next.spec) || pieces.includes(next)) return undefined;
      const back = graph.directionAway(from, node);
      const on = graph.directionAway(next, node);
      return -(back.x * on.x + back.y * on.y) >= SMOOTH ? next : undefined;
    };
    for (let s = step(start, false); s; s = step(s, false)) pieces.unshift(s);
    for (let s = step(start, true); s; s = step(s, true)) pieces.push(s);
    let along = 0;
    return pieces.map((segment) => {
      const piece = { segment: segment.id, start: along, length: graph.path(segment).length };
      along += piece.length;
      return piece;
    });
  }

  private build(): Tile[] {
    const { graph } = this;
    const segments = [...graph.segments.values()];
    const junctions = [...graph.nodes.values()].filter((n) => graph.segmentsAt(n.id).length >= 3);

    // Every tile that could be zoned beside its own road.
    const candidates: Tile[] = [];
    // No buildings along a bridge or tunnel (they have no run). (Tiles beside other roads still keep clear of them:
    // shortcut: ground over a covered tunnel can't be zoned; allow it if tunnels under towns matter.)
    for (const run of new Set(this.runs.values())) {
      const own = run.map((piece) => graph.segments.get(piece.segment)!);
      // Pieces split from one road share its width.
      const edge = roadWidth(own[0].spec) / 2;
      const frame = (s: number) => {
        const piece = pieceAt(run, s);
        return { piece, f: graph.path(graph.segments.get(piece.segment)!).at(s - piece.start) };
      };
      const columns = columnsOf(run);
      for (const side of [1, -1] as const) {
        for (let column = 0; column < columns; column++) {
          const { piece, f: f0 } = frame(column * TILE);
          const { piece: end, f: f1 } = frame((column + 1) * TILE);
          // The pieces it's beside (two where it spans a split).
          const beside = [...new Set([piece, end])].map((p) => graph.segments.get(p.segment)!);
          const at = (f: typeof f0, d: number) => ({ x: f.p.x + f.normal.x * side * d, y: f.p.y + f.normal.y * side * d });
          for (let row = 0; row < ZONE_ROWS; row++) {
            const near = edge + row * TILE;
            const corners = [at(f0, near), at(f1, near), at(f1, near + TILE), at(f0, near + TILE)];
            const centre = {
              x: corners.reduce((sum, c) => sum + c.x, 0) / 4,
              y: corners.reduce((sum, c) => sum + c.y, 0) / 4,
            };
            if (this.zonable(own, beside, centre, corners, segments, junctions)) {
              candidates.push({ segment: piece.segment, run: run[0].segment, side, column, row, corners, centre, free: true });
            }
          }
        }
      }
    }

    // Tiles of different roads that overlap (where roads meet at an angle): the one further back
    // from its road gives way, then the later road's. Only tiles sharing a coarse grid cell are compared.
    const removed = new Set<Tile>();
    const cells = new Map<string, Tile[]>();
    const CELL = TILE * 2;
    for (const tile of candidates) {
      const xs = tile.corners.map((c) => c.x);
      const ys = tile.corners.map((c) => c.y);
      for (let cx = Math.floor(Math.min(...xs) / CELL); cx <= Math.floor(Math.max(...xs) / CELL); cx++) {
        for (let cy = Math.floor(Math.min(...ys) / CELL); cy <= Math.floor(Math.max(...ys) / CELL); cy++) {
          const key = `${cx}:${cy}`;
          for (const other of cells.get(key) ?? []) {
            if (other.run === tile.run || !convexOverlap(tile.corners, other.corners)) continue;
            const loser = tile.row !== other.row ? (tile.row > other.row ? tile : other) : tile.run > other.run ? tile : other;
            removed.add(loser);
          }
          cells.set(key, [...(cells.get(key) ?? []), tile]);
        }
      }
    }

    // Rows grow out from the road: each column keeps its rows up to the first one missing.
    const tiles: Tile[] = [];
    const reach = new Map<string, number>();
    for (const tile of candidates) {
      const key = `${tile.run}:${tile.side}:${tile.column}`;
      const next = reach.get(key) ?? 0;
      if (tile.row !== next || removed.has(tile)) {
        reach.set(key, Infinity);
        continue;
      }
      reach.set(key, next + 1);
      tiles.push(tile);
    }
    this.markTaken(tiles);
    return tiles;
  }

  /** Marks the tiles under a building taken (`free` false), the rest free: checking only buildings whose box reaches a tile. */
  private markTaken(tiles: Tile[]): void {
    const { graph } = this;
    const lots = [...graph.allTerminals().keys()].map((id) => graph.lotCorners(id)).filter((lot) => lot.length).map((corners) => ({ corners, box: boxOf(corners) }));
    for (const tile of tiles) {
      const box = boxOf(tile.corners);
      tile.free = !lots.some((lot) => lot.box.minX <= box.maxX && box.minX <= lot.box.maxX && lot.box.minY <= box.maxY && box.minY <= lot.box.maxY && convexOverlap(tile.corners, lot.corners));
    }
    this.buildingsChanged = false;
  }

  /** Whether a tile beside `beside` (pieces of the run `own`) may be zoned. */
  private zonable(own: RoadSegment[], beside: RoadSegment[], centre: Vec2, corners: Vec2[], segments: RoadSegment[], junctions: { id: NodeId; x: number; y: number }[]): boolean {
    const { graph } = this;
    const mine = Math.min(...beside.map((s) => graph.path(s).distanceTo(centre)));
    for (const other of segments) {
      if (own.includes(other)) continue;
      const path = graph.path(other);
      const reach = roadWidth(other.spec) / 2 + TILE * ZONE_ROWS;
      const b = path.bounds;
      if (centre.x < b.minX - reach || centre.x > b.maxX + reach || centre.y < b.minY - reach || centre.y > b.maxY + reach) continue;
      // Over another road (front corners touching its edge, as where a road carries on, don't count), or closer to it than to this one.
      if ([centre, ...corners].some((p) => path.distanceTo(p) < roadWidth(other.spec) / 2 - EDGE_TOLERANCE)) return false;
      if (path.distanceTo(centre) < mine) return false;
    }
    for (const node of junctions) {
      const clear = graph.junctionRadius(node.id) + TILE;
      if (Math.hypot(centre.x - node.x, centre.y - node.y) < clear) return false;
    }
    return true;
  }
}

/** Whole tiles along `run` (a road split at a tile boundary can come out a hair short of it). */
function columnsOf(run: RunPiece[]): number {
  const last = run[run.length - 1];
  return Math.floor((last.start + last.length) / TILE + 1e-6);
}

/** The piece of `run` that `s` along it falls on. */
function pieceAt(run: RunPiece[], s: number): RunPiece {
  return run.find((piece) => s < piece.start + piece.length) ?? run[run.length - 1];
}

function boxOf(points: Vec2[]): { minX: number; maxX: number; minY: number; maxY: number } {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

function centroid(points: Vec2[]): Vec2 {
  return { x: points.reduce((sum, p) => sum + p.x, 0) / points.length, y: points.reduce((sum, p) => sum + p.y, 0) / points.length };
}
