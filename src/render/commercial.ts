import type { SinkBuilding } from "../core/terminal";
import { House, KIT, pickerAt, ROLE, type KitModel } from "./villas";

/**
 * Shops and offices, after Kit Cidade Low Poly (https://github.com/kayquer/kit-cidade-lowpoly, CC0),
 * built like the villas (see `villas`): small shops are its "mercado" or "loja de esquina", the large
 * shop its "shopping", the small office its "telhado verde" building, large offices its "escritório"
 * or "centro de tecnologia". Only the buildings: each lot lays out its own car park. Each marks
 * where its name goes (see `House.signAt`).
 */
export const COMMERCIAL_VARIANTS = {
  smallShop: ["market", "cornerShop"],
  largeShop: ["mall"],
  smallOffice: ["greenRoof"],
  largeOffice: ["officeTower", "techCentre"],
} as const satisfies Record<SinkBuilding, readonly string[]>;
export type CommercialVariant = (typeof COMMERCIAL_VARIANTS)[SinkBuilding][number];

/** Each variant's usual walls (primary) and accent (secondary: bands, awnings, trim, its sign's board). */
const COLORS: Record<CommercialVariant, { primary: number; secondary: number }> = {
  market: { primary: 0xf4f1ea, secondary: 0xe04646 },
  cornerShop: { primary: 0x3cc4dc, secondary: 0xff9a2e },
  mall: { primary: 0xf4f1ea, secondary: 0x7e57c2 },
  greenRoof: { primary: 0xf2e2b6, secondary: 0x3f9a54 },
  officeTower: { primary: 0x7fb3e0, secondary: 0xf4f1ea },
  techCentre: { primary: 0x7fb3e0, secondary: 0xb9c3cc },
};

/** A shop's or office's variant and usual colours, the same each time for the same spot. */
export function commercialLook(building: SinkBuilding, centre: { x: number; y: number }): { variant: CommercialVariant; colors: { primary: number; secondary: number } } {
  const variant = pickerAt(centre)(COMMERCIAL_VARIANTS[building] as readonly CommercialVariant[]);
  return { variant, colors: COLORS[variant] };
}

const models = new Map<CommercialVariant, KitModel>();

/** The model for `variant` (built the first time it's asked for). */
export function commercialModel(variant: CommercialVariant): KitModel {
  let model = models.get(variant);
  if (!model) {
    const house = new House();
    BUILDERS[variant](house);
    model = house.done();
    models.set(variant, model);
  }
  return model;
}

/**
 * The roll-up door into an office's underground car park, `w` × `ht`, on the wall at `front`,
 * centred on x (where its driveway meets it, see `House.garageAt`): a metal door with slats under a lintel.
 */
function garageDoor(h: House, x: number, front: number, w: number, ht: number): void {
  h.garageAt(x);
  h.panel(w, ht, x, front, ht / 2, KIT.metal, ROLE.kit);
  for (let i = 1; i < 4; i++) h.panel(w - 0.04, 0.012, x, front - 0.015, (ht * i) / 4, KIT.metalDark, ROLE.kit, 0.01);
  h.box(w + 0.06, 0.06, 0.04, x, front - 0.03, ht, KIT.concrete, ROLE.kit);
}

