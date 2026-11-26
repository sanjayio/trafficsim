import { BoxGeometry, BufferGeometry, CanvasTexture, Color, ConeGeometry, CylinderGeometry, Float32BufferAttribute, Group, IcosahedronGeometry, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, PlaneGeometry, Quaternion, SRGBColorSpace, Vector3 } from "three";
import { carPark, DRIVEWAY_WIDTH, isSourceBuilding, LOT_SETBACK, PARKING_DEPTH, PLAZA_DEPTH, tallSteps, type Building, type BuildingDetails, type Lot } from "../core/terminal";
import { FlatLayer, flatMaterial, KERB_HEIGHT } from "./flat";
import { faceTone, villaLook, villaModel } from "./villas";

/** Buildings draw after the flat road layers, with normal depth testing. */
const BUILDING_ORDER = 20;

/** Each building's usual colours: its main colour (walls, or glass) and its accent (roof, awning, sign band, frames). */
export const BUILDING_COLORS: Record<Building, { primary: number; secondary: number }> = {
  villa: { primary: 0xf2ede4, secondary: 0xb5543c },
  townhouse: { primary: 0xe8dcc6, secondary: 0x4a4f57 },
  apartment: { primary: 0xc9c4ba, secondary: 0xa9a49a },
  smallShop: { primary: 0xe9e4d8, secondary: 0x2a9d8f },
  largeShop: { primary: 0xd8d4cc, secondary: 0xe63946 },
  smallOffice: { primary: 0x4f7ea8, secondary: 0xd6dde3 },
  largeOffice: { primary: 0x4f7ea8, secondary: 0xd6dde3 },
};

/** A building's colours when it hasn't been given its own: villas vary by where they stand (see `villaLook`). */
export function usualColors(building: Building, centre: { x: number; y: number }): { primary: number; secondary: number } {
  return building === "villa" ? villaLook(centre).colors : BUILDING_COLORS[building];
}

/** Homes take this share of their plot's length; trees fill the rest. */
const HOME_SHARE = 0.7;
const TREE_SPACING = 9;
/**
 * Leaf colours, after Kit Cidade Low Poly's palette (https://github.com/kayquer/kit-cidade-lowpoly,
 * CC0): mostly its greens, the odd tree in flower (ipê yellow, pink). Conifers stay green.
 * Ten, as scenery saves an index into them.
 */
export const LEAVES = [0x5cb84a, 0x3e8a3a, 0x8ad155, 0x4fa040, 0x6cc155, 0x47923e, 0x7fbf4a, 0x58a845, 0xe9b22c, 0xf07aa8];
export const CONIFER = [0x3e8a3a, 0x2f6e33, 0x4a8f3e, 0x356b35];
/** Trunks: the kit's wood. */
export const TRUNK = 0xa8743f;
export type PlantKind = "broadleaf" | "conifer" | "poplar" | "bush";

/**
 * A tree's parts, as the kit makes its trees: a five-sided trunk, and a faceted ball of leaves
 * (round trees, poplars stretched tall, bushes squashed) or a six-sided cone (pines).
 */
export type TreePart = "trunk" | "crown" | "cone";

/** Each part's shape, 1 across and 1 high and centred (so the leaves' sway, see `swayMaterial`, works the same), shaded by face. */
export function treeGeometries(): Record<TreePart, BufferGeometry> {
  return {
    trunk: shadedByFace(new CylinderGeometry(0.5, 0.5, 1, 5)),
    crown: shadedByFace(new IcosahedronGeometry(0.5, 1)),
    cone: shadedByFace(new ConeGeometry(0.5, 1, 6)),
  };
}

/** `geometry` with a face's own normal on each corner, and its vertex colours shaded by it like `shadedBox`'s faces. */
function shadedByFace(geometry: BufferGeometry): BufferGeometry {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  if (flat !== geometry) geometry.dispose();
  flat.deleteAttribute("normal");
  flat.computeVertexNormals();
  const normal = flat.getAttribute("normal");
  const tones: number[] = [];
  for (let i = 0; i < normal.count; i++) {
    const t = faceTone(normal.getX(i), normal.getY(i), normal.getZ(i));
    tones.push(t, t, t);
  }
  flat.setAttribute("color", new Float32BufferAttribute(tones, 3));
  return flat;
}

/**
 * The parts of a plant standing at (x, z), turned `turn` about upright, each as its unit shape's
 * matrix (see `treeGeometries`) with its leaves' colour (null for a trunk). Sizes in proportion
 * to the kit's: a round tree's ball sits over the top of its trunk (`trunk` tall), a pine's cone
 * from low on its trunk; a poplar is a tall narrow ball, a bush a low squashed one.
 */
