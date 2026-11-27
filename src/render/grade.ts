import { AlwaysStencilFunc, BoxGeometry, BufferAttribute, BufferGeometry, Color, DoubleSide, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, Quaternion, ReplaceStencilOp, Vector3 } from "three";
import { convexGeometry, STENCIL } from "./flat";
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

/**
 * `geometry` (a road part along `path`) in pieces cut at distances `cuts` along it (ascending):
 * each triangle goes to the piece its middle falls in. Empty pieces stay empty.
 */
export function splitAlong(geometry: BufferGeometry, path: SampledCurve, cuts: number[]): BufferGeometry[] {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  const position = flat.getAttribute("position");
  const pieces: number[][] = [...cuts, Infinity].map(() => []);
  for (let t = 0; t < position.count / 3; t++) {
    let [x, z] = [0, 0];
    for (let k = 0; k < 3; k++) [x, z] = [x + position.getX(t * 3 + k), z + position.getZ(t * 3 + k)];
    const s = path.nearest({ x: x / 3, y: z / 3 }).s;
    pieces[cuts.filter((c) => s >= c).length].push(t);
  }
  const out = pieces.map((triangles) => {
    const piece = new BufferGeometry();
    for (const [name, attribute] of Object.entries(flat.attributes)) {
      const size = attribute.itemSize;
      const array = new Float32Array(triangles.length * 3 * size);
      triangles.forEach((t, i) => array.set((attribute.array as Float32Array).subarray(t * 3 * size, (t + 1) * 3 * size), i * 3 * size));
      piece.setAttribute(name, new BufferAttribute(array, size, attribute.normalized));
    }
    piece.computeBoundingSphere();
    return piece;
  });
  if (flat !== geometry) flat.dispose();
  return out;
}

/** A road layer's lift above the one under it at height (see `liftGeometry`), for parts lifted whole. */
export const layerLift = (layer: number) => layer * LAYER_LIFT;

/** Boxes of concrete, gathered and then drawn as one instanced mesh (see `mesh`). */
class Boxes {
  private matrices: Matrix4[] = [];
  private shades: number[] = [];

  /** A box `sx` along (turned `yaw`, tilted `pitch` up along it), `sy` high and `sz` across, centred at x, y, z. */
  add(x: number, y: number, z: number, sx: number, sy: number, sz: number, yaw: number, shade = 1, pitch = 0): void {
    const turn = new Quaternion().setFromAxisAngle(UP, -yaw).multiply(new Quaternion().setFromAxisAngle(ALONG_TILT, pitch));
    this.matrices.push(new Matrix4().compose(new Vector3(x, y, z), turn, new Vector3(sx, sy, sz)));
    this.shades.push(shade);
  }