const BUILDERS: Record<CommercialVariant, (h: House) => void> = {
  // Supermarket: white, a red band round the top, a glass front with sliding doors under a canopy.
  market(h) {
    const [y, w, d, height] = [0.4, 1.7, 1.0, 0.62];
    const front = y - d / 2;
    h.box(w, d, height, 0, y, 0, 0, ROLE.walls);
    h.box(w + 0.03, d + 0.03, 0.12, 0, y, height - 0.12, 0, ROLE.roof);
    h.box(w, d, 0.03, 0, y, height, KIT.slab, ROLE.kit);
    // Its sign stands on the roof edge, on two posts.
    h.box(0.04, 0.04, 0.14, -0.35, front + 0.02, height, KIT.metalDark, ROLE.kit);
    h.box(0.04, 0.04, 0.14, 0.35, front + 0.02, height, KIT.metalDark, ROLE.kit);
    h.signAt(0, height + 0.12, 0.9, 0.22, front - 0.02);
    h.panel(1.3, 0.34, 0, front, 0.2, KIT.glass, ROLE.glass);
    h.panel(0.3, 0.34, 0, front - 0.005, 0.2, KIT.glassDark, ROLE.kit);
    h.box(0.7, 0.3, 0.03, 0, front - 0.15, 0.4, 0, ROLE.roof);
    h.windows("right", w / 2, 0.3, y - 0.3, y + 0.3, 2, 0.25, 0.18);
    h.box(0.25, 0.2, 0.12, -0.5, y + 0.2, height + 0.03, KIT.metal, ROLE.kit);
  },
  // Corner shop: a coloured shop floor with a sign band and striped awnings, a flat above.
  cornerShop(h) {
    const [x, y, w, d] = [-0.05, 0.15, 1.45, 1.25];
    const [front, right] = [y - d / 2, x + w / 2];
    h.box(w, d, 0.6, x, y, 0, 0, ROLE.walls);
    h.box(w, d, 0.5, x, y, 0.6, 0xf2e2b6, ROLE.kit);
    h.box(w + 0.05, d + 0.05, 0.06, x, y, 1.1, KIT.white, ROLE.kit);
    h.box(w + 0.02, d + 0.02, 0.1, x, y, 0.56, KIT.white, ROLE.kit);
    h.signAt(x - 0.1, 0.61, 0.7, 0.09, front - 0.01);
    h.panel(0.75, 0.38, x - 0.25, front, 0.25, KIT.glass, ROLE.glass);
    h.panel(0.22, 0.42, x + 0.45, front, 0.23, KIT.glassDark, ROLE.kit);
    // Awnings over the front and round the side, striped in its accent and white.
    for (let i = 0; i < 7; i++) {
      const stripe = w / 7;
      h.box(stripe, 0.3, 0.03, x - w / 2 + stripe * (i + 0.5), front - 0.15, 0.46, i % 2 ? KIT.white : 0, i % 2 ? ROLE.kit : ROLE.roof);
    }
    for (let i = 0; i < 5; i++) {
      const stripe = (d / 2 + 0.3) / 5;
      h.box(0.3, stripe, 0.03, right + 0.15, front + stripe * (i + 0.5), 0.46, i % 2 ? KIT.white : 0, i % 2 ? ROLE.kit : ROLE.roof);
    }
    h.windows("front", front, 0.85, x - 0.5, x + 0.5, 3, 0.2, 0.22);
    h.windows("right", right, 0.85, y - 0.35, y + 0.35, 2, 0.2, 0.22);
  },
  // Shopping centre: a long block at the back and a wing to the right, shopfronts under coloured
  // awnings, a canopied entrance with a skylight over the mall behind, a green roof.
  mall(h) {
    const front = 0.15;
    h.box(3.4, 1.6, 0.85, 0, 0.95, 0, 0, ROLE.walls);
    h.box(1.1, 1.4, 0.75, 1.15, -0.55, 0, 0xf2e2b6, ROLE.kit);
    h.box(3.45, 1.65, 0.05, 0, 0.95, 0.85, KIT.slab, ROLE.kit);
    h.box(1.15, 1.45, 0.05, 1.15, -0.55, 0.75, KIT.slab, ROLE.kit);
    [0xe04646, 0x3f78bf, 0xffc72c, 0x5cb84a, 0xff9a2e].forEach((awning, i) => {
      const x = -1.5 + i * 0.4;
      h.panel(0.32, 0.36, x, front, 0.24, KIT.glass, ROLE.glass);
      h.box(0.34, 0.18, 0.02, x, front - 0.09, 0.44, awning, ROLE.kit);
    });
    h.panel(0.6, 0.6, 0.35, front, 0.32, KIT.glassDark, ROLE.glass);
    h.box(1.0, 0.5, 0.05, 0.35, front - 0.25, 0.66, KIT.white, ROLE.kit);
    // Its name over the entrance, standing up above the roofline.
    // (In front of the roof slab's edge, which overhangs the wall.)
    h.signAt(0.35, 0.96, 2.2, 0.32, front - 0.05);
    for (const x of [-0.1, 0.8]) h.box(0.05, 0.05, 0.66, x, front - 0.45, 0, KIT.metal, ROLE.kit);
    h.box(0.8, 1.4, 0.06, 0.35, 0.95, 0.88, KIT.glass, ROLE.kit);
    h.box(1.3, 1.2, 0.04, -1.0, 0.95, 0.9, 0x3f9a54, ROLE.kit);
    h.box(0.4, 0.3, 0.15, 1.15, -0.4, 0.8, KIT.metal, ROLE.kit);
    h.windows("right", 1.7, 0.35, -1.1, 0.0, 3, 0.25, 0.3);
    h.panel(0.8, 0.32, 1.15, -1.25, 0.24, KIT.glass, ROLE.glass);
    h.box(0.9, 0.2, 0.02, 1.15, -1.34, 0.44, 0, ROLE.roof);
  },
  // Office block with a green roof: three floors of framed windows, a door, grass and shrubs on top.
  greenRoof(h) {
    const [x, y, w, d, height] = [-0.1, 0, 3.2, 2.8, 1.75];
    const [front, right] = [y - d / 2, x + w / 2];
    h.box(w, d, height, x, y, 0, 0, ROLE.walls);
    for (let floor = 0; floor < 3; floor++) {
      const z = 0.35 + floor * 0.52;
      // Downstairs, the door and the garage in place of the first and middle windows.
      if (floor === 0) {
        h.windows("front", front, z, x - 0.78, x - 0.26, 1, 0.32, 0.28);
        h.windows("front", front, z, x + 0.26, x + 1.3, 2, 0.32, 0.28);
      } else h.windows("front", front, z, x - 1.3, x + 1.3, 5, 0.32, 0.28);
      h.windows("right", right, z, y - 1.1, y + 1.1, 4, 0.32, 0.28);
    }
    h.panel(0.4, 0.42, x - 1.04, front, 0.21, KIT.door, ROLE.kit);
    garageDoor(h, x, front, 0.46, 0.46);
    // Its name on the roof's front edge.
    h.signAt(x - 0.4, height + 0.36, 2.6, 0.5, front - 0.05);
    h.box(w + 0.08, d + 0.08, 0.12, x, y, height, 0, ROLE.roof);
    h.box(w - 0.12, d - 0.12, 0.08, x, y, height + 0.08, 0x7cc85a, ROLE.kit);
    h.box(0.35, d - 0.2, 0.02, x + 0.3, y, height + 0.16, 0xb9b6ae, ROLE.kit);
    for (const [px, py, r, colour] of [[-1.2, -0.9, 0.22, 0x5cb84a], [-1.3, 0.2, 0.2, 0x3e8a3a], [1.0, -0.9, 0.2, 0x5cb84a], [1.2, 0.6, 0.22, 0x8ad155]] as const) {
      h.box(r * 2, r * 2, r * 1.2, x + px, y + py, height + 0.16, colour, ROLE.kit);
    }
  },
  // Office tower: a recessed glazed ground floor behind columns, six glass floors between exposed
  // slabs, a concrete core up one side, fins down the other, a plant room on the roof.
  officeTower(h) {
    const [y, w, d, storey, floors, ground] = [0.15, 1.3, 1.2, 0.34, 6, 0.5];
    const [front, right] = [y - d / 2, w / 2];
    h.box(w - 0.1, d - 0.1, ground, 0, y, 0, KIT.glassDark, ROLE.glass);
    for (const x of [-0.6, -0.2, 0.2, 0.6]) h.box(0.06, 0.06, ground, x, front + 0.03, 0, KIT.white, ROLE.kit);
    // The garage between the middle columns, in the glazed ground floor.
    garageDoor(h, 0, front + 0.05, 0.34, 0.36);
    h.box(w, d, floors * storey, 0, y, ground, 0, ROLE.walls);
    for (let i = 0; i <= floors; i++) h.box(w + 0.04, d + 0.04, 0.04, 0, y, ground + i * storey - 0.02, 0, ROLE.roof);
    for (let i = 0; i < floors; i++) {
      for (let k = 0; k < 4; k++) h.panel(0.22, 0.2, -0.55 + (k + 0.5) * 0.275, front, ground + i * storey + 0.17, KIT.glassDark, ROLE.glass, 0.03);
    }
    h.box(0.3, 0.5, floors * storey + 0.65, -w / 2 - 0.1, y + 0.2, 0, KIT.concrete, ROLE.kit);
    for (let i = 0; i < 5; i++) h.box(0.04, 0.03, floors * storey, right + 0.03, y - 0.45 + i * 0.22, ground, KIT.white, ROLE.kit);
    const top = ground + floors * storey;
    h.box(0.4, 0.4, 0.16, 0.3, y + 0.3, top + 0.02, KIT.concrete, ROLE.kit);
    h.box(0.8, 0.3, 0.03, 0.1, front - 0.15, ground - 0.02, KIT.metalDark, ROLE.kit);
    // Its name across the top of the front.
    h.signAt(0, top + 0.16, 1.2, 0.3, front - 0.03);
  },
  // Technology centre: three stepped glass volumes (the tallest behind), mullions and floor bands,
  // a dark glass entrance atrium, solar panels and an antenna mast on the roofs.
  techCentre(h) {
    const volume = (x: number, y: number, w: number, d: number, height: number) => {
      h.box(w, d, height, x, y, 0, 0, ROLE.walls);
      h.box(w + 0.05, d + 0.05, 0.06, x, y, height, KIT.white, ROLE.kit);
      for (let i = 1; i < 4; i++) {
        h.box(w + 0.02, d + 0.02, 0.025, x, y, (height * i) / 4, 0, ROLE.roof);
        h.box(0.025, 0.02, height, x - w / 2 + (w * i) / 4, y - d / 2 - 0.005, 0, 0, ROLE.roof);
        h.box(0.02, 0.025, height, x + w / 2 + 0.005, y - d / 2 + (d * i) / 4, 0, 0, ROLE.roof);
      }
      return height + 0.06;
    };
    const tall = volume(-0.05, 0.45, 1.3, 0.9, 1.7);
    const low = volume(0.35, -0.15, 0.9, 0.7, 0.9);
    // The garage in the front block.
    garageDoor(h, 0.35, -0.5, 0.36, 0.3);
    h.box(0.5, 0.35, 0.5, -0.5, -0.25, 0, KIT.glassDark, ROLE.glass);
    h.box(0.56, 0.4, 0.05, -0.5, -0.25, 0.5, KIT.white, ROLE.kit);
    h.panel(0.2, 0.32, -0.5, -0.425, 0.16, KIT.metalDark, ROLE.kit);
    // Its name on the front block's roof edge.
    h.signAt(0.35, low + 0.16, 0.9, 0.3, -0.51);
    for (let i = 0; i < 2; i++) h.box(0.36, 0.26, 0.03, 0.17 + i * 0.38, -0.15, low + 0.04, KIT.solar, ROLE.kit);
    for (let i = 0; i < 3; i++) h.box(0.36, 0.26, 0.03, -0.45 + i * 0.4, 0.3, tall + 0.04, KIT.solar, ROLE.kit);
    h.box(0.03, 0.03, 0.7, 0.4, 0.7, tall, KIT.metal, ROLE.kit);
    h.box(0.2, 0.016, 0.016, 0.4, 0.7, tall + 0.5, KIT.metal, ROLE.kit);
    h.box(0.2, 0.2, 0.1, -0.4, 0.75, tall, KIT.white, ROLE.kit);
  },
};