export function plantParts(
  p: { x: number; z: number; kind: PlantKind; size: number; turn: number; colour: number; trunk?: number },
  push: (part: TreePart, m: Matrix4, leaf: number | null) => void,
): void {
  const { x, z, size, colour } = p;
  const turn = new Quaternion().setFromAxisAngle(UP, p.turn);
  const part = (kind: TreePart, w: number, h: number, y: number, leaf: number | null) =>
    push(kind, new Matrix4().compose(new Vector3(x, y + h / 2, z), turn, new Vector3(w, h, w)), leaf);
  if (p.kind === "bush") {
    part("crown", 2.8 * size, 2.1 * size, 0, colour);
  } else if (p.kind === "broadleaf") {
    const trunk = p.trunk ?? 3 * size;
    part("trunk", 1, trunk + 1, 0, null);
    part("crown", 5.4 * size, 5.9 * size, trunk - 0.6 * size, colour);
  } else if (p.kind === "conifer") {
    part("trunk", 0.9, 2.5 * size, 0, null);
    part("cone", 6 * size, 8.5 * size, 2 * size, colour);
  } else {
    part("trunk", 0.8, 2.4 * size, 0, null);
    part("crown", 3 * size, 9 * size, 1.6 * size, colour);
  }
}

/**
 * Plants as instanced meshes, one per part (whatever the number of plants): `plant` adds each
 * plant's parts. Trunks in `trunkMaterial`; leaves in `leafMaterial` (white, swaying), coloured per plant.
 */
export function treeMeshes(
  geometries: Record<TreePart, BufferGeometry>,
  trunkMaterial: MeshBasicMaterial,
  leafMaterial: MeshBasicMaterial,
  plant: (push: (part: TreePart, m: Matrix4, leaf: number | null) => void) => void,
): InstancedMesh[] {
  const parts: Record<TreePart, { m: Matrix4; leaf: number | null }[]> = { trunk: [], crown: [], cone: [] };
  plant((part, m, leaf) => parts[part].push({ m, leaf }));
  const tint = new Color();
  return (Object.keys(parts) as TreePart[])
    .filter((part) => parts[part].length)
    .map((part) => {
      const list = parts[part];
      const mesh = new InstancedMesh(geometries[part], part === "trunk" ? trunkMaterial : leafMaterial, list.length);
      list.forEach(({ m, leaf }, i) => {
        mesh.setMatrixAt(i, m);
        if (leaf !== null) mesh.setColorAt(i, tint.setHex(leaf));
      });
      mesh.castShadow = true;
      mesh.computeBoundingSphere();
      return mesh;
    });
}
const UP = new Vector3(0, 1, 0);


/** Trees along an office plaza, with a bench between each pair. */
const PLAZA_SPACING = 12;
/**
 * Panels over office glass and flats' window bands where someone's in: the glass's colour by
 * day (a shade off it, so their own materials), lit at night while the rest stays dark.
 */
const OCCUPIED_GLASS_LIGHT = 0xf2c96a;
const OCCUPIED_BAND_LIGHT = 0xffdf99;
/** Share lit at night (most offices have gone home; most flats are lived in), and roughly how wide each unit is along a wall. */
const OCCUPANCY = { office: 0.3, flat: 0.7 };
const UNIT_WIDTH = 7;

/** Window colours, and the light they give at night: warm everywhere, offices included. */
const WINDOW_LIGHT = new Map<number, number>([
  [0x2b3440, 0xffd27a],
]);
const GARAGE_WIDTH = 8;

/**
 * Builds the 3D model of each source and sink building from boxes and gable roofs, faces shaded
 * by hand (lit top, a lighter and a darker pair of sides) since the scene has no lights.
 * Geometry is shared; materials are cached per colour.
 */
export class BuildingKit {
  private box = shadedBox();
  private roof = gableGeometry();
  private treeShapes = treeGeometries();
  /** A unit square lying on the ground. */
  private plane = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  private grass = flatMaterial(0x7fa86a);
  private concrete = flatMaterial(0xa3a59f);
  private paint = flatMaterial(0xf2f2ee);
  private drive = flatMaterial(0x45494f);
  private materials = new Map<string, MeshBasicMaterial>();
  /** Trees placed on the lot being made (see `tree`), planted together at the end (see `plantTrees`). */
  private trees: { x: number; z: number; bush?: boolean }[] = [];
  /** Leaves: white, shaded by face (the box's vertex colours), each tree's colour set per instance; they sway (see `swayMaterial`). */
  private leafMaterial = Object.assign(swayMaterial(new Color(1, 1, 1)), { vertexColors: true });

  /** The building being made's details (see `model`): its colours, and its name for its sign. */
  private details: BuildingDetails = {};
  private signName = "";
  private building: Building = "villa";
  /** An upright unit square facing -z (a building's front), for name signs. */
  private signPlane = new PlaneGeometry(1, 1).rotateY(Math.PI);

  /** The building's chosen colour for `role`, or its usual `colour`. */
  private colour(colour: number, role: "primary" | "secondary"): number {
    return this.details.colors?.[role] ?? colour;
  }

