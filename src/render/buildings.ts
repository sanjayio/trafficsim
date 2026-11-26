import { BoxGeometry, BufferGeometry, CanvasTexture, Color, ConeGeometry, CylinderGeometry, Float32BufferAttribute, Group, IcosahedronGeometry, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, PlaneGeometry, Quaternion, SRGBColorSpace, Vector3 } from "three";
import { BAY_WIDTH, carPark, DRIVEWAY_WIDTH, isSourceBuilding, LOT_SETBACK, PARKING_DEPTH, PLAZA_DEPTH, tallSteps, type Building, type BuildingDetails, type Lot, type SinkBuilding } from "../core/terminal";
import { FlatLayer, flatMaterial, KERB_HEIGHT } from "./flat";
import { palette } from "./palette";
import { apartmentLook, apartmentModel } from "./apartments";
import { commercialLook, commercialModel } from "./commercial";
import { faceTone, villaLook, villaModel, type KitModel } from "./villas";

/** Buildings draw after the flat road layers, with normal depth testing. */
const BUILDING_ORDER = 20;

/**
 * A building's colours when it hasn't been given its own, its main colour (walls) and accent (roof,
 * bands, awnings, its sign): each kind's own, varying by where it stands (see `villaLook`,
 * `apartmentLook`, `commercialLook`).
 */
export function usualColors(building: Building, centre: { x: number; y: number }): { primary: number; secondary: number } {
  if (building === "villa") return villaLook(centre).colors;
  if (building === "apartment") return apartmentLook(centre).colors;
  return commercialLook(building, centre).colors;
}

/** Apartment buildings stand no taller than this (the kit's tower, fitted to its lot, would tower over the town). */
const APARTMENT_HEIGHT = 70;

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

/** How much wider than in proportion a shop or office may be drawn, to fill its footprint. */
const MAX_STRETCH = 1.6;


/**
 * Builds the 3D model of each source and sink building (villas: see `villas`) from boxes, faces shaded
 * by hand (lit top, a lighter and a darker pair of sides) since the scene has no lights.
 * Geometry is shared; materials are cached per colour.
 */
export class BuildingKit {
  private box = shadedBox();
  private treeShapes = treeGeometries();
  /** A unit square lying on the ground. */
  private plane = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  private grass = flatMaterial(0x7fa86a);
  private concrete = flatMaterial(0xa3a59f);
  private paint = flatMaterial(0xf2f2ee);
  /** An office's drive across its plaza: paved like the footpath, as every driveway is. */
  private drive = flatMaterial(palette.footpath);
  private materials = new Map<string, MeshBasicMaterial>();
  /** Trees placed on the lot being made (see `tree`), planted together at the end (see `plantTrees`). */
  private trees: { x: number; z: number; bush?: boolean }[] = [];
  /** Leaves: white, shaded by face (the box's vertex colours), each tree's colour set per instance; they sway (see `swayMaterial`). */
  private leafMaterial = Object.assign(swayMaterial(new Color(1, 1, 1)), { vertexColors: true });

  /** The building being made's details (see `model`): its colours, and its name for its sign. */
  private details: BuildingDetails = {};
  private signName = "";
  /** The board behind the name: the building's accent colour. */
  private signBoard = 0x2a9d8f;
  /** An upright unit square facing -z (a building's front), for name signs. */
  private signPlane = new PlaneGeometry(1, 1).rotateY(Math.PI);

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
    const back = new Color(this.signBoard);
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

