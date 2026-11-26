import type { LaneCriterion } from "./rules";

/** What the lane planner needs to know about the roads of a route, numbered from its start. */
export interface LaneFacts {
  roads: number;
  /** Lanes of road `i` a car may leave it in: those leading on to road `i + 1` (on the last road, to the destination). */
  valid(i: number): number[];
  /** Lanes of road `i + 1` that leaving road `i` in `lane` can come out in. */
  next(i: number, lane: number): number[];
  /** Lane changes needed on road `i` to move from lane `a` to lane `b`. */
  changes(i: number, a: number, b: number): number;
  /** How held up lane `lane` of road `i` is ahead of the car (0 where it can't see). */
  congestion(i: number, lane: number): number;
}

export interface LanePlan {
  /** Per road, the lane the car drives in from its start, and the one it leaves in. */
  entry: number[];
  exit: number[];
  /** Per road, whether the lane it's entered in can't go where the route goes, so changing lane is a must. */
  forced: boolean[];
}

/**
 * Lanes for each road of a route from road `from` on, entering it in lane `entry`. On each road,
 * of the lanes that can go where the route goes next, the car takes the one that scores best by
 * `order`, compared strictly in turn (the first criterion decides, the rest break ties):
 * `fewestChanges`, the fewest lane changes over the next `lookahead` roads; `keepLane`, staying in
 * the lane it's in; `leastCongested`, the fewest held-up cars ahead.
 */
export function planLanes(facts: LaneFacts, from: number, entry: number, rules: { lookahead: number; order: LaneCriterion[] }): LanePlan {
  const memo = new Map<string, number>();
  // Fewest lane changes driving roads i.. (up to `depth` of them), entering road i in lane `e`.
  const cost = (i: number, e: number, depth: number): number => {
    if (depth === 0 || i >= facts.roads) return 0;
    const key = `${i}:${e}:${depth}`;
    let best = memo.get(key);
    if (best === undefined) {
      best = Infinity;
      for (const x of facts.valid(i)) best = Math.min(best, facts.changes(i, e, x) + after(i, x, depth - 1));
      memo.set(key, best);
    }
    return best;
  };
  // Fewest lane changes on the roads after road i, leaving it in lane x.
  const after = (i: number, x: number, depth: number): number => {
    if (depth === 0 || i + 1 >= facts.roads) return 0;
    return Math.min(...facts.next(i, x).map((e) => cost(i + 1, e, depth)));
  };

  const plan: LanePlan = { entry: [], exit: [], forced: [] };
  let e = entry;
  for (let i = from; i < facts.roads; i++) {
    plan.entry[i] = e;
    plan.forced[i] = !facts.valid(i).includes(e);
    const score = (x: number) =>
      rules.order.map((criterion) =>
        criterion === "fewestChanges"
          ? facts.changes(i, e, x) + after(i, x, rules.lookahead - 1)
          : criterion === "keepLane"
            ? Number(x !== e)
            : facts.congestion(i, x),
      );
    const x = pickBest(facts.valid(i), score);
    plan.exit[i] = x;
    if (i + 1 < facts.roads) e = pickBest(facts.next(i, x), (n) => [cost(i + 1, n, rules.lookahead - 1)]);
  }
  return plan;
}

/** The option with the lowest score, comparing scores element by element; the first such on a tie. */
function pickBest(options: number[], score: (option: number) => number[]): number {
  let best = options[0];
  let bestScore = score(best);
  for (const option of options.slice(1)) {
    const s = score(option);
    const i = s.findIndex((v, k) => v !== bestScore[k]);
    if (i >= 0 && s[i] < bestScore[i]) {
      best = option;
      bestScore = s;
    }
  }
  return best;
}
