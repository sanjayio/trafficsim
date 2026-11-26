import { BufferGeometry, Color, Float32BufferAttribute } from "three";

/**
 * Villas, after the "sobrado" and "casas geminadas" of Kit Cidade Low Poly
 * (https://github.com/kayquer/kit-cidade-lowpoly, CC0): the same boxes, windows and roofs, in its units
 * (a house about 1.9 across) and colours, in five variants. Each is one geometry, built once and shared by every villa of its variant (one
 * draw call a house). Pieces are given as the kit gives them: x across the front, y back from it
 * (the front faces -y), z up from the floor.
 */
export const VILLA_VARIANTS = ["twoStorey", "upOverGarage", "singleStorey", "long", "twin"] as const;
export type VillaVariant = (typeof VILLA_VARIANTS)[number];

/** How a vertex is coloured: as built, the house's walls (primary), its roof (secondary), or window glass (lit at night). */
export const ROLE = { kit: 0, walls: 1, roof: 2, glass: 3 } as const;
type Role = (typeof ROLE)[keyof typeof ROLE];

/** The kit's palette (sRGB), for the parts that keep their own colour. */
const KIT = {
  white: 0xf4f1ea,
  slab: 0xa19e97,
  door: 0x7a5230,
  glass: 0x7fb3e0,
  metal: 0xb9c3cc,
  metalDark: 0x6f7a86,
};

/** Wall and roof colours a villa is given (by where it stands) until it's given its own. */
const WALLS = [0xf2ede4, 0xf2e2b6, 0x9fd3e0, 0xc9dcb3, 0xe8c9b0, 0xd9d3ea];
const ROOFS = [0xc8553d, 0xb5543c, 0x8a4b3a, 0x4a5563];

/** A villa's variant and its usual colours, the same each time for the same spot. */
export function villaLook(centre: { x: number; y: number }): { variant: VillaVariant; colors: { primary: number; secondary: number } } {
  // mulberry32, from the spot (neighbouring spots look unrelated).
  let seed = (Math.imul(Math.round(centre.x), 73856093) ^ Math.imul(Math.round(centre.y), 19349663)) >>> 0;
  const next = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(list: readonly T[]) => list[Math.floor(next() * list.length)];
  return { variant: pick(VILLA_VARIANTS), colors: { primary: pick(WALLS), secondary: pick(ROOFS) } };
}

/**
 * How lit a face pointing along (x, y, z) is, as `shadedBox`'s faces are: lit from above, the top
 * full, faces towards x a step darker, those towards z and underneath darker still; blended between.
 */
export function faceTone(x: number, y: number, z: number): number {
  return (Math.max(0, y) + Math.abs(x) * 0.86 + Math.abs(z) * 0.7 + Math.max(0, -y) * 0.7) / (Math.abs(x) + Math.abs(y) + Math.abs(z) || 1);
}

/** A villa's geometry, and where on it things are (in its own units, our frame: x along the front, z back, y up). */
export interface VillaModel {
  geometry: BufferGeometry;
  /** Its extent across the front (x) and back from it (z). */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** The middle of its garage door, across the front. */
  garageX: number;
}

const models = new Map<VillaVariant, VillaModel>();

/** The model for `variant` (built the first time it's asked for). */
export function villaModel(variant: VillaVariant): VillaModel {
  let model = models.get(variant);
  if (!model) {
    const house = new House();
    BUILDERS[variant](house);
    model = house.done();
    models.set(variant, model);
  }
  return model;
}

/** Shared sizes, from the kit's sobrado. */
const STOREY = 0.55;
const BODY = { x: -0.25, y: 0.2, w: 1.0, d: 0.95 };
const GARAGE = { x: 0.55, y: 0.15, w: 0.6, d: 0.85, h: 0.48 };
const FRONT = BODY.y - BODY.d / 2;

/** Front door and the two ground-floor windows of the body, as the kit has them. */
function frontage(h: House): void {
  h.panel(0.2, 0.38, -0.25, FRONT, 0.19, KIT.door, ROLE.kit);
  h.windows("front", FRONT, 0.32, -0.62, -0.47, 1, 0.18, 0.22);
  h.windows("front", FRONT, 0.32, -0.03, 0.12, 1, 0.16, 0.22);
}

