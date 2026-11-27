import type { Vec2 } from "../core/geometry";
import { connectionsAt, entersAt, leavesAt, type LaneConnection, type LaneRef } from "../core/lanes";
import type { NodeId } from "../core/roadGraph";
import { bridge, legAt, legLength, TrackBuilder } from "../core/track";
import { palette } from "../render/palette";
import type { Tool, ToolContext } from "./Tool";

/** How close (world units) a click must be to a lane end to pick it. */
const PICK_RADIUS = 6;
const LINK_WIDTH = 1.6;

/** Where a lane meets the junction: an incoming lane's stop line, or an outgoing lane's start. */
interface LaneEnd {
  ref: LaneRef;
  incoming: boolean;
  point: Vec2;
  /** Direction of travel there. */
  dir: Vec2;
}

const same = (a: LaneRef, b: LaneRef) => a.segment === b.segment && a.lane === b.lane;

/**
 * The lane connector for one junction (like Traffic Manager's): dots mark where incoming lanes
 * end (amber) and outgoing lanes start (green), with a line for each connection. Click an
 * incoming lane, then outgoing lanes, to connect or disconnect them; cars only drive the
 * connections. The first change copies the junction's default connections.
 */
export class LaneTool implements Tool {
  private selected: LaneRef | null = null;
  private hovered: LaneEnd | null = null;

  constructor(
    private ctx: ToolContext,
    private node: NodeId,
  ) {
    this.draw();
  }

  onDown(p: Vec2): void {
    const end = this.endAt(p);
    if (!end) this.selected = null;
    else if (end.incoming) this.selected = this.selected && same(this.selected, end.ref) ? null : end.ref;
    else if (this.selected) this.toggle({ from: this.selected, to: end.ref });
    this.draw();
  }

  onMove(p: Vec2): void {
    this.hovered = this.endAt(p);
    this.draw();
  }

  onUp(): void {}

  back(): void {
    this.selected = null;
    this.draw();
  }

  cancel(): void {
    this.selected = null;
    this.ctx.overlay.clear();
    this.ctx.setHint(null);
  }

  private toggle(link: LaneConnection): void {
    const current = connectionsAt(this.ctx.graph, this.node);
    const has = current.some((c) => same(c.from, link.from) && same(c.to, link.to));
    const connections = has ? current.filter((c) => !(same(c.from, link.from) && same(c.to, link.to))) : [...current, link];
    this.ctx.graph.setJunction(this.node, { connections });
  }

  /** Every incoming lane's end and outgoing lane's start at the junction, from the lanes cars drive. */
  private ends(): LaneEnd[] {
    const { graph } = this.ctx;
    const tracks = new TrackBuilder(graph, this.ctx.stopLineAt);
    const ends: LaneEnd[] = [];
    for (const segment of graph.segmentsAt(this.node)) {
      const other = segment.a === this.node ? segment.b : segment.a;
      for (let lane = 0; lane < segment.spec.lanes; lane++) {
        if (entersAt(segment, this.node)) {
          const leg = tracks.roadLeg(segment, other, lane);
          const f = legAt(leg, legLength(leg));
          ends.push({ ref: { segment: segment.id, lane }, incoming: true, point: f.p, dir: f.tangent });
        }
        if (leavesAt(segment, this.node)) {
          const f = legAt(tracks.roadLeg(segment, this.node, lane), 0);
          ends.push({ ref: { segment: segment.id, lane }, incoming: false, point: f.p, dir: f.tangent });
        }
      }
    }
    return ends;
  }

  private endAt(p: Vec2): LaneEnd | null {
    let best: LaneEnd | null = null;
    let bestDist = PICK_RADIUS;
    for (const end of this.ends()) {
      const d = Math.hypot(end.point.x - p.x, end.point.y - p.y);
      if (d <= bestDist) {
        best = end;
        bestDist = d;
      }
    }
    return best;
  }

  private draw(): void {
    const { overlay, graph } = this.ctx;
    overlay.clear();
    if (!graph.nodes.has(this.node)) return;
    // Up on a bridge's (or down in a tunnel's) junction.
    overlay.raise(graph.nodeHeight(this.node));
    const ends = this.ends();
    const find = (ref: LaneRef, incoming: boolean) => ends.find((e) => e.incoming === incoming && same(e.ref, ref));
    for (const c of connectionsAt(graph, this.node)) {
      const a = find(c.from, true);
      const b = find(c.to, false);
      if (!a || !b) continue;
      const picked = this.selected && same(this.selected, c.from);
      for (const piece of bridge(a.point, a.dir, b.point, b.dir)) {
        overlay.highlight(piece, LINK_WIDTH, picked ? palette.guide : palette.preview, picked ? 1 : 0.55);
      }
    }
    for (const end of ends) {
      const picked = end.incoming && this.selected && same(this.selected, end.ref);
      const hot = this.hovered && this.hovered.incoming === end.incoming && same(this.hovered.ref, end.ref);
      overlay.dot(end.point, picked || hot ? palette.guide : end.incoming ? palette.junction : palette.source);
    }
    const hint = this.hovered
      ? this.hovered.incoming
        ? "Pick this lane"
        : this.selected
          ? "Connect or disconnect"
          : "Pick an incoming (amber) lane first"
      : null;
    this.ctx.setHint(hint);
  }
}