  /**
   * The building's name on a board `w` × `h`, centred on x, from height y, just in front of the
   * wall at `front`: light lettering on its secondary colour (dark lettering on a light one).
   * Not dimmed at night. Its texture and material are its own (`userData.own`), freed with it.
   */
  private sign(w: number, h: number, x: number, y: number, front: number): Mesh {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = Math.max(64, Math.round((512 * h) / w));
    const ctx = canvas.getContext("2d")!;
    const back = new Color(this.colour(BUILDING_COLORS[this.building].secondary, "secondary"));
    ctx.fillStyle = `#${back.getHexString()}`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const light = back.r * 0.3 + back.g * 0.59 + back.b * 0.11 > 0.55;
    ctx.fillStyle = light ? "#1d232b" : "#fdf8ec";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    let size = canvas.height * 0.62;
    ctx.font = `700 ${size}px system-ui, sans-serif`;
    while (size > 10 && ctx.measureText(this.signName).width > canvas.width * 0.9) ctx.font = `700 ${(size *= 0.9)}px system-ui, sans-serif`;
    ctx.fillText(this.signName, canvas.width / 2, canvas.height / 2);
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    const mesh = new Mesh(this.signPlane, new MeshBasicMaterial({ map: texture, toneMapped: false }));
    mesh.scale.set(w, h, 1);
    mesh.position.set(x, y + h / 2, front - 0.08);
    mesh.renderOrder = BUILDING_ORDER;
    mesh.userData.own = true;
    return mesh;
  }

  /** Picks which offices and flats are vacant: seeded per building (see `model`), so it's the same each time it's drawn. */
  private random = () => 0.5;
  /** Window materials, with their colours by day and lit at night. */
  private windows: { material: MeshBasicMaterial; day: Color; night: Color }[] = [];

  /**
   * Lights windows for the time of day: by day they look as the rest of the scene does at
   * `exposure`; as `night` goes from 0 to 1, they glow.
   */
  setLights(exposure: number, night: number): void {
    for (const w of this.windows) w.material.color.copy(w.day).multiplyScalar(exposure).lerp(w.night, night);
    // Villas' glass: the same glow, through the scene's exposure (linear tone mapping), which it undoes.
    villaUniforms.villaNight.value = night;
    villaUniforms.villaGlow.value.copy(VILLA_GLOW).multiplyScalar(1 / Math.max(exposure, 0.05));
  }

  /**
   * A model for `lot`'s building, placed and turned so its front faces the road. In its own frame,
   * x runs along the road, z away from it (the front is at z = -depth/2), y is up.
   */
  model(lot: Lot, details: BuildingDetails = {}): Group {
    this.trees = [];
    this.details = details;
    this.signName = details.name ?? "";
    this.building = lot.building;
    const group = new Group();
    // Local +z is the right of local +x: point x along the road the way that puts z towards the building.
    const right = { x: -lot.along.y, y: lot.along.x };
    const flip = lot.out.x * right.x + lot.out.y * right.y > 0 ? 1 : -1;
    // The whole lot (its plot and all on it) at the footpath's height, so plot and footpath meet level.
    group.position.set(lot.centre.x, KERB_HEIGHT, lot.centre.y);
    group.rotation.y = -Math.atan2(lot.along.y * flip, lot.along.x * flip);
    const { building, length: l, depth: d } = lot;
    let seed = (Math.round(lot.centre.x * 7 + lot.centre.y * 13) >>> 0) || 1;
    this.random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    // Where the driveway meets the plot, along the road in this frame.
    const doorX = ((lot.door.x - lot.centre.x) * lot.along.x + (lot.door.y - lot.centre.y) * lot.along.y) * flip;
    const home = isSourceBuilding(building);
    // The plot is the building's tiles: from the road's edge to just behind the building, and a little to each side.
    const plot = { left: -l / 2 - 2, right: l / 2 + 2, front: -d / 2 - LOT_SETBACK, back: d / 2 + 2 };
    group.add(this.flat(home ? this.grass : this.concrete, FlatLayer.footpath, (plot.left + plot.right) / 2, (plot.front + plot.back) / 2, plot.right - plot.left, plot.back - plot.front));

    // A home is narrower than its plot, over its driveway, with trees round it; a shop or office
    // stands where its car park leaves room (see carPark).
    const park = home ? null : carPark(lot);
    const at = park?.building;
    const villa = building === "villa" ? this.villa(lot, l * HOME_SHARE, d, doorX) : null;
    const bl = villa ? villa.width : at ? at.a1 - at.a0 : l * HOME_SHARE;
    const bd = at ? at.z1 - at.z0 : d;
    const bx = villa ? villa.x : at ? ((at.a0 + at.a1) / 2) * flip : Math.max(-(l - bl) / 2, Math.min((l - bl) / 2, doorX));
    const bz = at ? (at.z0 + at.z1) / 2 : 0;
    const body = new Group();
    body.position.set(bx, 0, bz);
    // Homes: a garage door where the driveway ends (in the house's own frame).
    if (villa) body.add(villa.mesh);
    else for (const mesh of this.parts(building as Exclude<Building, "villa">, bl, bd, doorX - bx)) body.add(mesh);
    // Levels gained upward: the same building, taller.
    body.scale.y = 1 + 0.3 * tallSteps(details);
    group.add(body);

    if (home) {
      const yard = -d / 2 - LOT_SETBACK / 2;
      for (let x = plot.left + TREE_SPACING / 2; x <= plot.right - 2; x += TREE_SPACING) {
        if (Math.abs(x - doorX) < DRIVEWAY_WIDTH / 2 + 3) continue;
        // Flats get low bushes along the front rather than trees.
        if (building === "apartment") this.bush(x - TREE_SPACING / 4, yard), this.bush(x + TREE_SPACING / 4, yard);
        else this.tree(x, yard);
      }
      for (const [from, to] of [[plot.left, bx - bl / 2], [bx + bl / 2, plot.right]]) {
        if (to - from < 5) continue;
        // From behind where the villa's side door is.
        for (let z = -d / 2 + 10; z <= d / 2 - 2; z += TREE_SPACING) this.tree((from + to) / 2, z);
      }
    } else if (park!.bays[0]?.underground) {
      // A plaza in front, with trees and benches either side of the drive to the garage entrance.
      group.add(this.flat(this.drive, FlatLayer.asphalt, doorX, -d / 2 + PLAZA_DEPTH / 2, DRIVEWAY_WIDTH, PLAZA_DEPTH));
      const z = -d / 2 + PLAZA_DEPTH / 2;
      for (let x = -l / 2 + 4, i = 0; x <= l / 2 - 3; x += PLAZA_SPACING / 2, i++) {
        if (Math.abs(x - doorX) < DRIVEWAY_WIDTH / 2 + 3) continue;
        if (i % 2 === 0) this.tree(x, z);
        else group.add(...this.bench(x, z));
      }
    } else {
      // The bays cars park in (see Simulation), between painted lines.
      for (const { a, z } of park!.lines) group.add(this.flat(this.paint, FlatLayer.markings, a * flip, z, 0.5, PARKING_DEPTH - 1));
      // The large shop: two trees and a bench in the front yard, clear of the entrance and the side driveway.
      if (park!.path !== null) {
        const yard = -d / 2 - LOT_SETBACK / 2;
        // At the ends of the front, clear of the shop's entrance in the middle.
        const { a0, a1 } = at!;
        if (building === "largeShop") {
          this.tree((a0 + 4) * flip, yard);
          this.tree((a1 - 4) * flip, yard);
          for (const mesh of this.bench(a0 + 11, yard)) mesh.position.x *= flip, group.add(mesh);
        }
      }
    }
    const trees = this.plantTrees();
    if (trees.length) group.add(...trees);
    return group;
  }