/** The side garage: walls, a flat slab on top, the roll-up door with its slats, and a side window. */
function garage(h: House): void {
  const { x, y, w, d, h: height } = GARAGE;
  h.box(w, d, height, x, y, 0, KIT.white, ROLE.kit);
  h.box(w + 0.06, d + 0.05, 0.05, x, y, height, KIT.slab, ROLE.kit);
  rollUpDoor(h, x, y - d / 2);
  h.windows("right", x + w / 2, 0.3, y - 0.2, y + 0.2, 1, 0.2, 0.15);
}

function rollUpDoor(h: House, x: number, front: number): void {
  h.garageAt(x);
  h.panel(0.48, 0.36, x, front, 0.19, KIT.metal, ROLE.kit);
  for (let i = 0; i < 4; i++) h.panel(0.48, 0.012, x, front - 0.015, 0.06 + i * 0.09, KIT.metalDark, ROLE.kit, 0.01);
}

const BUILDERS: Record<VillaVariant, (h: House) => void> = {
  // The kit's sobrado: white ground floor, a coloured storey above with a balcony, hip roof; garage beside.
  twoStorey(h) {
    const { x, y, w, d } = BODY;
    h.box(w, d, STOREY, x, y, 0, KIT.white, ROLE.kit);
    h.box(w, d, STOREY, x, y, STOREY, 0, ROLE.walls);
    h.box(w + 0.04, d + 0.04, 0.04, x, y, STOREY, KIT.white, ROLE.kit);
    h.hipRoof(w, d, 0.35, x, y, STOREY * 2, 0.08);
    frontage(h);
    h.windows("right", x + w / 2, STOREY + 0.27, y - 0.3, y + 0.3, 2, 0.18, 0.22);
    // Balcony: a glass door, the slab it stands on, a glass balustrade with a rail.
    h.panel(0.42, 0.34, -0.3, FRONT, STOREY + 0.23, KIT.glass, ROLE.glass);
    h.box(0.62, 0.26, 0.04, -0.3, FRONT - 0.13, STOREY + 0.02, KIT.white, ROLE.kit);
    h.box(0.62, 0.02, 0.15, -0.3, FRONT - 0.25, STOREY + 0.06, KIT.glass, ROLE.kit);
    h.box(0.62, 0.025, 0.02, -0.3, FRONT - 0.25, STOREY + 0.21, KIT.metal, ROLE.kit);
    garage(h);
  },
  // A single-storey body under its own roof, and the upper storey moved over the garage.
  upOverGarage(h) {
    const { x, y, w, d } = BODY;
    h.box(w, d, STOREY, x, y, 0, KIT.white, ROLE.kit);
    h.hipRoof(w, d, 0.3, x, y, STOREY, 0.08);
    frontage(h);
    garage(h);
    const g = GARAGE;
    const floor = g.h + 0.05;
    h.box(g.w, g.d, 0.5, g.x, g.y, floor, 0, ROLE.walls);
    h.windows("front", g.y - g.d / 2, floor + 0.27, g.x - 0.2, g.x + 0.2, 2, 0.14, 0.2);
    h.windows("right", g.x + g.w / 2, floor + 0.27, g.y - 0.2, g.y + 0.2, 1, 0.18, 0.2);
    h.hipRoof(g.w, g.d, 0.3, g.x, g.y, floor + 0.5, 0.08);
  },
  // The sobrado without its upper storey: coloured walls, the roof on the ground floor; garage beside.
  singleStorey(h) {
    const { x, y, w, d } = BODY;
    h.box(w, d, STOREY, x, y, 0, 0, ROLE.walls);
    h.hipRoof(w, d, 0.35, x, y, STOREY, 0.08);
    frontage(h);
    garage(h);
  },
  // The kit's two joined cottages, gable ends to the street: one the home, the other its garage.
  twin(h) {
    const y = 0.25;
    const [w, d] = [0.82, 1.1];
    const front = y - d / 2;
    for (const x of [-0.42, 0.42]) {
      h.box(w, d, STOREY, x, y, 0, 0, ROLE.walls);
      h.box(w + 0.02, d + 0.02, 0.04, x, y, 0, KIT.slab, ROLE.kit);
      h.gableRoof(w, d, 0.36, x, y, STOREY, 0.06);
      // A round window high in the gable.
      h.panel(0.12, 0.12, x, front, 0.72, KIT.white, ROLE.kit);
      h.panel(0.08, 0.08, x, front - 0.01, 0.72, KIT.glass, ROLE.glass);
    }
    // The home on the left: its door and a window.
    h.panel(0.18, 0.36, -0.6, front, 0.18, KIT.door, ROLE.kit);
    h.windows("front", front, 0.32, -0.37, -0.12, 1, 0.22, 0.2);
    // The garage on the right, a side window by it.
    rollUpDoor(h, 0.42, front);
    h.windows("right", 0.83, 0.34, 0.0, 0.5, 1, 0.18, 0.2);
  },
  // One long single storey: body and garage under one roof, the garage door in the front wall.
  long(h) {
    const left = BODY.x - BODY.w / 2;
    const right = GARAGE.x + GARAGE.w / 2;
    const x = (left + right) / 2;
    const w = right - left;
    h.box(w, BODY.d, STOREY, x, BODY.y, 0, 0, ROLE.walls);
    h.hipRoof(w, BODY.d, 0.35, x, BODY.y, STOREY, 0.08);
    frontage(h);
    rollUpDoor(h, GARAGE.x, FRONT);
    h.windows("right", right, 0.32, BODY.y - 0.2, BODY.y + 0.2, 2, 0.16, 0.2);
  },
};

