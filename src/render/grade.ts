import { BoxGeometry, Color, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, Quaternion, Vector3, type BufferGeometry } from "three";
import { LEVEL_HEIGHT } from "../core/grade";
import type { SampledCurve } from "../core/curve";
import type { Vec2 } from "../core/geometry";

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

/** Boxes of concrete, gathered and then drawn as one instanced mesh (see `mesh`). */
class Boxes {
  private matrices: Matrix4[] = [];
  private shades: number[] = [];

  add(x: number, y: number, z: number, sx: number, sy: number, sz: number, yaw: number, shade = 1): void {
    this.matrices.push(new Matrix4().compose(new Vector3(x, y, z), new Quaternion().setFromAxisAngle(UP, -yaw), new Vector3(sx, sy, sz)));
    this.shades.push(shade);
  }

  /**
   * A bridge's parapet (waist high above where people walk, `rise` up on footpaths, and the deck's
   * edge 1.5 below it) or a tunnel's wall (up to its roof) along `line`, at height `h`.
   */
  wall(line: Vec2[], h: number, rise: number): void {
    for (let i = 0; i + 1 < line.length; i++) {
      const [p, q] = [line[i], line[i + 1]];
      const length = Math.hypot(q.x - p.x, q.y - p.y);
      if (length < 1e-3) continue;
      const [x, z, yaw] = [(p.x + q.x) / 2, (p.y + q.y) / 2, Math.atan2(q.y - p.y, q.x - p.x)];
      if (h > 0) this.add(x, h + (rise + PARAPET - 1.5) / 2, z, length + 0.6, rise + PARAPET + 1.5, 0.8, yaw, PARAPET_SHADE);
      else this.add(x, h + TUNNEL_WALL / 2, z, length + 0.6, TUNNEL_WALL, 0.8, yaw);
    }
  }

  mesh(material: MeshBasicMaterial): InstancedMesh {
    const mesh = new InstancedMesh(UNIT_BOX, material, Math.max(1, this.matrices.length));
    this.matrices.forEach((m, i) => {
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, new Color().setScalar(this.shades[i]));
    });
    mesh.count = this.matrices.length;
    mesh.castShadow = true;
    mesh.renderOrder = 20;
    mesh.computeBoundingSphere();
    return mesh;
  }
}

/**
 * The concrete of a bridge or tunnel road `width` across: on a bridge, parapets along both edges
 * (`rise` higher with footpaths) and pillars under it; in a tunnel, walls along both sides (seen in
 * the underground view). Each side's wall runs only along `span(side)` (from, to along the road;
 * side 1 is the right of the road's direction): not across the junctions at its ends, whose
 * corners have their own (see `junctionWalls`). One instanced mesh.
 */
export function gradeStructure(
  path: SampledCurve,
  width: number,
  height: (s: number) => number,
  material: MeshBasicMaterial,
  rise: number,
  span: (side: 1 | -1) => [number, number],
): InstancedMesh {
  const boxes = new Boxes();
  for (const side of [1, -1] as const) {
    const [from, to] = span(side);
    const line: Vec2[] = [];
    for (let s = from; s < to; s += STEP) line.push(edge(path, s, side * (width / 2)));
    if (to > from) line.push(edge(path, to, side * (width / 2)));
    boxes.wall(line, height((from + to) / 2), rise);
  }
  // Pillars under a bridge.
  for (let s = PILLAR_SPACING / 2; s < path.length; s += PILLAR_SPACING) {
    const h = height(s);
    if (h < LEVEL_HEIGHT * 0.6) continue;
    const f = path.at(s);
    boxes.add(f.p.x, (h - 1.5) / 2, f.p.y, 2.4, h - 1.5, Math.min(width * 0.6, 10), Math.atan2(f.tangent.y, f.tangent.x));
  }
  return boxes.mesh(material);
}

/** The walls (or parapets) round a bridge's or tunnel's junction at height `h`: along each corner's outer edge, `rise` higher round footpaths. */
export function junctionWalls(corners: { edge: Vec2[]; footpath: boolean }[], h: number, rise: number, material: MeshBasicMaterial): InstancedMesh {
  const boxes = new Boxes();
  for (const { edge, footpath } of corners) boxes.wall(edge, h, footpath ? rise : 0);
  return boxes.mesh(material);
}

/** The point `offset` right of the road `s` along it. */
function edge(path: SampledCurve, s: number, offset: number): Vec2 {
  const f = path.at(s);
  return { x: f.p.x + f.normal.x * offset, y: f.p.y + f.normal.y * offset };
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