  /**
   * Lights windows for the time of day: by day they look as the rest of the scene does at
   * `exposure`; as `night` goes from 0 to 1, they glow.
   */
  setLights(exposure: number, night: number): void {
    // Kit buildings' glass glows, through the scene's exposure (linear tone mapping), which it undoes.
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
    // Homes are the kit's (see `villas`, `apartments`): their variant and colours by where they stand.
    const villaAt = building === "villa" ? villaLook(lot.centre) : null;
    const flatsAt = building === "apartment" ? apartmentLook(lot.centre) : null;
    const look = villaAt ? { model: villaModel(villaAt.variant), colors: villaAt.colors } : flatsAt ? { model: apartmentModel(flatsAt.variant), colors: flatsAt.colors } : null;
    const villa = look
      ? this.kitHome(
          look.model,
          this.details.colors ?? look.colors,
          lot,
          l * HOME_SHARE,
          d,
          doorX,
          building === "apartment" ? APARTMENT_HEIGHT : Infinity,
        )
      : null;
    const bl = villa ? villa.width : at ? at.a1 - at.a0 : l * HOME_SHARE;
    const bd = at ? at.z1 - at.z0 : d;
    const bx = villa ? villa.x : at ? ((at.a0 + at.a1) / 2) * flip : Math.max(-(l - bl) / 2, Math.min((l - bl) / 2, doorX));
    const bz = at ? (at.z0 + at.z1) / 2 : 0;
    const body = new Group();
    body.position.set(bx, 0, bz);
    // Homes: a garage door where the driveway ends (in the house's own frame).
    if (villa) body.add(villa.mesh);
    else body.add(...this.commercial(building as SinkBuilding, lot, bl, bd, doorX - bx, park!.bays[0]?.underground ?? false));
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
      // And a line across the closed end of each run of bays (away from where cars come in: the
      // front yard for the front row, the lane for the two behind), not across a gap left for the driveway.
      const rows = new Map<number, number[]>();
      for (const { a, z } of park!.lines) rows.set(z, [...(rows.get(z) ?? []), a]);
      for (const [z, lines] of rows) {
        const facing = park!.bays.find((b) => b.z === z)?.facing;
        const end = z + ((facing ? -facing : 1) * (PARKING_DEPTH - 1)) / 2;
        lines.sort((p, q) => p - q);
        for (let i = 0, start = 0; i < lines.length; i++) {
          if (i + 1 < lines.length && lines[i + 1] - lines[i] <= BAY_WIDTH + 0.01) continue;
          if (i > start) group.add(this.flat(this.paint, FlatLayer.markings, ((lines[start] + lines[i]) / 2) * flip, end, lines[i] - lines[start] + 0.5, 0.5));
          start = i + 1;
        }
      }
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

  /** A park bench facing the road, centred on (x, z): a seat, a back, and two legs. */
  private bench(x: number, z: number): Mesh[] {
    return [
      this.block(0x8b5a2b, 5, 0.5, 1.6, x, 1.2, z),
      this.block(0x8b5a2b, 5, 1.4, 0.4, x, 1.7, z + 0.8),
      this.block(0x4a4d52, 0.4, 1.2, 1.4, x - 2, 0, z),
      this.block(0x4a4d52, 0.4, 1.2, 1.4, x + 2, 0, z),
    ];
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
    this.plane.dispose();
    this.signPlane.dispose();
    this.leafMaterial.dispose();
    for (const m of [this.grass, this.concrete, this.paint, this.drive]) m.dispose();
    for (const m of this.materials.values()) m.dispose();
  }

  /**
   * A kit home (`model`, see `villas`) on a plot `l` long and `d` deep (its body's share of the
   * lot), in `colors`: scaled to fit (no taller than `maxHeight`), turned (mirrored) so its garage
   * or car park entrance is on the driveway's side and slid so it meets the driveway at `doorX`,
   * within the plot. Its middle across the plot and its width, for the trees round it.
   */
  private kitHome(model: KitModel, colors: { primary: number; secondary: number }, lot: Lot, l: number, d: number, doorX: number, maxHeight: number): { mesh: Mesh; x: number; width: number } {
    const scale = Math.min(l / (model.maxX - model.minX), d / (model.maxZ - model.minZ), maxHeight / model.height);
    const width = (model.maxX - model.minX) * scale;
    const middle = (model.minX + model.maxX) / 2;
    const garage = model.garageX - middle;
    const mirror = doorX >= 0 === garage >= 0 ? 1 : -1;
    const room = (lot.length - width) / 2;
    const x = Math.max(-room, Math.min(room, doorX - mirror * garage * scale));
    const mesh = new Mesh(model.geometry, this.kitMaterial(colors));
    mesh.scale.set(mirror * scale, scale, scale);
    // Its front on the body's front (the plot's road side).
    mesh.position.set(-mirror * middle * scale, 0, -d / 2 - model.minZ * scale);
    mesh.renderOrder = BUILDING_ORDER;
    mesh.castShadow = true;
    return { mesh, x, width };
  }

  /**
   * A kit home's material: the model's own colours, its walls and roof (or accents) in `colors`,
   * and its glass lit at night (see `setLights`). One per pair of colours; every home of a variant
   * shares its geometry.
   */
  private kitMaterial(colors: { primary: number; secondary: number }): MeshBasicMaterial {
    const key = `kit:${colors.primary}:${colors.secondary}`;
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
      material.customProgramCacheKey = () => "kit-home";
      this.materials.set(key, material);
    }
    return material;
  }

