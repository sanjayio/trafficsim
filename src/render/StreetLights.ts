import {
  AdditiveBlending,
  BoxGeometry,
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
import { carriagewayWidth, FOOTPATH_WIDTH, roadWidth } from "../core/roadSpec";

/** Distance between lights along a road (they alternate sides), and clearance from a road's ends. */
const SPACING = 55;
const END_CLEAR = 14;
/** Pole height, how far the arm reaches out over the road, and the light pool's size on the ground. */
const POLE = { height: 16, width: 0.7 };
const ARM = 4;
const POOL = 30;
const HEAD_COLOR = { day: 0x5c6168, night: 0xffe2a0 };
/** Light pools draw after the road layers, before cars and buildings. */
const POOL_ORDER = 15;
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
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    const box = (x: number, y: number, z: number, sx: number, sy: number, sz: number, angle: number) =>
      new Matrix4().compose(new Vector3(x, y, z), q.setFromAxisAngle(up, -angle).clone(), new Vector3(sx, sy, sz));
    for (const segment of this.graph.segments.values()) {
      if (!segment.spec.footpath) continue;
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
      const kerb = roadWidth(segment.spec) / 2 - FOOTPATH_WIDTH / 2;
      for (let i = 0; i < count; i++) {
        const f = path.at(count > 1 ? from + step * i : (from + to) / 2);
        const side = i % 2 === 0 ? 1 : -1;
        const out = { x: f.normal.x * side, y: f.normal.y * side };
        const at = { x: f.p.x + out.x * kerb, y: f.p.y + out.y * kerb };
        // Facing the road: the arm and head point back over it.
        const angle = Math.atan2(-out.y, -out.x);
        const arm = { x: at.x - out.x * (ARM / 2), y: at.y - out.y * (ARM / 2) };
        const head = { x: at.x - out.x * ARM, y: at.y - out.y * ARM };
        if (onRoad(at)) continue;
        poles.push(box(at.x, POLE.height / 2, at.y, POLE.width, POLE.height, POLE.width, angle));
        arms.push(box(arm.x, POLE.height - 0.3, arm.y, ARM, 0.5, 0.5, angle));
        heads.push(box(head.x, POLE.height - 0.6, head.y, 2.4, 0.5, 1.4, angle));
        pools.push(box(head.x, 0.06, head.y, POOL, 1, POOL, angle));
      }
    }
    const make = (geometry: BoxGeometry | PlaneGeometry, material: MeshBasicMaterial, matrices: Matrix4[], order: number, shadow: boolean) => {
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
      make(this.box, this.poleMaterial, poles, LIGHT_ORDER, true),
      make(this.box, this.poleMaterial, arms, LIGHT_ORDER, true),
      make(this.box, this.headMaterial, heads, LIGHT_ORDER, false),
      make(this.plane, this.poolMaterial, pools, POOL_ORDER, false),
    ];
  }

  /** Switches the lights on as `night` goes from 0 to 1; by day the heads look as the rest of the scene does at `exposure`. */
  setLights(exposure: number, night: number): void {
    this.headMaterial.color.copy(this.dayHead).multiplyScalar(exposure).lerp(this.nightHead, night);
    this.poolMaterial.opacity = night * 0.45;
  }

  dispose(): void {
    for (const mesh of this.parts) mesh.dispose();
    this.box.dispose();
    this.plane.dispose();
    this.poleMaterial.dispose();
    this.headMaterial.dispose();
    this.poolMaterial.map?.dispose();
    this.poolMaterial.dispose();
  }
}

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