/**
 * Collects a house's triangles in the kit's frame and turns them into a geometry in ours: kit x, y, z
 * → our -x, z, y (the kit's front, -y, becomes our -z; a turn, not a mirror). Each piece is convex,
 * so its faces are turned to face away from its middle. Shaded by face like `shadedBox`; parts
 * that take the house's colours keep only the shading (the material tints them).
 */
class House {
  private positions: number[] = [];
  private colours: number[] = [];
  private roles: number[] = [];
  private garageX = 0;

  /** A box `w` × `d` × `h` (across, back, up), centred on (x, y), its base at height z. */
  box(w: number, d: number, h: number, x: number, y: number, z: number, colour: number, role: Role): void {
    const [x0, x1, y0, y1, z0, z1] = [x - w / 2, x + w / 2, y - d / 2, y + d / 2, z, z + h];
    const c = (i: number): [number, number, number] => [i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0];
    const faces = [
      [0, 1, 3, 2], [4, 5, 7, 6], [0, 1, 5, 4], [2, 3, 7, 6], [0, 2, 6, 4], [1, 3, 7, 5],
    ];
    this.piece(faces.map((f) => f.map(c)), colour, role);
  }

  /** The kit's four-sided roof over `w` × `d`, `h` high, centred on (x, y) at height z, overhanging by `eave`. */
  hipRoof(w: number, d: number, h: number, x: number, y: number, z: number, eave: number): void {
    const a = w / 2 + eave;
    const b = d / 2 + eave;
    const base: [number, number, number][] = [[x - a, y - b, z], [x + a, y - b, z], [x + a, y + b, z], [x - a, y + b, z]];
    const r = Math.max(Math.abs(a - b), 0.001);
    const top: [number, number, number][] = w >= d ? [[x - r, y, z + h], [x + r, y, z + h]] : [[x, y - r, z + h], [x, y + r, z + h]];
    const [c1, c2] = top;
    const faces =
      w >= d
        ? [[base[0], base[1], c2, c1], [base[1], base[2], c2], [base[2], base[3], c1, c2], [base[3], base[0], c1]]
        : [[base[0], base[1], c1], [base[1], base[2], c2, c1], [base[2], base[3], c2], [base[3], base[0], c1, c2]];
    this.piece([...faces, base], 0, ROLE.roof);
  }

