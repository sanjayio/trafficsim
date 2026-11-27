import { BoxGeometry, Color, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, Quaternion, Vector3, type BufferGeometry } from "three";
import { LEVEL_HEIGHT } from "../core/grade";
import type { SampledCurve } from "../core/curve";

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
 * above the asphalt.
 */
export function liftGeometry(geometry: BufferGeometry, path: SampledCurve, height: (s: number) => number, layer: number): void {
  const position = geometry.getAttribute("position");
  for (let i = 0; i < position.count; i++) {
    const h = height(path.nearest({ x: position.getX(i), y: position.getZ(i) }).s);
    // On top of any height it has of its own (a kerb's face drops below the footpath).
    position.setY(i, position.getY(i) + h + layer * LAYER_LIFT);
  }
  position.needsUpdate = true;
  geometry.computeBoundingSphere();
}

/** A road layer's lift above the one under it at height (see `liftGeometry`), for parts lifted whole. */
export const layerLift = (layer: number) => layer * LAYER_LIFT;

/**
 * The concrete of a bridge or tunnel road `width` across: on a bridge, parapet walls along both
 * edges (down to the deck's underside, and above the footpaths when it has them, `rise` up) and
 * pillars under it; in a tunnel, walls along both sides
 * (seen in the underground view). One instanced mesh.
 */
export function gradeStructure(path: SampledCurve, width: number, height: (s: number) => number, material: MeshBasicMaterial, rise = 0): InstancedMesh[] {
  const boxes: Matrix4[] = [];
  const shades: number[] = [];
  const box = (x: number, y: number, z: number, sx: number, sy: number, sz: number, yaw: number, shade = 1) => {
    boxes.push(new Matrix4().compose(new Vector3(x, y, z), new Quaternion().setFromAxisAngle(UP, -yaw), new Vector3(sx, sy, sz)));
    shades.push(shade);
  };
  const half = width / 2;
  for (let s = 0; s < path.length; s += STEP) {
    const e = Math.min(path.length, s + STEP);
    const [f, g] = [path.at(s), path.at(e)];
    const h = (height(s) + height(e)) / 2;
    const yaw = Math.atan2(f.tangent.y, f.tangent.x);
    for (const side of [1, -1]) {
      const x = (f.p.x + g.p.x) / 2 + f.normal.x * side * (half + 0.4);
      const z = (f.p.y + g.p.y) / 2 + f.normal.y * side * (half + 0.4);
      // A bridge's parapet: waist high above where people walk, and the deck's edge 1.5 below it. A tunnel's wall, up to its roof.
      if (h > 0) box(x, h + (rise + PARAPET - 1.5) / 2, z, e - s + 0.6, rise + PARAPET + 1.5, 0.8, yaw, PARAPET_SHADE);
      else box(x, h + TUNNEL_WALL / 2, z, e - s + 0.6, TUNNEL_WALL, 0.8, yaw);
    }
  }
  // Pillars under a bridge.
  for (let s = PILLAR_SPACING / 2; s < path.length; s += PILLAR_SPACING) {
    const h = height(s);
    if (h < LEVEL_HEIGHT * 0.6) continue;
    const f = path.at(s);
    box(f.p.x, (h - 1.5) / 2, f.p.y, 2.4, h - 1.5, Math.min(width * 0.6, 10), Math.atan2(f.tangent.y, f.tangent.x));
  }
  const mesh = new InstancedMesh(UNIT_BOX, material, Math.max(1, boxes.length));
  boxes.forEach((m, i) => {
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, new Color().setScalar(shades[i]));
  });
  mesh.count = boxes.length;
  mesh.castShadow = true;
  mesh.renderOrder = 20;
  mesh.computeBoundingSphere();
  return [mesh];
}

/** A pillar holding a bridge's junction up, `h` high at `at`. */
export function pillarAt(at: { x: number; y: number }, h: number, material: MeshBasicMaterial): Mesh {
  const mesh = new Mesh(UNIT_BOX, material);
  mesh.scale.set(4, h - 1.5, 4);
  mesh.position.set(at.x, (h - 1.5) / 2, at.y);
  mesh.castShadow = true;
  mesh.renderOrder = 20;
  return mesh;
}

/** Parapets a shade darker than the pillars, so they stand out from the (unlit, as pale) footpath beside them. */
const PARAPET_SHADE = 0.82;
/** How high a bridge's parapet stands above its deck or footpath (a lane is 12 across). */
const PARAPET = 3;
/** Height of a tunnel's walls (up to its roof, under the ground). */
const TUNNEL_WALL = 9;
const UP = new Vector3(0, 1, 0);
const UNIT_BOX = new BoxGeometry(1, 1, 1);

export function concreteMaterial(): MeshBasicMaterial {
  return new MeshBasicMaterial({ color: new Color(CONCRETE) });
}
