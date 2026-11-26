import { House, KIT, pickerAt, ROLE, type KitModel } from "./villas";

/**
 * Apartment buildings, after the "prédio alto" and "prédio de apartamentos" of Kit Cidade Low Poly
 * (https://github.com/kayquer/kit-cidade-lowpoly, CC0), built like the villas (see `villas`): the
 * kit's tower and block, and a variation on each. Each has a car park entrance at the front, where
 * its driveway meets it (its cars park underground).
 */
export const APARTMENT_VARIANTS = ["tower", "lowTower", "block", "tallBlock"] as const;
export type ApartmentVariant = (typeof APARTMENT_VARIANTS)[number];

/** Walls (primary) and accents (secondary: bands, balconies, roof trim) a building is given until it's given its own. */
const TOWER = { walls: [0xf4f1ea, 0xe4e6e8, 0xdde8f0], accents: [0x3f78bf, 0x3f9a54, 0x4a5563] };
const BLOCK = { walls: [0xf2e2b6, 0xe8c9b0, 0xf2e7c4, 0xefd3d0], accents: [0xc8553d, 0xb5543c, 0x8a4b3a, 0x4a5563] };

/** An apartment building's variant and usual colours, the same each time for the same spot. */
export function apartmentLook(centre: { x: number; y: number }): { variant: ApartmentVariant; colors: { primary: number; secondary: number } } {
  const pick = pickerAt(centre);
  const variant = pick(APARTMENT_VARIANTS);
  const palette = variant === "tower" || variant === "lowTower" ? TOWER : BLOCK;
  return { variant, colors: { primary: pick(palette.walls), secondary: pick(palette.accents) } };
}

const models = new Map<ApartmentVariant, KitModel>();

/** The model for `variant` (built the first time it's asked for). */
export function apartmentModel(variant: ApartmentVariant): KitModel {
  let model = models.get(variant);
  if (!model) {
    const house = new House();
    BUILDERS[variant](house);
    model = house.done();
    models.set(variant, model);
  }
  return model;
}

/** The way into the car park under the building, in the front wall: a dark opening under a lintel. */
function carPark(h: House, x: number, front: number): void {
  h.garageAt(x);
  h.panel(0.34, 0.28, x, front, 0.14, KIT.dark, ROLE.kit);
  h.box(0.42, 0.05, 0.04, x, front - 0.025, 0.28, KIT.concrete, ROLE.kit);
}

/**
 * The kit's tower: a dark glazed ground floor under a canopy, `floors` white storeys with a glass
 * stair column, balconies (every other floor, or every floor), a water tank and solar panels on top.
 * `side` puts the stair column on the left (1) or the right (-1), the balconies opposite.
 */
function tower(h: House, floors: number, everyFloor: boolean, side: 1 | -1): void {
  const [y, w, d, storey, ground] = [0.2, 1.2, 1.15, 0.36, 0.42];
  const front = y - d / 2;
  h.box(w, d, ground, 0, y, 0, KIT.dark, ROLE.kit);
  h.panel(0.6, 0.32, -side * 0.2, front, 0.2, KIT.glassDark, ROLE.glass);
  carPark(h, side * 0.38, front);
  h.box(1.3, 0.45, 0.04, 0, front - 0.2, ground, KIT.white, ROLE.kit);
  h.box(w, d, floors * storey, 0, y, ground, 0, ROLE.walls);
  h.box(0.3, 0.06, floors * storey, -side * 0.42, front - 0.01, ground, KIT.glass, ROLE.glass);
  for (let i = 0; i < floors; i++) {
    const z = ground + i * storey;
    h.windows("front", front, z + 0.19, side * -0.15, side * 0.55, 2, 0.24, 0.2);
    h.windows("right", w / 2, z + 0.19, y - 0.4, y + 0.4, 3, 0.18, 0.2);
    if (everyFloor || i % 2 === 0) {
      h.box(0.6, 0.18, 0.03, side * 0.2, front - 0.09, z + 0.02, 0, ROLE.roof);
      h.box(0.6, 0.015, 0.1, side * 0.2, front - 0.175, z + 0.05, KIT.glass, ROLE.kit);
    }
  }
  const top = ground + floors * storey;
  h.box(w + 0.05, d + 0.05, 0.05, 0, y, top, 0, ROLE.roof);
  // Water tank on its plant room, and solar panels.
  h.box(0.36, 0.36, 0.3, -0.3, y + 0.25, top + 0.05, KIT.concrete, ROLE.kit);
  h.box(0.3, 0.3, 0.2, -0.3, y + 0.25, top + 0.35, KIT.pipe, ROLE.kit);
  for (const x of [0.08, 0.38]) h.box(0.25, 0.42, 0.04, x, y - 0.05, top + 0.12, KIT.solar, ROLE.kit);
}

