import { effectiveControl, type JunctionControl } from "./junction";
import { connectionsAt, hasLaneConnector } from "./lanes";
import type { NodeId, RoadGraph, SegmentId } from "./roadGraph";

/** Cruise speed in world units per second; road lengths turn into driving time with it. */
export const CRUISE_SPEED = 40;

/** Typical seconds lost passing a junction, by how it's controlled. */
const JUNCTION_DELAY: Record<JunctionControl, number> = { none: 0.5, yield: 1, stop: 3, signals: 4 };

export interface Route {
  /** Nodes from source to sink. */
  nodes: NodeId[];
  /** Segments between consecutive nodes. */
  segments: SegmentId[];
}

/**
 * The fastest route from `from` to `to`: driving time along each road (every road has the same
 * speed for now) plus the typical delay at each junction passed. One-way roads only run a → b, and
 * at a junction a car may only turn onto roads its lane connections lead to. Null when `to` can't
 * be reached.
 */
export function findRoute(graph: RoadGraph, from: NodeId, to: NodeId): Route | null {
  // Searched by (node, road arrived on), as which turns are allowed depends on the road arrived on.
  type State = { node: NodeId; via: SegmentId | null };
  const key = (s: State) => `${s.node}:${s.via}`;
  const start: State = { node: from, via: null };
  const time = new Map<string, number>([[key(start), 0]]);
  const states = new Map<string, State>([[key(start), start]]);
  const back = new Map<string, string>();
  const done = new Set<string>();
  // Which roads each junction's lane connections lead to from each road in.
  const turns = new Map<NodeId, Set<string>>();
  const allowed = (node: NodeId, into: SegmentId, out: SegmentId) => {
    if (!hasLaneConnector(graph, node)) return true;
    let set = turns.get(node);
    if (!set) turns.set(node, (set = new Set(connectionsAt(graph, node).map((c) => `${c.from.segment}>${c.to.segment}`))));
    return set.has(`${into}>${out}`);
  };
  // shortcut: linear scan for the next state (O(n²)), fine for a few thousand nodes; use a heap beyond that.
  for (;;) {
    let currentKey: string | undefined;
    let best = Infinity;
    for (const [k, t] of time) {
      if (!done.has(k) && t < best) {
        best = t;
        currentKey = k;
      }
    }
    if (currentKey === undefined) return null;
    const current = states.get(currentKey)!;
    if (current.node === to) return unwind(currentKey);
    done.add(currentKey);

    const roads = graph.segmentsAt(current.node);
    // Passing through a junction costs its delay; a road's start and end don't.
    const delay = current.node !== from && roads.length >= 3 ? JUNCTION_DELAY[effectiveControl(graph.junction(current.node))] : 0;
    for (const segment of roads) {
      if (segment.spec.oneWay && segment.a !== current.node) continue;
      if (segment.id === current.via) continue;
      if (current.via !== null && !allowed(current.node, current.via, segment.id)) continue;
      const next: State = { node: segment.a === current.node ? segment.b : segment.a, via: segment.id };
      const k = key(next);
      if (done.has(k)) continue;
      const t = best + delay + graph.path(segment).length / CRUISE_SPEED;
      if (t < (time.get(k) ?? Infinity)) {
        time.set(k, t);
        states.set(k, next);
        back.set(k, currentKey);
      }
    }
  }

  function unwind(end: string): Route {
    const nodes: NodeId[] = [];
    const segments: SegmentId[] = [];
    for (let k: string | undefined = end; k !== undefined; k = back.get(k)) {
      const s = states.get(k)!;
      nodes.unshift(s.node);
      if (s.via !== null) segments.unshift(s.via);
    }
    return { nodes, segments };
  }
}