  /**
   * A shop or office (see `commercial`) on its footprint `l` × `d` (where its car park leaves room),
   * fitted to it, with its name on its sign. An office's garage (its car park is underground) meets
   * the driveway at `garage`: the building turned (mirrored) to put it on that side, and slid (and
   * narrowed if need be) to bring it there, within the footprint.
   */
  private commercial(building: SinkBuilding, lot: Lot, l: number, d: number, garage: number, underground: boolean): Mesh[] {
    const look = commercialLook(building, lot.centre);
    const model = commercialModel(look.variant);
    const colors = this.details.colors ?? look.colors;
    this.signBoard = colors.secondary;
    const width = model.maxX - model.minX;
    const middle = (model.minX + model.maxX) / 2;
    // Stretched along the front to fill its footprint (a car park behind and in front leaves it wide
    // and shallow), but not so far its shopfronts look drawn out.
    let scale = Math.min(l / width, d / (model.maxZ - model.minZ));
    let across = Math.min(l / width, scale * MAX_STRETCH);
    let mirror = 1;
    let centre = 0;
    if (underground) {
      const offset = model.garageX - middle;
      mirror = garage >= 0 === offset >= 0 ? 1 : -1;
      // Room to bring the garage to the driveway, the building kept within its footprint.
      const g = Math.abs(garage);
      const o = Math.abs(offset);
      across = Math.min(across, (l / 2 + g) / (width / 2 + o), o < width / 2 ? (l / 2 - g) / (width / 2 - o) : Infinity);
      scale = Math.min(scale, across);
      const room = (l - width * across) / 2;
      centre = Math.max(-room, Math.min(room, garage - mirror * offset * across));
    }
    // Model z to the footprint's: its front on the footprint's front.
    const z = (v: number) => -d / 2 + (v - model.minZ) * scale;
    const mesh = new Mesh(model.geometry, this.kitMaterial(colors));
    mesh.scale.set(mirror * across, scale, scale);
    mesh.position.set(centre - mirror * middle * across, 0, z(0));
    mesh.renderOrder = BUILDING_ORDER;
    mesh.castShadow = true;
    const meshes: Mesh[] = [mesh];
    const sign = model.sign;
    if (sign && this.signName) meshes.push(this.sign(sign.w * across, sign.h * scale, centre + mirror * (sign.x - middle) * across, (sign.y - sign.h / 2) * scale, z(sign.z)));
    return meshes;
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

  /**
   * The material for something `colour`, shaded by face by its geometry's vertex colours (lit from
   * above: top full, the rest darker), so a whole box is one draw.
   */
  private shaded(colour: number): MeshBasicMaterial {
    const key = `${colour}`;
    let material = this.materials.get(key);
    if (!material) {
      material = new MeshBasicMaterial({ color: colour, vertexColors: true });
      this.materials.set(key, material);
    }
    return material;
  }
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
