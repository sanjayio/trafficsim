import {
  AdditiveBlending,
  BoxGeometry,
  type BufferGeometry,
  CanvasTexture,
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from "three";
import type { RoadGraph } from "../core/roadGraph";
import { carriagewayWidth, FOOTPATH_WIDTH, hasTrees, levelsOf, roadWidth } from "../core/roadSpec";
import { LEAVES, swayMaterial, treeGeometries, TRUNK } from "./buildings";
import { KERB_HEIGHT } from "./flat";
import { carPark, DRIVEWAY_WIDTH, isSourceBuilding, lotPoint, SIDE_PATH } from "../core/terminal";

/** Distance between lights along a road (they alternate sides), and clearance from a road's ends. */
const SPACING = 55;
const END_CLEAR = 14;
/** Pole height, how far the arm reaches out over the road, and the light pool's size on the ground. */
const POLE = { height: 16, width: 0.7 };
const ARM = 4;
/** How thick poles and arms are in the shadows they cast: thicker than they are, or the shadow map (a unit or so a pixel) blurs their shadows away. */
const SHADOW_WIDTH = 1.8;
const POOL = 30;
/** Street trees: roughly how far apart along each footpath, and their square planters' size. */
const TREE_SPACING = 24;
const PLANTER = 4;
const HEAD_COLOR = { day: 0x5c6168, night: 0xffe2a0 };
/** Light pools draw after the road layers (bridges' too), before cars and buildings. */
const POOL_ORDER = 16;
const LIGHT_ORDER = 20;

/**
 * Streetlights along the footpaths, alternating sides, clear of junctions and road ends: a pole,
 * an arm over the road and a lamp head that glows at night with a soft pool of light under it.
 * Each part is one instanced mesh, rebuilt when the roads change.
 */
export class StreetLights extends Group {
  private box = new BoxGeometry(1, 1, 1);
  private plane = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  private poleMaterial = new MeshBasicMaterial({ color: 0x80868d });
  /** Not drawn, only casting the poles' and arms' shadows (see `SHADOW_WIDTH`). */
  private shadowMaterial = new MeshBasicMaterial({ colorWrite: false, depthWrite: false });
  private headMaterial = new MeshBasicMaterial({ color: HEAD_COLOR.day, toneMapped: false });
  private poolMaterial = new MeshBasicMaterial({
    color: 0xffd98a,
    map: poolTexture(),
    transparent: true,
    opacity: 0,
    blending: AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  private parts: InstancedMesh[] = [];
  /** The driveways the lights were placed clear of (see `drivewaysMoved`). */
  private drivewaysKey = "";
  private planterMaterial = new MeshBasicMaterial({ color: 0x9a968e });
  private soilMaterial = new MeshBasicMaterial({ color: 0x4a3a2a });
  /** Planters' trees: the kit's trunk and ball of leaves (see `treeGeometries`), shaded by face. */
  private treeShapes = treeGeometries();
  private trunkMaterial = new MeshBasicMaterial({ color: TRUNK, vertexColors: true });
  private leafMaterial = Object.assign(swayMaterial(new Color(1, 1, 1)), { vertexColors: true });
  private dayHead = new Color(HEAD_COLOR.day);
  private nightHead = new Color(HEAD_COLOR.night);

  constructor(private graph: RoadGraph) {
    super();
  }

  /** Places a light every SPACING along each road with footpaths. */
  rebuild(): void {
    for (const mesh of this.parts) {
      this.remove(mesh);
      mesh.dispose();
    }
    const poles: Matrix4[] = [];
    const arms: Matrix4[] = [];
    const heads: Matrix4[] = [];
    const pools: Matrix4[] = [];
    const shadows: Matrix4[] = [];
    const planters: Matrix4[] = [];
    const soil: Matrix4[] = [];
    const trunks: Matrix4[] = [];
    const leaves: { m: Matrix4; colour: number }[] = [];
    // The same trees on a road each time it's drawn.
    let seed = 1;
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    const box = (x: number, y: number, z: number, sx: number, sy: number, sz: number, angle: number) =>
      new Matrix4().compose(new Vector3(x, y, z), q.setFromAxisAngle(up, -angle).clone(), new Vector3(sx, sy, sz));
    const driveways = this.driveways();
    this.drivewaysKey = keyOf(driveways);
    /** Whether something `size` across at `p` would stand on a driveway (on its side of the road). */
    const onDriveway = (p: { x: number; y: number }, size: number) =>
      driveways.some(({ at, out, along, half }) => {
        const d = { x: p.x - at.x, y: p.y - at.y };
        const across = d.x * out.x + d.y * out.y;
        return across < 1 && across > -FOOTPATH_WIDTH * 3 && Math.abs(d.x * along.x + d.y * along.y) < half + size / 2 + 1;
      });
    for (const segment of this.graph.segments.values()) {
      // Along footpaths, and on bridges and ramps up to them (at the parapet if there's no footpath); not in tunnels or ramps down to one.
      const levels = levelsOf(segment.spec);
      const bridge = Math.max(...levels) > 0;
      if ((!segment.spec.footpath && !bridge) || Math.min(...levels) < 0) continue;
      // As drawn (a slip road's end runs from the main road's outside lane).
      const path = this.graph.drawnPath(segment);
      // Roads joining this one at its ends: no light where it would stand on one (where a slip road overlaps).
      const neighbours = [segment.a, segment.b]
        .flatMap((n) => this.graph.segmentsAt(n))
        .filter((s) => s.id !== segment.id);
      const onRoad = (p: { x: number; y: number }) =>
        neighbours.some((s) => this.graph.drawnPath(s).distanceTo(p) < carriagewayWidth(s.spec) / 2 + 2);
      // Clear of junctions (their corners) and of driveways and joins at the road's ends.
      const clear = (node: number) => (this.graph.segmentsAt(node).length >= 3 ? this.graph.junctionRadius(node) + 8 : END_CLEAR);
      const from = clear(segment.a);
      const to = path.length - clear(segment.b);
      if (to <= from) continue;
      const count = Math.max(1, Math.floor((to - from) / SPACING) + 1);
      const step = count > 1 ? (to - from) / (count - 1) : 0;
      // A bridge deck's width, between its parapets.
      const deck = segment.spec.footpath ? roadWidth(segment.spec) : carriagewayWidth(segment.spec);
      const kerb = segment.spec.footpath ? roadWidth(segment.spec) / 2 - FOOTPATH_WIDTH / 2 : carriagewayWidth(segment.spec) / 2 + 0.4;
      // Up on the deck, as high as the bridge where it stands (0 on the ground).
      const scale = this.graph.path(segment).length / (path.length || 1);
      const lift = (d: number) => (bridge ? this.graph.heightAt(segment, d * scale) : 0);
      if (hasTrees(segment.spec) && !bridge) {
        seed = (segment.id * 7919) % 2147483646 || 1;
        // Both sides, staggered between the lights (which stand at multiples of `step`).
        const trees = Math.max(1, Math.floor((to - from) / TREE_SPACING));
        for (let i = 0; i < trees; i++) {
          const d = from + (to - from) * ((i + 0.5) / trees);
          if (count > 1 && Math.abs(((d - from) % step) - step / 2) > step / 2 - 6) continue;
          const f = path.at(d);
          for (const side of [1, -1]) {
            const at = { x: f.p.x + f.normal.x * side * kerb, y: f.p.y + f.normal.y * side * kerb };
            if (onRoad(at) || onDriveway(at, PLANTER)) continue;
            const angle = Math.atan2(f.tangent.y, f.tangent.x);
            // On the footpath, a kerb's height up.
            const k = KERB_HEIGHT;
            planters.push(box(at.x, k + 0.4, at.y, PLANTER, 0.8, PLANTER, angle));
            soil.push(box(at.x, k + 0.82, at.y, PLANTER - 0.8, 0.05, PLANTER - 0.8, angle));
            const size = 0.8 + random() * 0.4;
            const trunk = (3 + random()) * size;
            trunks.push(box(at.x, k + trunk / 2, at.y, 0.8, trunk, 0.8, angle));
            // A round tree, as the kit makes them (see `plantParts`): a ball of leaves over its trunk.
            const colour = LEAVES[Math.floor(random() * 7)];
            leaves.push({ m: box(at.x, k + trunk + 2.1 * size, at.y, 5 * size, 5.4 * size, 5 * size, angle + random()), colour });
          }
        }
      }
      for (let i = 0; i < count; i++) {
        const d = count > 1 ? from + step * i : (from + to) / 2;
        const f = path.at(d);
        // Standing on the footpath (a kerb's height up), or on the verge beside the road.
        const y = lift(d) + (segment.spec.footpath ? KERB_HEIGHT : 0);
        const side = i % 2 === 0 ? 1 : -1;
        const out = { x: f.normal.x * side, y: f.normal.y * side };
        const at = { x: f.p.x + out.x * kerb, y: f.p.y + out.y * kerb };
        // Facing the road: the arm and head point back over it.
        const angle = Math.atan2(-out.y, -out.x);
        const arm = { x: at.x - out.x * (ARM / 2), y: at.y - out.y * (ARM / 2) };
        const head = { x: at.x - out.x * ARM, y: at.y - out.y * ARM };
        // Not on another road where they meet, nor across a driveway.
        if (onRoad(at) || onDriveway(at, POLE.width)) continue;
        poles.push(box(at.x, y + POLE.height / 2, at.y, POLE.width, POLE.height, POLE.width, angle));
        arms.push(box(arm.x, y + POLE.height - 0.3, arm.y, ARM, 0.5, 0.5, angle));
        shadows.push(box(at.x, y + POLE.height / 2, at.y, SHADOW_WIDTH, POLE.height, SHADOW_WIDTH, angle));
        shadows.push(box(arm.x, y + POLE.height - 0.3, arm.y, ARM, SHADOW_WIDTH, SHADOW_WIDTH, angle));
        heads.push(box(head.x, y + POLE.height - 0.6, head.y, 2.4, 0.5, 1.4, angle));
        if (!bridge) pools.push(box(head.x, 0.06, head.y, POOL, 1, POOL, angle));
        else {
          // On a bridge, just over its deck's markings, and narrowed and moved in to stay between its parapets.
          const across = Math.min(POOL, deck);
          const offset = Math.max(-(deck - across) / 2, Math.min((deck - across) / 2, side * (kerb - ARM)));
          pools.push(box(f.p.x + f.normal.x * offset, lift(d) + 0.3, f.p.y + f.normal.y * offset, across, 1, POOL, angle));
        }
      }
    }
    const make = (geometry: BufferGeometry, material: MeshBasicMaterial, matrices: Matrix4[], order: number, shadow: boolean) => {
      const mesh = new InstancedMesh(geometry, material, Math.max(1, matrices.length));
      matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.count = matrices.length;
      mesh.renderOrder = order;
      mesh.castShadow = shadow;
      mesh.computeBoundingSphere();
      this.add(mesh);
      return mesh;
    };
    this.parts = [
      make(this.box, this.poleMaterial, poles, LIGHT_ORDER, false),
      make(this.box, this.poleMaterial, arms, LIGHT_ORDER, false),
      make(this.box, this.shadowMaterial, shadows, LIGHT_ORDER, true),
      make(this.box, this.headMaterial, heads, LIGHT_ORDER, false),
      make(this.plane, this.poolMaterial, pools, POOL_ORDER, false),
      make(this.box, this.planterMaterial, planters, LIGHT_ORDER, true),
      make(this.box, this.soilMaterial, soil, LIGHT_ORDER, false),
      make(this.treeShapes.trunk, this.trunkMaterial, trunks, LIGHT_ORDER, true),
    ];
    // Leaves: coloured per tree, swaying with the others (see `swayUniforms`).
    const leafMesh = make(this.treeShapes.crown, this.leafMaterial, leaves.map((l) => l.m), LIGHT_ORDER, true);
    leaves.forEach((l, i) => leafMesh.setColorAt(i, new Color(l.colour)));
    this.parts.push(leafMesh);
  }

  /** Where every driveway crosses the footpath: its middle, which way it runs off the road, and half its width. */
  private driveways(): Driveway[] {
    const out: Driveway[] = [];
    for (const id of this.graph.allTerminals().keys()) {
      const lot = this.graph.terminalLot(id);
      if (!lot) continue;
      const path = isSourceBuilding(lot.building) ? null : carPark(lot).path;
      const at = path === null ? lot.door : lotPoint(lot, path, -lot.depth / 2);
      out.push({ at, out: lot.out, along: lot.along, half: (path === null ? DRIVEWAY_WIDTH : SIDE_PATH) / 2 });
    }
    return out;
  }

  /** Whether any driveway's come, gone or moved since the lights were placed (they keep clear of them): a building changed, most often only growing. */
  drivewaysMoved(): boolean {
    return keyOf(this.driveways()) !== this.drivewaysKey;
  }

  /** Switches the lights on as `night` goes from 0 to 1; by day the heads look as the rest of the scene does at `exposure`. */
  setLights(exposure: number, night: number): void {
    this.headMaterial.color.copy(this.dayHead).multiplyScalar(exposure).lerp(this.nightHead, night);
    this.poolMaterial.opacity = night * 0.45;
  }

  dispose(): void {
    for (const mesh of this.parts) mesh.dispose();
    this.box.dispose();
    for (const shape of Object.values(this.treeShapes)) shape.dispose();
    this.plane.dispose();
    this.poleMaterial.dispose();
    this.shadowMaterial.dispose();
    for (const m of [this.planterMaterial, this.soilMaterial, this.trunkMaterial, this.leafMaterial]) m.dispose();
    this.headMaterial.dispose();
    this.poolMaterial.map?.dispose();
    this.poolMaterial.dispose();
  }
}

interface Driveway {
  at: { x: number; y: number };
  out: { x: number; y: number };
  along: { x: number; y: number };
  half: number;
}

const keyOf = (driveways: Driveway[]) => driveways.map((d) => `${d.at.x.toFixed(2)},${d.at.y.toFixed(2)},${d.half}`).join(";");

/** A round pool of light: bright in the middle, fading to nothing at the edge. Black adds no light. */
function poolTexture(): CanvasTexture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const glow = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  glow.addColorStop(0, "#ffffff");
  glow.addColorStop(0.5, "#5a5a5a");
  glow.addColorStop(1, "#000000");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, size, size);
  return new CanvasTexture(canvas);
}
