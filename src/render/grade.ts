import {
  BoxGeometry,
  DoubleSide,
  Mesh,
  ReplaceStencilOp,
  BufferAttribute,
  Color,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
  type BufferGeometry,
} from "three";
import { COVERED, LEVEL_HEIGHT } from "../core/grade";
import type { SampledCurve } from "../core/curve";
import { convexGeometry } from "./flat";

/** How far apart bridge pillars stand, and the step their parapets and tunnel walls are built in. */
const PILLAR_SPACING = 40;
const STEP = 6;
/** Bridges' and tunnels' concrete. */
const CONCRETE = 0xa7a49c;
/** Each road layer (footpath, asphalt, markings) a little above the one under it on a bridge, so they don't flicker. */
const LAYER_LIFT = 0.04;

/**
 * Lifts a flat road part's geometry onto a bridge (or down into a tunnel): each point to the
 * road's height where it is (`height`, by distance along `path`), a little higher for each layer
 * above the asphalt. In a tunnel, drops the part that's covered over.
 */
export function liftGeometry(geometry: BufferGeometry, path: SampledCurve, height: (s: number) => number, layer: number): void {
  const position = geometry.getAttribute("position");
  const y: number[] = [];
  for (let i = 0; i < position.count; i++) {
    const h = height(path.nearest({ x: position.getX(i), y: position.getZ(i) }).s);
    y.push(h);
    position.setY(i, h + layer * LAYER_LIFT);
  }
  position.needsUpdate = true;
  const index = geometry.getIndex();
  if (!index) return;
  const kept: number[] = [];
  for (let t = 0; t < index.count; t += 3) {
    const [a, b, c] = [index.getX(t), index.getX(t + 1), index.getX(t + 2)];
    if (y[a] < COVERED && y[b] < COVERED && y[c] < COVERED) continue;
    kept.push(a, b, c);
  }
  geometry.setIndex(new BufferAttribute(new Uint32Array(kept), 1));
  geometry.computeBoundingSphere();
}

/**
 * The concrete of a bridge or tunnel road `width` across: on a bridge, parapet walls along both
 * edges (down to the deck's underside) and pillars under it; in a tunnel, retaining walls along
 * the open ramps and a portal where it goes under. One instanced mesh.
 */