  /** A flat rectangle of size (w, d) on the ground, centred on (x, z), drawn in flat layer `layer`. */
  private flat(material: MeshBasicMaterial, layer: number, x: number, z: number, w: number, d: number): Mesh {
    const mesh = new Mesh(this.plane, material);
    mesh.scale.set(w, 1, d);
    mesh.position.set(x, 0, z);
    mesh.renderOrder = layer;
    return mesh;
  }

  /** A garage door on the front wall at `front`, centred on x, standing on height y: a panel with two grooves. */
  private garageDoor(x: number, y: number, front: number): Mesh[] {
    // Stands proud of the wall (and of the apartment's window bands, 0.3 out) so the faces don't flicker.
    return [
      this.block(0xd6d0c4, GARAGE_WIDTH, 6, 1, x, y, front - 0.5),
      this.block(0x9a938a, GARAGE_WIDTH - 0.6, 0.3, 1.2, x, y + 2, front - 0.5),
      this.block(0x9a938a, GARAGE_WIDTH - 0.6, 0.3, 1.2, x, y + 4, front - 0.5),
    ];
  }

  /**
   * Air-handling units on a roof `l` × `d` at height `y`, one at each spot (fractions of the roof
   * from its middle): a grey box with a dark fan grille on top and a duct running off it.
   */
  private roofUnits(l: number, d: number, y: number, spots: [number, number][]): Mesh[] {
    return spots.flatMap(([u, v]) => {
      const x = u * l;
      const z = v * d;
      return [
        this.block(0xb8bcc0, 5, 2.6, 3.6, x, y, z),
        this.block(0x34373c, 2.6, 0.25, 2.6, x + 0.8, y + 2.6, z),
        this.block(0x9da2a7, 1.2, 1.2, 6, x - 1.4, y + 0.4, z + 4.4),
      ];
    });
  }

  /** A park bench facing the road, centred on (x, z): a seat, a back, and two legs. */
  private bench(x: number, z: number): Mesh[] {
    return [
      this.block(0x8b5a2b, 5, 0.5, 1.6, x, 1.2, z),
      this.block(0x8b5a2b, 5, 1.4, 0.4, x, 1.7, z + 0.8),
      this.block(0x4a4d52, 0.4, 1.2, 1.4, x - 2, 0, z),
      this.block(0x4a4d52, 0.4, 1.2, 1.4, x + 2, 0, z),
    ];
  }