/**
 * The kit's block: a concrete ground floor, `floors` storeys banded at each floor, a balcony on
 * each (`balconyX` across the front, windows the other side), and a plant room on the roof (or
 * just a water tank).
 */
function block(h: House, floors: number, balconyX: number, plantRoom: boolean): void {
  const [y, w, d, storey, ground] = [0.15, 1.4, 1.25, 0.45, 0.4];
  const front = y - d / 2;
  const windows: [number, number] = balconyX > 0 ? [-0.6, -0.1] : [0.1, 0.6];
  h.box(w, d, ground, 0, y, 0, KIT.concrete, ROLE.kit);
  for (let i = 0; i < floors; i++) {
    const z = ground + i * storey;
    h.box(w, d, storey, 0, y, z, 0, ROLE.walls);
    h.box(w + 0.03, d + 0.03, 0.04, 0, y, z, 0, ROLE.roof);
    h.windows("front", front, z + 0.24, windows[0], windows[1], 2, 0.16, 0.2);
    h.panel(0.36, 0.28, balconyX, front, z + 0.22, KIT.glassDark, ROLE.glass);
    h.box(0.48, 0.2, 0.03, balconyX, front - 0.1, z + 0.04, KIT.white, ROLE.kit);
    h.box(0.48, 0.015, 0.12, balconyX, front - 0.195, z + 0.07, KIT.glass, ROLE.kit);
    h.windows("right", w / 2, z + 0.24, y - 0.4, y + 0.4, 3, 0.16, 0.2);
  }
  const top = ground + floors * storey;
  h.box(w + 0.06, d + 0.06, 0.06, 0, y, top, KIT.slab, ROLE.kit);
  if (plantRoom) {
    h.box(0.5, 0.45, 0.3, -0.3, y + 0.2, top + 0.06, KIT.white, ROLE.kit);
    h.box(0.42, 0.36, 0.2, -0.3, y + 0.2, top + 0.36, 0, ROLE.roof);
  }
  h.box(0.26, 0.26, 0.18, 0.35, y + 0.25, top + 0.06, KIT.concrete, ROLE.kit);
  // The way in, under a canopy, and the car park's entrance beside it.
  h.panel(0.34, 0.3, -0.2, front, 0.16, KIT.glassDark, ROLE.glass);
  h.box(0.6, 0.35, 0.04, -0.2, front - 0.16, 0.34, KIT.metalDark, ROLE.kit);
  carPark(h, 0.4, front);
}

const BUILDERS: Record<ApartmentVariant, (h: House) => void> = {
  // The kit's tower: eight storeys, balconies every other floor, the stair column on the left.
  tower: (h) => tower(h, 8, false, 1),
  // Lower, a balcony on every floor, the stair column on the right.
  lowTower: (h) => tower(h, 6, true, -1),
  // The kit's block: four storeys, balconies on the right, a plant room on the roof.
  block: (h) => block(h, 4, 0.32, true),
  // A storey taller, balconies on the left, just a water tank on the roof.
  tallBlock: (h) => block(h, 5, -0.32, false),
};