export function gradeStructure(path: SampledCurve, width: number, height: (s: number) => number, material: MeshBasicMaterial): InstancedMesh[] {
  const boxes: Matrix4[] = [];
  /** The dark of a tunnel's mouth, under each portal's lintel. */
  const mouths: Matrix4[] = [];
  const up = new Vector3(0, 1, 0);
  const across = new Vector3();
  const box = (x: number, y: number, z: number, sx: number, sy: number, sz: number, yaw: number, pitch = 0) => {
    const q = new Quaternion().setFromAxisAngle(up, -yaw).multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), pitch));
    boxes.push(new Matrix4().compose(new Vector3(x, y, z), q, new Vector3(sx, sy, sz)));
  };
  const half = width / 2;
  let portal = false;
  function mouthAt(f: { p: { x: number; y: number } }, h: number, yaw: number) {
    // Lintel: a concrete beam across the top, just above the ground.
    box(f.p.x, -0.85, f.p.y, 1.6, 2.2, width + 1.6, yaw);
    // Below it, dark down to the road.
    const before = boxes.length;
    box(f.p.x, h / 2 - 0.9, f.p.y, 1.2, -h - 1.6, width + 0.8, yaw);
    mouths.push(...boxes.splice(before));
  }
  for (let s = 0; s < path.length; s += STEP) {
    const e = Math.min(path.length, s + STEP);
    const [f, g] = [path.at(s), path.at(e)];
    const [h0, h1] = [height(s), height(e)];
    const mid = (h0 + h1) / 2;
    const yaw = Math.atan2(f.tangent.y, f.tangent.x);
    const pitch = Math.atan2(h1 - h0, e - s);
    const length = Math.hypot(e - s, h1 - h0) + 0.6;
    // A tunnel's walls run exactly where the ground's open over it (see `trenchMask`).
    const open = (h0 < -0.05 || h1 < -0.05) && h0 > COVERED && h1 > COVERED;
    for (const side of [1, -1]) {
      across.set(f.normal.x * side, 0, f.normal.y * side);
      const x = (f.p.x + g.p.x) / 2 + across.x * (half + 0.4);
      const z = (f.p.y + g.p.y) / 2 + across.z * (half + 0.4);
      if (mid > 0.5) {
        // Parapet: 1.2 above the deck, and the deck's edge 1.5 below it.
        box(x, mid - 0.15, z, length, 2.7, 0.8, yaw, pitch);
      } else if (open) {
        // Retaining wall: from the road down here to a little above the ground (covering the opening's edge).
        const low = Math.min(h0, h1);
        box(x, (low + 0.25) / 2, z, length, 0.25 - low, 0.8, yaw);
      }
    }
    // A portal across the road where it goes under: a lintel at ground level over a dark mouth.
    if (!portal && h0 > COVERED && h1 <= COVERED) {
      portal = true;
      // At the opening's edge (see `trenchMask`, which stops where it goes under).
      mouthAt(f, h0, yaw);
    }
  }
  // Closing the other end's portal too.
  for (let s = path.length; s > 0; s -= STEP) {
    const e = Math.max(0, s - STEP);
    if (height(s) > COVERED && height(e) <= COVERED) {
      const f = path.at(s);
      mouthAt(f, height(s), Math.atan2(f.tangent.y, f.tangent.x));
      break;
    }
  }
  // Pillars under a bridge, where it's up off the ground.
  for (let s = PILLAR_SPACING / 2; s < path.length; s += PILLAR_SPACING) {
    const h = height(s);
    if (h < LEVEL_HEIGHT * 0.6) continue;
    const f = path.at(s);
    box(f.p.x, (h - 1.5) / 2, f.p.y, 2.4, h - 1.5, Math.min(width * 0.6, 10), Math.atan2(f.tangent.y, f.tangent.x));
  }
  const make = (list: Matrix4[], m: MeshBasicMaterial) => {
    const mesh = new InstancedMesh(UNIT_BOX, m, Math.max(1, list.length));
    list.forEach((x, i) => mesh.setMatrixAt(i, x));
    mesh.count = list.length;
    mesh.castShadow = true;
    mesh.renderOrder = 20;
    mesh.computeBoundingSphere();
    return mesh;
  };
  return mouths.length ? [make(boxes, material), make(mouths, MOUTH)] : [make(boxes, material)];
}

/** The dark inside a tunnel. */
const MOUTH = new MeshBasicMaterial({ color: 0x0c0d10 });

const UNIT_BOX = new BoxGeometry(1, 1, 1);

/**
 * The opening in the ground over a tunnel's open ramps, `width` across (out past its walls): drawn
 * before the ground into the stencil buffer only, so the ground leaves it open and the trench shows.
 */
export function trenchMask(path: SampledCurve, width: number, height: (s: number) => number, renderOrder: number): Mesh {
  const quads: { x: number; y: number }[][] = [];
  // To the middle of the walls (0.4 out from the road's edge), so the walls cover the opening's edge.
  const half = width / 2 + 0.4;
  for (let s = 0; s < path.length; s += STEP) {
    const e = Math.min(path.length, s + STEP);
    // Open from where it starts going down, up to (not past) the portal.
    if (height(s) > -0.05 && height(e) > -0.05) continue;
    if (height(s) <= COVERED || height(e) <= COVERED) continue;
    const [f, g] = [path.at(s), path.at(e)];
    const side = (p: typeof f, k: number) => ({ x: p.p.x + p.normal.x * half * k, y: p.p.y + p.normal.y * half * k });
    quads.push([side(f, 1), side(g, 1), side(g, -1), side(f, -1)]);
  }
  const mesh = new Mesh(
    convexGeometry(quads),
    new MeshBasicMaterial({
      colorWrite: false,
      depthWrite: false,
      side: DoubleSide,
      stencilWrite: true,
      stencilRef: 1,
      stencilZPass: ReplaceStencilOp,
    }),
  );
  mesh.renderOrder = renderOrder;
  mesh.userData.own = true;
  return mesh;
}

export function concreteMaterial(): MeshBasicMaterial {
  return new MeshBasicMaterial({ color: new Color(CONCRETE) });
}