  /** The way into an underground car park, in the front wall at `front`, centred on x: a dark opening under a concrete lintel. */
  private garageEntrance(x: number, front: number): Mesh[] {
    // Stands proud of the wall, its window bands and lit panels, so the faces don't flicker.
    return [this.block(0x15171b, 10, 5, 1, x, 0, front - 0.5), this.block(0x8a8f96, 11, 1, 1.2, x, 5, front - 0.6)];
  }

  /** A small low-poly tree: a trunk and two stacked blocks of leaves. */
  private tree(x: number, z: number): void {
    this.trees.push({ x, z });
  }

  /** A low bush at (x, z), planted with the trees. */
  private bush(x: number, z: number): void {
    this.trees.push({ x, z, bush: true });
  }

  /**
   * The lot's trees (see `tree`), each a kind picked at random (round broadleaf, stacked conifer,
   * tall poplar) at a random size, turned a little, its leaves somewhere from deep green to autumn
   * red. Trunks and leaves are one instanced mesh each; the leaves sway in the wind (see `swayUniforms`).
   */
  private plantTrees(): Mesh[] {
    if (!this.trees.length) return [];
    const meshes = treeMeshes(this.treeShapes, this.shaded(TRUNK), this.leafMaterial, (push) => {
      for (const { x, z, bush } of this.trees) {
        // (The same draws, in the same order, as ever: the same trees on the same lots.)
        const pick = this.random();
        const size = 0.8 + this.random() * 0.5;
        const turn = this.random() * Math.PI;
        let colour = LEAVES[Math.floor(this.random() * LEAVES.length)];
        const kind: PlantKind = bush ? "bush" : pick < 0.5 ? "broadleaf" : pick < 0.8 ? "conifer" : "poplar";
        const trunk = kind === "broadleaf" ? (2.5 + this.random() * 1.5) * size : undefined;
        if (kind === "conifer") colour = CONIFER[Math.floor(this.random() * CONIFER.length)];
        plantParts({ x, z, kind, size, turn, colour, trunk }, push);
      }
    });
    for (const mesh of meshes) mesh.renderOrder = BUILDING_ORDER;
    return meshes;
  }


  dispose(): void {
    this.box.dispose();
    for (const shape of Object.values(this.treeShapes)) shape.dispose();
    this.roof.dispose();
    this.plane.dispose();
    this.signPlane.dispose();
    this.leafMaterial.dispose();
    for (const m of [this.grass, this.concrete, this.paint, this.drive]) m.dispose();
    for (const m of this.materials.values()) m.dispose();
  }

  /**
   * A villa (see `villas`) on a plot `l` long and `d` deep (its body's share of the lot): its
   * variant by where it stands, scaled to fit, turned (mirrored) so its garage is on the
   * driveway's side and slid so the garage door meets the driveway at `doorX`, within the plot.
   * Its middle across the plot and its width, for the trees round it.
   */
  private villa(lot: Lot, l: number, d: number, doorX: number): { mesh: Mesh; x: number; width: number } {
    const { variant, colors } = villaLook(lot.centre);
    const model = villaModel(variant);
    const scale = Math.min(l / (model.maxX - model.minX), d / (model.maxZ - model.minZ));
    const width = (model.maxX - model.minX) * scale;
    const middle = (model.minX + model.maxX) / 2;
    const garage = model.garageX - middle;
    const mirror = doorX >= 0 === garage >= 0 ? 1 : -1;
    const room = (lot.length - width) / 2;
    const x = Math.max(-room, Math.min(room, doorX - mirror * garage * scale));
    const mesh = new Mesh(model.geometry, this.villaMaterial(this.details.colors ?? colors));
    mesh.scale.set(mirror * scale, scale, scale);
    // Its front on the body's front (the plot's road side).
    mesh.position.set(-mirror * middle * scale, 0, -d / 2 - model.minZ * scale);
    mesh.renderOrder = BUILDING_ORDER;
    mesh.castShadow = true;
    return { mesh, x, width };
  }

