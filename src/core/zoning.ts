import { convexOverlap, pointInConvexPolygon, type Vec2 } from "./geometry";
import type { NodeId, RoadGraph, RoadSegment, SegmentId } from "./roadGraph";
import { roadWidth } from "./roadSpec";
import { MIN_ROAD_LENGTH } from "./constants";
import { BUILDING_TILES, newTerminal, TILE, ZONE_ROWS, type Building } from "./terminal";

/** How far a tile may reach over another road's edge (its front corners sit right on the edge where a road carries on). */
const EDGE_TOLERANCE = 0.5;

/**
 * One zoning tile beside a road (like Cities: Skylines'): in column `column` along the road (from
 * its `a` end, TILE long each) and row `row` back from it, on `side` (1 right of a → b, -1 left).
 */
export interface Tile {
  segment: SegmentId;
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
 * one into the next, the same way. `from` is the run's column where this piece's columns start.
 */
export interface RunPiece {
  segment: SegmentId;
  from: number;
  columns: number;
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
  /** The same tiles, by road piece. */
  private bySegment = new Map<SegmentId, Tile[]>();
  private unsubscribe: () => void;

  constructor(private graph: RoadGraph) {
    this.unsubscribe = graph.subscribe(() => (this.tiles = null));
  }

  dispose(): void {
    this.unsubscribe();
  }

  all(): Tile[] {
    if (!this.tiles) {
      this.tiles = this.build();
      this.bySegment.clear();
      for (const t of this.tiles) {
        const list = this.bySegment.get(t.segment);
        if (list) list.push(t);
        else this.bySegment.set(t.segment, [t]);
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
    const run = this.run(under.segment);
    const at = run.find((piece) => piece.segment === under.segment)!.from + under.column;
    // Centred on the column under the cursor (for an even width, the cursor's half picks the side).
    const half = (p: Vec2) => {
      const [a, b] = under.corners;
      const t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / ((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
      return t < 0.5 ? 0 : 1;
    };
    const centred = width % 2 === 0 ? at - width / 2 + half(p) : at - (width - 1) / 2;
    // Kept on the run, nudged along if need be.
    const total = run.reduce((sum, piece) => sum + piece.columns, 0);
    const first = Math.max(0, Math.min(centred, total - width));
    const index = new Map<string, Tile>();
    for (const piece of run) {
      for (const t of this.bySegment.get(piece.segment) ?? []) {
        if (t.side === under.side) index.set(`${piece.from + t.column}:${t.row}`, t);
      }
    }
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
   * Puts `building` on `block`: its driveway meets the road at a tile boundary within the block
   * (nearest its middle, clear of the run's ends; an existing split there is used as it is, else
   * the road is split there), and it stands centred on the block. False if the block doesn't fit,
   * or has no such boundary.
   */
  place(block: Block, building: Building): boolean {
    const { graph } = this;
    if (!block.fits) return false;
    const total = block.run.reduce((sum, piece) => sum + piece.columns, 0);
    const middle = block.column + block.width / 2;
    const boundaries = Array.from({ length: block.width + 1 }, (_, i) => block.column + i)
      .filter((k) => k * TILE >= MIN_ROAD_LENGTH && (total - k) * TILE >= MIN_ROAD_LENGTH)
      .sort((p, q) => Math.abs(p - middle) - Math.abs(q - middle));
    for (const k of boundaries) {
      const piece = block.run.find((pc) => k >= pc.from && k <= pc.from + pc.columns)!;
      const segment = graph.segments.get(piece.segment)!;
      const node = graph.nodeOnRoad(graph.path(segment).at((k - piece.from) * TILE).p);
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
   * pieces meet, each carrying on the same way (as a road split for driveways does), with each
   * piece's first column counted along the whole run.
   */
  run(segmentId: SegmentId): RunPiece[] {
    const { graph } = this;
    const start = graph.segments.get(segmentId)!;
    const pieces = [start];
    const step = (from: RoadSegment, forward: boolean): RoadSegment | undefined => {
      const node = forward ? from.b : from.a;
      const roads = graph.segmentsAt(node);
      if (roads.length !== 2) return undefined;
      const next = roads.find((r) => r !== from && (forward ? r.a === node : r.b === node));
      return next && !pieces.includes(next) ? next : undefined;
    };
    for (let s = step(start, false); s; s = step(s, false)) pieces.unshift(s);
    for (let s = step(start, true); s; s = step(s, true)) pieces.push(s);
    let from = 0;
    return pieces.map((segment) => {
      const columns = Math.floor(graph.path(segment).length / TILE + 1e-6);
      const piece = { segment: segment.id, from, columns };
      from += columns;
      return piece;
    });
  }

  private build(): Tile[] {
    const { graph } = this;
    const segments = [...graph.segments.values()];
    const lots = [...graph.allTerminals().keys()].map((id) => graph.lotCorners(id)).filter((lot) => lot.length);
    const junctions = [...graph.nodes.values()].filter((n) => graph.segmentsAt(n.id).length >= 3);

    // Every tile that could be zoned beside its own road.
    const candidates: Tile[] = [];
    for (const segment of segments) {
      // No buildings along a bridge or tunnel. (Tiles beside other roads still keep clear of them:
      // shortcut: ground over a covered tunnel can't be zoned; allow it if tunnels under towns matter.)
      if (segment.spec.level) continue;
      const path = graph.path(segment);
      const edge = roadWidth(segment.spec) / 2;
      // A road split at a tile boundary can come out a hair short of it.
      const columns = Math.floor(path.length / TILE + 1e-6);
      for (const side of [1, -1] as const) {
        for (let column = 0; column < columns; column++) {
          const f0 = path.at(column * TILE);
          const f1 = path.at((column + 1) * TILE);
          const at = (f: typeof f0, d: number) => ({ x: f.p.x + f.normal.x * side * d, y: f.p.y + f.normal.y * side * d });
          for (let row = 0; row < ZONE_ROWS; row++) {
            const near = edge + row * TILE;
            const corners = [at(f0, near), at(f1, near), at(f1, near + TILE), at(f0, near + TILE)];
            const centre = {
              x: corners.reduce((sum, c) => sum + c.x, 0) / 4,
              y: corners.reduce((sum, c) => sum + c.y, 0) / 4,
            };
            if (this.zonable(segment, centre, corners, segments, junctions)) {
              candidates.push({ segment: segment.id, side, column, row, corners, centre, free: true });
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
            if (other.segment === tile.segment || !convexOverlap(tile.corners, other.corners)) continue;
            const loser = tile.row !== other.row ? (tile.row > other.row ? tile : other) : tile.segment > other.segment ? tile : other;
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
      const key = `${tile.segment}:${tile.side}:${tile.column}`;
      const next = reach.get(key) ?? 0;
      if (tile.row !== next || removed.has(tile)) {
        reach.set(key, Infinity);
        continue;
      }
      reach.set(key, next + 1);
      // Taken where any of it is under a building.
      tile.free = !lots.some((lot) => convexOverlap(tile.corners, lot));
      tiles.push(tile);
    }
    return tiles;
  }

  private zonable(own: RoadSegment, centre: Vec2, corners: Vec2[], segments: RoadSegment[], junctions: { id: NodeId; x: number; y: number }[]): boolean {
    const { graph } = this;
    const mine = graph.path(own).distanceTo(centre);
    for (const other of segments) {
      if (other === own) continue;
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

function centroid(points: Vec2[]): Vec2 {
  return { x: points.reduce((sum, p) => sum + p.x, 0) / points.length, y: points.reduce((sum, p) => sum + p.y, 0) / points.length };
}