  /**
   * The kit's gable roof over `w` × `d` (ridge running back from the street, gable ends to the
   * front and back), `h` high, centred on (x, y) at height z, overhanging by `eave`. The gable
   * ends are wall, set back under the overhang.
   */
  gableRoof(w: number, d: number, h: number, x: number, y: number, z: number, eave: number): void {
    const [l, r, f, b] = [x - w / 2 - eave, x + w / 2 + eave, y - d / 2 - eave, y + d / 2 + eave];
    const ridge = (yy: number): [number, number, number] => [x, yy, z + h];
    this.piece(
      [
        [[l, f, z], [l, b, z], ridge(b), ridge(f)],
        [[r, f, z], ridge(f), ridge(b), [r, b, z]],
        [[l, f, z], [r, f, z], [r, b, z], [l, b, z]],
      ],
      0,
      ROLE.roof,
    );
    const [f0, b0] = [y - d / 2, y + d / 2];
    this.piece(
      [
        [[x - w / 2, f0, z], [x + w / 2, f0, z], [x, f0, z + h]],
        [[x - w / 2, b0, z], [x, b0, z + h], [x + w / 2, b0, z]],
      ],
      0,
      ROLE.walls,
    );
  }

  /** A thin panel on the front wall at `front` (a door, a window), `w` × `h`, its middle at (x, z). */
  panel(w: number, h: number, x: number, front: number, z: number, colour: number, role: Role, thick = 0.04): void {
    this.box(w, thick, h, x, front - thick / 2, z - h / 2, colour, role);
  }

  /** Where the garage door is, across the front (kit x). */
  garageAt(x: number): void {
    this.garageX = -x;
  }

  /** `n` framed windows on the front wall (at y = `plane`) or the right wall (x = `plane`), from `from` to `to`, middle height z. */
  windows(face: "front" | "right", plane: number, z: number, from: number, to: number, n: number, w: number, h: number): void {
    for (let i = 0; i < n; i++) {
      const c = from + ((to - from) * (i + 0.5)) / n;
      if (face === "front") {
        this.box(w + 0.08, 0.03, h + 0.08, c, plane - 0.015, z - (h + 0.08) / 2, KIT.white, ROLE.kit);
        this.box(w, 0.03, h, c, plane - 0.045, z - h / 2, KIT.glass, ROLE.glass);
      } else {
        this.box(0.03, w + 0.08, h + 0.08, plane + 0.015, c, z - (h + 0.08) / 2, KIT.white, ROLE.kit);
        this.box(0.03, w, h, plane + 0.045, c, z - h / 2, KIT.glass, ROLE.glass);
      }
    }
  }

  /** Convex polygons (kit frame) of one piece, each fanned into triangles facing out. */
  private piece(polygons: [number, number, number][][], colour: number, role: Role): void {
    // Our frame.
    const our = (p: [number, number, number]): [number, number, number] => [-p[0], p[2], p[1]];
    const all = polygons.flat().map(our);
    const middle = [0, 1, 2].map((k) => all.reduce((s, p) => s + p[k], 0) / all.length);
    const base = new Color(colour || 0xffffff);
    for (const polygon of polygons) {
      const pts = polygon.map(our);
      for (let i = 1; i + 1 < pts.length; i++) {
        let [a, b, c] = [pts[0], pts[i], pts[i + 1]];
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        const len = Math.hypot(n[0], n[1], n[2]);
        if (len < 1e-9) continue;
        n = n.map((k) => k / len);
        const out = [0, 1, 2].map((k) => (a[k] + b[k] + c[k]) / 3 - middle[k]);
        if (n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0) {
          [b, c] = [c, b];
          n = n.map((k) => -k);
        }
        const tone = faceTone(n[0], n[1], n[2]);
        for (const p of [a, b, c]) {
          this.positions.push(...p);
          this.colours.push(base.r * tone, base.g * tone, base.b * tone);
          this.roles.push(role);
        }
      }
    }
  }

  done(): VillaModel {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute("color", new Float32BufferAttribute(this.colours, 3));
    geometry.setAttribute("role", new Float32BufferAttribute(this.roles, 1));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const { min, max } = geometry.boundingBox!;
    return { geometry, minX: min.x, maxX: max.x, minZ: min.z, maxZ: max.z, garageX: this.garageX };
  }
}
