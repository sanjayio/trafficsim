import type { DrivingSide, NodeId, RoadGraph, RoadSegment, SegmentId } from "./roadGraph";
import { carriagewayWidth, hasMedian, LANE_WIDTH, MEDIAN_WIDTH, type RoadSpec } from "./roadSpec";

/** Which way a movement turns: towards the kerb, straight on, or across oncoming traffic. */
export type Turn = "kerb" | "straight" | "across";

/**
 * A lane of a road at a junction, by its index into `laneOffsets` for the direction of travel
 * (towards the junction for an incoming lane, away from it for an outgoing one).
 */
export interface LaneRef {
  segment: SegmentId;
  lane: number;
}

/** An incoming lane at a junction joined to an outgoing lane: cars may drive from one to the other. */
export interface LaneConnection {
  from: LaneRef;
  to: LaneRef;
}

/** Lane centre offsets, right of the direction of travel, for a car driving along `spec`. */
export function laneOffsets(spec: RoadSpec, side: DrivingSide): number[] {
  const keep = side === "right" ? 1 : -1;
  if (spec.oneWay) {
    const left = -carriagewayWidth(spec) / 2;
    return Array.from({ length: spec.lanes }, (_, k) => left + (k + 0.5) * LANE_WIDTH);
  }
  const middle = hasMedian(spec) ? MEDIAN_WIDTH / 2 : 0;
  return Array.from({ length: spec.lanes }, (_, k) => keep * (middle + (k + 0.5) * LANE_WIDTH));
}

/** Lanes ordered from the inner one (by oncoming traffic, or the left of a one-way road under right-hand traffic) to the kerb. */
export function lanesInnerToKerb(spec: RoadSpec, side: DrivingSide): number[] {
  const keep = side === "right" ? 1 : -1;
  const offsets = laneOffsets(spec, side);
  return offsets.map((_, k) => k).sort((p, q) => keep * offsets[p] - keep * offsets[q]);
}

/** Lane position `rank` (from the inner lane) among `from` lanes, as the matching position among `to`. */
export function scaleRank(rank: number, from: number, to: number): number {
  return Math.round((rank * (to - 1)) / Math.max(1, from - 1));
}

/** How the turn from `into` (arriving at `node`) to `out` (leaving it) goes. */
export function turnAt(graph: RoadGraph, node: NodeId, into: RoadSegment, out: RoadSegment): Turn {
  const arriving = graph.directionAway(into, node);
  const leaving = graph.directionAway(out, node);
  const travel = { x: -arriving.x, y: -arriving.y };
  const cross = travel.x * leaving.y - travel.y * leaving.x;
  const dot = travel.x * leaving.x + travel.y * leaving.y;
  if (dot > Math.cos((35 * Math.PI) / 180)) return "straight";
  // World y points down the screen, so a positive cross product turns right.
  const right = cross > 0;
  return right === (graph.drivingSide === "right") ? "kerb" : "across";
}

/** Whether traffic on `segment` can drive into, or out of, `node`. */
export function entersAt(segment: RoadSegment, node: NodeId): boolean {
  return !segment.spec.oneWay || segment.b === node;
}
export function leavesAt(segment: RoadSegment, node: NodeId): boolean {
  return !segment.spec.oneWay || segment.a === node;
}

/**
 * The connections a junction starts with: the kerb lane turns towards the kerb and the inner lane
 * across traffic (into the matching lane of the road turned into); every lane goes straight on,
 * keeping its position; a single lane goes every way.
 */
export function defaultConnections(graph: RoadGraph, node: NodeId): LaneConnection[] {
  const side = graph.drivingSide;
  const roads = graph.segmentsAt(node);
  const connections: LaneConnection[] = [];
  for (const into of roads) {
    if (!entersAt(into, node)) continue;
    const ins = lanesInnerToKerb(into.spec, side);
    for (const out of roads) {
      if (out.id === into.id || !leavesAt(out, node)) continue;
      const outs = lanesInnerToKerb(out.spec, side);
      const turn = turnAt(graph, node, into, out);
      ins.forEach((lane, rank) => {
        const single = ins.length === 1;
        let to: number | null = null;
        if (turn === "straight") to = outs[scaleRank(rank, ins.length, outs.length)];
        else if (turn === "kerb" && (single || rank === ins.length - 1)) to = outs[outs.length - 1];
        else if (turn === "across" && (single || rank === 0)) to = outs[0];
        if (to !== null) connections.push({ from: { segment: into.id, lane }, to: { segment: out.id, lane: to } });
      });
    }
  }
  return connections;
}

/** A junction's lane connections: the ones set with the lane connector, or the defaults. */
export function connectionsAt(graph: RoadGraph, node: NodeId): LaneConnection[] {
  return graph.junction(node).connections ?? defaultConnections(graph, node);
}

/** Whether a lane connector applies at `node`: a plain junction (roundabouts keep their ring rules). */
export function hasLaneConnector(graph: RoadGraph, node: NodeId): boolean {
  return graph.segmentsAt(node).length >= 3 && !graph.junction(node).roundabout;
}
