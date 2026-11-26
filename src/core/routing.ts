import { effectiveControl, slipRoad, type JunctionControl } from "./junction";
import { connectionsAt, hasLaneConnector, turnAt } from "./lanes";
import { speedOf } from "./roadSpec";
import type { NodeId, RoadGraph, SegmentId } from "./roadGraph";

/** Cruise speed in world units per second (50 km/h, see `speedOf`): roads' driving time when speed limits are ignored. */
export const CRUISE_SPEED = 40;


export interface Route {
  /** Nodes from source to sink. */
  nodes: NodeId[];
  /** Segments between consecutive nodes. */
  segments: SegmentId[];
}

/**
 * The fastest route from `from` to `to`: driving time along each road at its speed limit, plus
 * the typical delay at each junction passed and a cost for each turn (see `TrafficRules.routing`). One-way roads only run a → b, and
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
    // Where a slip road leaves or joins: only on, off or straight through, never a hairpin back.
    if (slipRoad(graph, node)) {
      const a = graph.directionAway(graph.segments.get(into)!, node);
      const b = graph.directionAway(graph.segments.get(out)!, node);
      return a.x * b.x + a.y * b.y < 0;
    }
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
    const junction = current.node !== from && roads.length >= 3 && !slipRoad(graph, current.node);
    const delay = junction ? junctionDelay(graph, current.node) : 0;
    const rules = graph.rules.routing;
    for (const segment of roads) {
      if (segment.spec.oneWay && segment.a !== current.node) continue;
      if (segment.id === current.via) continue;
      if (current.via !== null && !allowed(current.node, current.via, segment.id)) continue;
      const next: State = { node: segment.a === current.node ? segment.b : segment.a, via: segment.id };
      const k = key(next);
      if (done.has(k)) continue;
      const turn = junction && current.via !== null ? turnAt(graph, current.node, graph.segments.get(current.via)!, segment) : "straight";
      const penalty = turn === "kerb" ? rules.turnKerb : turn === "across" ? rules.turnAcross : 0;
      const speed = rules.speedLimits ? speedOf(segment.spec) : CRUISE_SPEED;
      const t = best + delay + penalty + graph.path(segment).length / speed;
      if (t < (time.get(k) ?? Infinity)) {
        time.set(k, t);
        states.set(k, next);
        back.set(k, currentKey);
      }
    }
  }

  function junctionDelay(graph: RoadGraph, node: NodeId): number {
    // Typical seconds lost passing a junction, by how it's controlled (see `TrafficRules.routing`).
    const control: JunctionControl = effectiveControl(graph.junction(node));
    const { delayNone, delayYield, delayStop, delaySignals } = graph.rules.routing;
    return { none: delayNone, yield: delayYield, stop: delayStop, signals: delaySignals }[control];
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
