import { BoxGeometry, BufferGeometry, Color, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial } from "three";
import type { Building, Lot } from "../core/terminal";

/** Buildings draw after the flat road layers, with normal depth testing. */
const BUILDING_ORDER = 20;

/**
 * Builds the 3D model of each source and sink building from boxes and gable roofs, faces shaded
 * by hand (lit top, a lighter and a darker pair of sides) since the scene has no lights.
 * Geometry is shared; materials are cached per colour.
 */
export class BuildingKit {
  private box = new BoxGeometry(1, 1, 1);
  private roof = gableGeometry();
  private materials = new Map<number, MeshBasicMaterial[]>();

  /**
   * A model for `lot`'s building, placed and turned so its front faces the road. In its own frame,
   * x runs along the road, z away from it (the front is at z = -depth/2), y is up.
   */
  model(lot: Lot): Group {
    const group = new Group();
    // Local +z is the right of local +x: point x along the road the way that puts z towards the building.
    const right = { x: -lot.along.y, y: lot.along.x };
    const flip = lot.out.x * right.x + lot.out.y * right.y > 0 ? 1 : -1;
    group.position.set(lot.centre.x, 0, lot.centre.y);
    group.rotation.y = -Math.atan2(lot.along.y * flip, lot.along.x * flip);
    for (const mesh of this.parts(lot.building, lot.length, lot.depth)) group.add(mesh);
    return group;
  }

  dispose(): void {
    this.box.dispose();
    this.roof.dispose();
    for (const set of this.materials.values()) for (const m of set) m.dispose();
  }

  private parts(building: Building, l: number, d: number): Mesh[] {
    const front = -d / 2;
    switch (building) {
      case "villa":
        return [
          this.block(0x8a8f96, l + 2, 0.6, d + 2, 0, 0, 0),
          this.block(0xf2ede4, l, 10, d, 0, 0.6, 0),
          this.gable(0xb5543c, l + 2, 7, d + 3, 0, 10.6, 0),
          this.block(0x9b4a36, 3, 6, 3, l * 0.25, 12, d * 0.15),
          this.block(0x6b4a33, 4, 6, 0.6, -l * 0.2, 0.6, front - 0.3),
          this.block(0x2b3440, 6, 3.5, 0.6, l * 0.2, 4, front - 0.3),
        ];
      case "townhouse": {
        const unit = l / 3;
        const colours = [0xb86b4b, 0xe8dcc6, 0x8f9aa3];
        return colours.flatMap((colour, i) => {
          const x = -l / 2 + unit * (i + 0.5);
          return [
            this.block(colour, unit - 0.4, 16, d, x, 0, 0),
            this.gable(0x4a4f57, unit, 6, d + 2, x, 16, 0),
            this.block(0x5a3e2b, 3.5, 6, 0.6, x - unit * 0.2, 0, front - 0.3),
            this.block(0x2b3440, 4, 3.5, 0.6, x + unit * 0.2, 9.5, front - 0.3),
          ];
        });
      }
      case "apartment": {
        const floors = 6;
        const storey = 7.5;
        const height = floors * storey;
        return [
          this.block(0xc9c4ba, l, height, d, 0, 0, 0),
          ...Array.from({ length: floors }, (_, i) => this.block(0x2e3a48, l + 0.6, 3, d + 0.6, 0, i * storey + 3, 0)),
          this.block(0xa9a49a, l + 1, 1, d + 1, 0, height, 0),
          this.block(0xb3aea4, l * 0.35, 5, d * 0.4, l * 0.15, height + 1, 0),
          this.block(0x6b4a33, 6, 5, 0.8, 0, 0, front - 0.4),
        ];
      }
      case "smallShop":
        return [
          this.block(0xe9e4d8, l, 10, d, 0, 0, 0),
          this.block(0x2b3440, l * 0.7, 5, 0.6, 0, 1, front - 0.3),
          this.block(0x2a9d8f, l, 0.8, 5, 0, 7, front - 2.5),
          this.block(0xe76f51, l * 0.6, 3, 0.8, 0, 10, front + 1),
        ];
      case "largeShop":
        return [
          this.block(0xd8d4cc, l, 14, d, 0, 0, 0),
          this.block(0xe63946, l * 0.8, 4, 1, 0, 9, front - 0.5),
          this.block(0x2b3440, l * 0.3, 6, 0.6, 0, 0, front - 0.3),
          this.block(0x9a968e, 8, 2.5, 6, -l * 0.25, 14, d * 0.1),
          this.block(0x9a968e, 8, 2.5, 6, l * 0.2, 14, -d * 0.15),
        ];
      case "smallOffice":
        return this.glassStack(l, d, 4, 7);
      case "largeOffice":
        return [
          ...this.glassStack(l, d, 11, 7),
          ...this.glassStack(l * 0.65, d * 0.65, 2, 6, 77),
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
    return [
      this.block(0x4f7ea8, l, height, d, 0, base, 0),
      ...Array.from({ length: floors }, (_, i) => this.block(0xd6dde3, l + 0.4, 1, d + 0.4, 0, base + (i + 1) * storey - 1.5, 0)),
      // A light roof slab on top (its underside, level with the glass's roof, faces down and isn't drawn).
      this.block(0xd6dde3, l + 0.4, 0.6, d + 0.4, 0, base + height, 0),
    ];
  }

  /** A box of size (w, h, d) standing on height y, centred on (x, z) in the building's frame. */
  private block(colour: number, w: number, h: number, d: number, x: number, y: number, z: number): Mesh {
    const mesh = new Mesh(this.box, this.shaded(colour, "box"));
    mesh.scale.set(w, h, d);
    mesh.position.set(x, y + h / 2, z);
    mesh.renderOrder = BUILDING_ORDER;
    return mesh;
  }

  /** A gable roof (ridge along x) of size (w, h, d) on height y, centred on (x, z). */
  private gable(colour: number, w: number, h: number, d: number, x: number, y: number, z: number): Mesh {
    const mesh = new Mesh(this.roof, this.shaded(colour, "roof"));
    mesh.scale.set(w, h, d);
    mesh.position.set(x, y, z);
    mesh.renderOrder = BUILDING_ORDER;
    return mesh;
  }

  /**
   * Materials faking light from above and one side. Boxes, by face (+x, -x, +y, -y, +z, -z): the
   * ends mid-tone, the top lit, the front and back a step darker. Roofs: the two slopes, then the gable ends.
   */
  private shaded(colour: number, shape: "box" | "roof"): MeshBasicMaterial[] {
    const key = colour * 2 + (shape === "roof" ? 1 : 0);
    let set = this.materials.get(key);
    if (!set) {
      const tone = (k: number) => new MeshBasicMaterial({ color: new Color(colour).multiplyScalar(k) });
      const [top, light, dark] = [tone(1), tone(0.86), tone(0.7)];
      set = shape === "box" ? [light, light, top, dark, dark, dark] : [top, dark, light];
      this.materials.set(key, set);
    }
    return set;
  }
}

/** A unit gable roof: base 1 × 1 at y = 0, ridge along x at y = 1, z = 0. Groups: front slope, back slope, ends. */
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
  geometry.addGroup(0, 6, 0);
  geometry.addGroup(6, 6, 1);
  geometry.addGroup(12, 6, 2);
  return geometry;
}
