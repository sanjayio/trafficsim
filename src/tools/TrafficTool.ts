import { rightNormal } from "../core/curve";
import type { Vec2 } from "../core/geometry";
import type { NodeId, RoadNode } from "../core/roadGraph";
import { DEFAULT_SOURCE, SINK, type Terminal } from "../core/terminal";
import { palette } from "../render/palette";
import type { Tool, ToolContext } from "./Tool";

/** How close (world units) the cursor must be to a road end, or beside a road, to place there. */
const PICK_RADIUS = 16;
const ROAD_REACH = 24;

/** Where a click would place a source or sink: an existing node (a road end, or along a road), or a point to split a road at. */
type Spot = { node: RoadNode } | { point: Vec2 } | null;

/**
 * Places traffic sources (cars come out of a building there) and sinks (cars drive into one) on
 * road ends, or anywhere along a road: click on or beside the road, on the side the building
 * should stand. Clicking a building, or its spot, of the current kind removes it; of the other
 * kind, swaps it.
 */
export class TrafficTool implements Tool {
  constructor(private ctx: ToolContext) {}

  onDown(p: Vec2): void {
    const { graph } = this.ctx;
    const kind = this.ctx.trafficMode();
    const building = graph.terminalAt(p);
    const spot = building !== undefined ? { node: graph.node(building) } : this.spot(p);
    if (spot) {
      const node = "node" in spot ? spot.node : graph.nodeOnRoad(spot.point);
      if (node) {
        const existing = graph.terminal(node.id);
        const side = existing?.side ?? this.sideAt(node.id, p);
        const made: Terminal = kind === "source" ? { ...DEFAULT_SOURCE, side } : { ...SINK, side };
        graph.setTerminal(node.id, existing?.kind === kind ? null : made);
      }
    }
    this.onMove(p);
  }

  onMove(p: Vec2): void {
    const { graph, overlay } = this.ctx;
    overlay.clear();
    const kind = this.ctx.trafficMode();
    const building = graph.terminalAt(p);
    if (building !== undefined) {
      const existing = graph.terminal(building)!;
      return this.ctx.setHint(existing.kind === kind ? `Remove ${kind}` : `Make a ${kind}`);
    }
    const spot = this.spot(p);
    if (!spot) return this.ctx.setHint(graph.nodeNear(p, PICK_RADIUS) ? "Not at a junction" : null);
    if ("point" in spot && graph.nearJunction(spot.point)) return this.ctx.setHint("Too close to a junction");
    const at = "node" in spot ? spot.node : spot.point;
    overlay.dot(at, kind === "source" ? palette.source : palette.sink);
    const removing = "node" in spot && graph.terminal(spot.node.id)?.kind === kind;
    this.ctx.setHint(`${removing ? "Remove" : "Add"} ${kind}`);
  }

  onUp(): void {}

  cancel(): void {
    this.ctx.overlay.clear();
    this.ctx.setHint(null);
  }

  /** A road end or node along a road under the cursor, else the nearest point on a road beside it. */
  private spot(p: Vec2): Spot {
    const { graph } = this.ctx;
    const node = graph.nodeNear(p, PICK_RADIUS);
    if (node) return graph.segmentsAt(node.id).length <= 2 ? { node } : null;
    const segment = graph.segmentAt(p, ROAD_REACH);
    return segment ? { point: graph.path(segment).nearest(p).point } : null;
  }

  /** Which side of the road at `node` the point `p` is (1 right, -1 left), as sources and sinks measure it. */
  private sideAt(node: NodeId, p: Vec2): 1 | -1 {
    const { graph } = this.ctx;
    const right = rightNormal(graph.terminalDirection(node));
    const at = graph.node(node);
    return (p.x - at.x) * right.x + (p.y - at.y) * right.y >= 0 ? 1 : -1;
  }
}