  /**
   * A villa's material: the model's own colours, its walls and roof in `colors`, and its glass
   * lit at night (see `setLights`). One per pair of colours; every villa shares its variant's geometry.
   */
  private villaMaterial(colors: { primary: number; secondary: number }): MeshBasicMaterial {
    const key = `villa:${colors.primary}:${colors.secondary}`;
    let material = this.materials.get(key);
    if (!material) {
      material = new MeshBasicMaterial({ vertexColors: true });
      const walls = { value: new Color(colors.primary) };
      const roof = { value: new Color(colors.secondary) };
      material.onBeforeCompile = function (shader, renderer) {
        // The scene's own changes first (tint, cloud shadows).
        MeshBasicMaterial.prototype.onBeforeCompile.call(this, shader, renderer);
        Object.assign(shader.uniforms, villaUniforms, { villaWalls: walls, villaRoof: roof });
        shader.vertexShader = shader.vertexShader
          .replace("#include <common>", "#include <common>\nattribute float role;\nvarying float vRole;")
          .replace("#include <begin_vertex>", "#include <begin_vertex>\nvRole = role;");
        shader.fragmentShader = shader.fragmentShader
          .replace("#include <common>", "#include <common>\nvarying float vRole;\nuniform vec3 villaWalls;\nuniform vec3 villaRoof;\nuniform vec3 villaGlow;\nuniform float villaNight;")
          .replace(
            "#include <color_fragment>",
            `#include <color_fragment>
            if (vRole > 0.5 && vRole < 1.5) diffuseColor.rgb *= villaWalls;
            else if (vRole > 1.5 && vRole < 2.5) diffuseColor.rgb *= villaRoof;`,
          )
          // After the scene's tint: lit windows aren't dimmed with the scene.
          .replace("#include <tonemapping_fragment>", "if (vRole > 2.5) gl_FragColor.rgb = mix(gl_FragColor.rgb, villaGlow, villaNight);\n#include <tonemapping_fragment>");
      };
      material.customProgramCacheKey = () => "villa";
      this.materials.set(key, material);
    }
    return material;
  }

  private parts(building: Exclude<Building, "villa">, l: number, d: number, garage: number): Mesh[] {
    const front = -d / 2;
    // Within the front wall, whatever the driveway's position.
    const garageX = Math.max(-l / 2 + GARAGE_WIDTH / 2 + 1, Math.min(l / 2 - GARAGE_WIDTH / 2 - 1, garage));
    switch (building) {
      case "townhouse": {
        const unit = l / 3;
        const colours = [0xb86b4b, this.colour(0xe8dcc6, "primary"), 0x8f9aa3];
        const roof = this.colour(0x4a4f57, "secondary");
        return colours.flatMap((colour, i) => {
          const x = -l / 2 + unit * (i + 0.5);
          // The unit the driveway leads to has the garage instead of a front door.
          const door = Math.abs(garageX - x) < unit / 2 ? this.garageDoor(garageX, 0, front) : [this.block(0x5a3e2b, 3.5, 6, 0.6, x - unit * 0.2, 0, front - 0.3)];
          return [
            this.block(colour, unit - 0.4, 16, d, x, 0, 0),
            this.gable(roof, unit, 6, d + 2, x, 16, 0),
            ...door,
            this.block(0x2b3440, 4, 3.5, 0.6, x + unit * 0.2, 9.5, front - 0.3),
            // Back windows, downstairs and up.
            this.block(0x2b3440, 4, 3.5, 0.6, x, 3, -front + 0.3),
            this.block(0x2b3440, 4, 3.5, 0.6, x, 9.5, -front + 0.3),
            // The end houses' outer walls, downstairs and up.
            ...(i === 1
              ? []
              : [3, 9.5].map((y) => this.block(0x2b3440, 0.6, 3.5, 4, (i === 0 ? -1 : 1) * (l / 2 - 0.2 + 0.3), y, 0))),
          ];
        });
      }
      case "apartment": {
        const floors = 6;
        const storey = 7.5;
        const height = floors * storey;
        return [
          this.block(this.colour(0xc9c4ba, "primary"), l, height, d, 0, 0, 0),
          ...Array.from({ length: floors }, (_, i) => this.block(0x2e3a48, l + 0.6, 3, d + 0.6, 0, i * storey + 3, 0)),
          this.occupied(0x2e3a48, OCCUPIED_BAND_LIGHT, OCCUPANCY.flat, l + 0.6, d + 0.6, floors, (i) => i * storey + 3.2, 2.6),
          this.block(this.colour(0xa9a49a, "secondary"), l + 1, 1, d + 1, 0, height, 0),
          this.block(this.colour(0xb3aea4, "secondary"), l * 0.35, 5, d * 0.4, l * 0.15, height + 1, 0),
          ...this.roofUnits(l, d, height + 1, [[-0.3, -0.25], [-0.3, 0.25]]),
          ...this.garageEntrance(garageX, front),
        ];
      }
      case "smallShop":
        return [
          this.block(this.colour(0xe9e4d8, "primary"), l, 10, d, 0, 0, 0),
          this.block(0x2b3440, l * 0.7, 5, 0.6, 0, 1, front - 0.3),
          this.block(this.colour(0x2a9d8f, "secondary"), l, 0.8, 5, 0, 7, front - 2.5),
          this.block(0xe76f51, l * 0.6, 3, 0.8, 0, 10, front + 1),
          this.sign(l * 0.6, 3, 0, 10, front + 0.55),
          ...this.roofUnits(l, d, 10, [[0, 0.2]]),
        ];
      case "largeShop":
        return [
          this.block(this.colour(0xd8d4cc, "primary"), l, 14, d, 0, 0, 0),
          this.block(this.colour(0xe63946, "secondary"), l * 0.8, 4, 1, 0, 9, front - 0.5),
          this.sign(l * 0.6, 3.4, 0, 9.3, front - 1),
          this.block(0x2b3440, l * 0.3, 6, 0.6, 0, 0, front - 0.3),
          this.block(0x9a968e, 8, 2.5, 6, -l * 0.25, 14, d * 0.1),
          this.block(0x9a968e, 8, 2.5, 6, l * 0.2, 14, -d * 0.15),
        ];
      case "smallOffice":
        return [
          ...this.glassStack(l, d, 4, 7),
          ...this.garageEntrance(garage, front),
          this.sign(Math.min(l * 0.7, 20), 2.4, garage, 7.4, front - 0.3),
          ...this.roofUnits(l, d, 28.6, [[-0.25, 0], [0.25, 0.2]]),
        ];
      case "largeOffice":
        return [
          ...this.glassStack(l, d, 11, 7),
          ...this.garageEntrance(garage, front),
          this.sign(Math.min(l * 0.6, 24), 2.6, garage, 7.3, front - 0.3),
          ...this.glassStack(l * 0.65, d * 0.65, 2, 6, 77),
          // On the lower roof, round the top floors.
          ...this.roofUnits(l, d, 77.6, [[-0.41, -0.41], [0.41, 0.41], [0.41, -0.41]]),
          this.block(0x8a939c, 2, 8, 2, 0, 89, 0),
        ];
    }
  }