  /**
   * Along `line`, at the road's height at each of its points (`heights`): a bridge's parapet (waist
   * high above where people walk, `rise` up on footpaths, and the deck's edge 1.5 below it, or down
   * to the ground where it's too low for pillars), a tunnel's wall (up to its roof), or a cutting's
   * retaining wall (up to just over the ground). Tilted with a ramp's slope. None on the ground.
   */
  wall(line: Vec2[], heights: number[], rise: number): void {
    const extent = (h: number): [number, number] =>
      h > 0 ? [h < PILLAR_MIN ? 0 : h - 1.5, h + rise + PARAPET] : [h - 1.5, h > -TUNNEL_WALL ? CUTTING_LIP : h + TUNNEL_WALL];
    for (let i = 0; i + 1 < line.length; i++) {
      const [p, q] = [line[i], line[i + 1]];
      const [h0, h1] = [heights[i], heights[i + 1]];
      const length = Math.hypot(q.x - p.x, q.y - p.y);
      if (length < 1e-3 || (h0 === 0 && h1 === 0)) continue;
      const [[b0, t0], [b1, t1]] = [extent(h0), extent(h1)];
      // Tilted with its top (level along a cutting's lip).
      const pitch = Math.atan2(t1 - t0, length);
      const [x, z, yaw] = [(p.x + q.x) / 2, (p.y + q.y) / 2, Math.atan2(q.y - p.y, q.x - p.x)];
      this.add(x, (b0 + t0 + b1 + t1) / 4, z, length / Math.cos(pitch) + 0.6, (t0 - b0 + t1 - b1) / 2, 0.8, yaw, h0 + h1 > 0 ? PARAPET_SHADE : 1, pitch);
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
    const stations: number[] = [];
    for (let s = from; s < to; s += STEP) stations.push(s);
    if (to > from) stations.push(to);
    boxes.wall(
      stations.map((s) => edge(path, s, side * (width / 2))),
      stations.map(height),
      rise,
    );
  }
  for (let s = 0; s < path.length; s += STEP) {
    const e = Math.min(path.length, s + STEP);
    // A ramp's portal: a beam across the cutting where the road goes under the ground.
    if ((height(s) + TUNNEL_WALL) * (height(e) + TUNNEL_WALL) < 0) {
      const f = path.at((s + e) / 2);
      boxes.add(f.p.x, CUTTING_LIP - 1, f.p.y, 1.6, 2, width + 1.6, Math.atan2(f.tangent.y, f.tangent.x));
    }
  }
  // Pillars under a bridge.
  for (let s = PILLAR_SPACING / 2; s < path.length; s += PILLAR_SPACING) {
    const h = height(s);
    if (h < PILLAR_MIN) continue;
    const f = path.at(s);
    boxes.add(f.p.x, (h - 1.5) / 2, f.p.y, 2.4, h - 1.5, Math.min(width * 0.6, 10), Math.atan2(f.tangent.y, f.tangent.x));
  }
  return boxes.mesh(material);
}

/** The walls (or parapets) round a bridge's or tunnel's junction at height `h`: along each corner's outer edge, `rise` higher round footpaths. */
export function junctionWalls(corners: { edge: Vec2[]; footpath: boolean }[], h: number, rise: number, material: MeshBasicMaterial): InstancedMesh {
  const boxes = new Boxes();
  for (const { edge, footpath } of corners) boxes.wall(edge, edge.map(() => h), footpath ? rise : 0);
  return boxes.mesh(material);
}

/** The point `offset` right of the road `s` along it. */
function edge(path: SampledCurve, s: number, offset: number): Vec2 {
  const f = path.at(s);
  return { x: f.p.x + f.normal.x * offset, y: f.p.y + f.normal.y * offset };
}

/**
 * Where a ramp dips into the ground, the opening of its cutting (to the outside of its walls), up
 * to its portal: drawn invisibly just before the ground, marking the stencil so the ground isn't
 * drawn there (see `outsideCuttings`). Null where it has none.
 */
export function trenchMask(path: SampledCurve, width: number, height: (s: number) => number, renderOrder: number): Mesh | null {
  const quads: Vec2[][] = [];
  const half = width / 2 + 0.4;
  for (let s = 0; s < path.length; s += STEP) {
    const e = Math.min(path.length, s + STEP);
    const open = (h: number) => h < 0 && h > -TUNNEL_WALL;
    if (!open(height(s)) && !open(height(e))) continue;
    const [f, g] = [path.at(s), path.at(e)];
    const side = (p: typeof f, k: number) => ({ x: p.p.x + p.normal.x * half * k, y: p.p.y + p.normal.y * half * k });
    quads.push([side(f, 1), side(g, 1), side(g, -1), side(f, -1)]);
  }
  if (!quads.length) return null;
  const mesh = new Mesh(
    convexGeometry(quads),
    new MeshBasicMaterial({
      colorWrite: false,
      depthWrite: false,
      depthTest: false,
      side: DoubleSide,
      stencilWrite: true,
      stencilRef: STENCIL.cutting,
      stencilWriteMask: STENCIL.cutting,
      stencilFunc: AlwaysStencilFunc,
      stencilZPass: ReplaceStencilOp,
    }),
  );
  mesh.renderOrder = renderOrder;
  mesh.userData.own = true;
  return mesh;
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
/** Height of a tunnel's walls (up to its roof, under the ground): a ramp's cutting is open, and what's in it seen, until it's this deep. */
export const TUNNEL_WALL = 9;
/** A cutting's retaining walls stand this far over the ground. */
const CUTTING_LIP = 0.8;
/** Bridges this high stand on pillars; lower (a ramp's foot), on solid walls down to the ground. */
const PILLAR_MIN = LEVEL_HEIGHT * 0.6;
/** The axis a box tilts round to follow a slope: across it. */
const ALONG_TILT = new Vector3(0, 0, 1);
const UP = new Vector3(0, 1, 0);
const UNIT_BOX = new BoxGeometry(1, 1, 1);

export function concreteMaterial(): MeshBasicMaterial {
  return new MeshBasicMaterial({ color: new Color(CONCRETE) });
}