  /**
   * Glass floors with a frame band at each, `floors` high, from height `base`. Bands stop just
   * under each floor's top, so the last one's top isn't level with the roof (the two would flicker).
   */
  private glassStack(l: number, d: number, floors: number, storey: number, base = 0): Mesh[] {
    const height = floors * storey;
    const glass = this.colour(0x4f7ea8, "primary");
    const frame = this.colour(0xd6dde3, "secondary");
    return [
      this.block(glass, l, height, d, 0, base, 0),
      this.occupied(glass, OCCUPIED_GLASS_LIGHT, OCCUPANCY.office, l, d, floors, (i) => base + i * storey + 0.3, storey - 2.1),
      ...Array.from({ length: floors }, (_, i) => this.block(frame, l + 0.4, 1, d + 0.4, 0, base + (i + 1) * storey - 1.5, 0)),
      // A light roof slab on top (its underside, level with the glass's roof, faces down and isn't drawn).
      this.block(frame, l + 0.4, 0.6, d + 0.4, 0, base + height, 0),
    ];
  }

  /**
   * Lit panels over the windows of the occupied units of a block `l` × `d` in plan: on each of
   * `floors` floors (the panel from height `bottom(floor)`, `height` tall), each wall split into
   * units about UNIT_WIDTH wide, a share `occupancy` of them occupied. One instanced mesh for the lot.
   */
  private occupied(colour: number, light: number, occupancy: number, l: number, d: number, floors: number, bottom: (floor: number) => number, height: number): Mesh {
    const panels: Matrix4[] = [];
    const proud = 0.12;
    for (let floor = 0; floor < floors; floor++) {
      const y = bottom(floor) + height / 2;
      // Each wall: along x (front and back) or z (the ends), at its offset out from the middle.
      for (const [length, alongX, out] of [[l, true, d / 2], [l, true, -d / 2], [d, false, l / 2], [d, false, -l / 2]] as const) {
        const units = Math.max(1, Math.round(length / UNIT_WIDTH));
        const unit = length / units;
        for (let i = 0; i < units; i++) {
          if (this.random() >= occupancy) continue;
          const at = -length / 2 + unit * (i + 0.5);
          const offset = out + Math.sign(out) * proud;
          panels.push(
            alongX
              ? new Matrix4().compose(new Vector3(at, y, offset), new Quaternion(), new Vector3(unit - 0.6, height, 0.2))
              : new Matrix4().compose(new Vector3(offset, y, at), new Quaternion(), new Vector3(0.2, height, unit - 0.6)),
          );
        }
      }
    }
    const mesh = new InstancedMesh(this.box, this.shaded(colour, light), Math.max(1, panels.length));
    panels.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.count = panels.length;
    mesh.renderOrder = BUILDING_ORDER;
    return mesh;
  }

  /** A box of size (w, h, d) standing on height y, centred on (x, z) in the building's frame. */
  private block(colour: number, w: number, h: number, d: number, x: number, y: number, z: number): Mesh {
    const mesh = new Mesh(this.box, this.shaded(colour));
    mesh.scale.set(w, h, d);
    mesh.position.set(x, y + h / 2, z);
    mesh.renderOrder = BUILDING_ORDER;
    mesh.castShadow = true;
    return mesh;
  }

  /** A gable roof (ridge along x) of size (w, h, d) on height y, centred on (x, z). */
  private gable(colour: number, w: number, h: number, d: number, x: number, y: number, z: number): Mesh {
    const mesh = new Mesh(this.roof, this.shaded(colour));
    mesh.scale.set(w, h, d);
    mesh.position.set(x, y, z);
    mesh.renderOrder = BUILDING_ORDER;
    mesh.castShadow = true;
    return mesh;
  }

  /**
   * Materials faking light from above and one side. Boxes, by face (+x, -x, +y, -y, +z, -z): the
   * ends mid-tone, the top lit, the front and back a step darker. Roofs: the two slopes, then the gable ends.
   */
  /**
   * The material for something `colour`, shaded by face by its geometry's vertex colours (lit from
   * above: top full, the rest darker), so a whole box or roof is one draw. Windows (`light`, or a
   * colour with a light) light up at night (see `setLights`).
   */
  private shaded(colour: number, light?: number): MeshBasicMaterial {
    const lit = light ?? WINDOW_LIGHT.get(colour);
    const key = `${colour}:${lit ?? ""}`;
    let material = this.materials.get(key);
    if (!material) {
      // Lit windows aren't dimmed with the scene, and glow a little brighter than their colour.
      material = new MeshBasicMaterial({ color: colour, vertexColors: true, toneMapped: !lit });
      if (lit) this.windows.push({ material, day: new Color(colour), night: new Color(lit).multiplyScalar(WINDOW_GLOW) });
      this.materials.set(key, material);
    }
    return material;
  }
}

/** A unit gable roof: base 1 × 1 at y = 0, ridge along x at y = 1, z = 0, shaded by face (see `shadedBox`). */
function gableGeometry(): BufferGeometry {
  const a = (x: number) => [x, 0, -0.5];
  const b = (x: number) => [x, 0, 0.5];
  const c = (x: number) => [x, 1, 0];
  const quad = (p: number[], q: number[], r: number[], s: number[]) => [...p, ...q, ...r, ...p, ...r, ...s];
  const positions = [
    ...quad(a(-0.5), c(-0.5), c(0.5), a(0.5)), // slope facing -z (the road)
    ...quad(b(0.5), c(0.5), c(-0.5), b(-0.5)), // slope facing +z
    ...a(0.5), ...c(0.5), ...b(0.5), // end at +x
    ...b(-0.5), ...c(-0.5), ...a(-0.5), // end at -x
  ];
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  // Shaded by face: the slope facing the road lit, the back one darker, the ends between.
  const tones = [...Array(6).fill(1), ...Array(6).fill(0.7), ...Array(6).fill(0.86)] as number[];
  geometry.setAttribute("color", new Float32BufferAttribute(tones.flatMap((t) => [t, t, t]), 3));
  return geometry;
}

/** A unit box shaded by face in its vertex colours, lit from above: top full, the x ends a step darker, the rest darker still. */
export function shadedBox(): BoxGeometry {
  const box = new BoxGeometry(1, 1, 1);
  // BoxGeometry's faces, 4 vertices each, in order: +x, -x, +y, -y, +z, -z.
  const tones = [0.86, 0.86, 1, 0.7, 0.7, 0.7];
  box.setAttribute("color", new Float32BufferAttribute(tones.flatMap((t) => Array(12).fill(t) as number[]), 3));
  return box;
}

/** How much brighter than their colour lit windows glow at night (the faces' shading dims them again). */
const WINDOW_GLOW = 1.2;

/** Shared by every villa's material: how far night has fallen, and the glow of its lit windows (see `setLights`). */
const VILLA_GLOW = new Color(0xffd27a).multiplyScalar(WINDOW_GLOW);
const villaUniforms = { villaNight: { value: 0 }, villaGlow: { value: VILLA_GLOW.clone() } };

/**
 * Shared by every tree's leaves (see `swayMaterial`): the time, and how hard the wind blows them.
 * The engine sets both each frame.
 */
export const swayUniforms = { swayTime: { value: 0 }, swayStrength: { value: 0.03 } };

/**
 * A leaf material that sways: the top of each block of leaves moves more than its bottom, each
 * tree in its own rhythm (by where it stands). Keeps the scene's own shader changes (tint, cloud
 * shadows) by running them first.
 */
export function swayMaterial(color: Color): MeshBasicMaterial {
  const material = new MeshBasicMaterial({ color });
  const base = MeshBasicMaterial.prototype.onBeforeCompile;
  material.onBeforeCompile = function (shader, renderer) {
    base.call(this, shader, renderer);
    Object.assign(shader.uniforms, swayUniforms);
    shader.vertexShader = shader.vertexShader
      .replace("void main() {", "uniform float swayTime;\nuniform float swayStrength;\nvoid main() {")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
          float swayPhase = instanceMatrix[3].x * 0.13 + instanceMatrix[3].z * 0.17;
          float swayHeight = position.y + 0.5;
          transformed.x += sin(swayTime * 1.7 + swayPhase) * swayStrength * swayHeight;
          transformed.z += sin(swayTime * 1.3 + swayPhase * 1.4) * swayStrength * 0.6 * swayHeight;
        #endif`,
      );
  };
  material.customProgramCacheKey = () => "leaves-sway";
  return material;
}
