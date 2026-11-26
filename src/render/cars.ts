import { BufferGeometry, Float32BufferAttribute } from "three";
import { CAR_LENGTH, type CarType } from "../core/simulation";
import { House, KIT, ROLE } from "./villas";

/**
 * Cars, after Kit Cidade Low Poly's "carro", "carro elétrico" and "táxi"
 * (https://github.com/kayquer/kit-cidade-lowpoly, CC0), built like its buildings (see `villas`):
 * a body, a glass cabin with a roof, bumpers and wheels. Each is two geometries, built once: its
 * paint (tinted per car; a taxi's is always yellow) and the rest. Lights are the car layer's own,
 * at the kit's places for them (see `CarModel`), so they can brake and flash.
 */
export interface CarModel {
  /** The paint, white (each car tints it), and everything else in its own colours. */
  paint: BufferGeometry;
  rest: BufferGeometry;
  /** Overall length (bumper to bumper); where its lights sit: on the body's front and back (this far from the middle), their middle's height, and out from the centre line. */
  length: number;
  lightAt: number;
  lightHeight: number;
  lightOut: number;
  /** Half its body's width (not counting the wheels), for the indicators on its corners. */
  bodyHalfWidth: number;
}

/** The kit's sedan, bumper to bumper, as long as the simulation's cars (which spaces them). */
const SCALE = CAR_LENGTH / 0.97;
const WIDTH = 0.42;
const DARK = 0x3b404b;

/**
 * The kit's `carro`: a body `length` long in `paint` (0: the car's own), a glass cabin (a hatch's
 * longer and squarer at the back) under a roof in `roof` (0: the paint), a pillar, bumpers and wheels.
 */
function car(h: House, paint: number, length: number, roof: number, hatch: boolean): void {
  const [front, back] = [-length / 2, length / 2];
  const role = (colour: number) => (colour ? ROLE.kit : ROLE.walls);
  h.box(WIDTH, length, 0.15, 0, 0, 0.07, paint, role(paint));
  const rear = hatch ? 0.36 : 0.24;
  h.prism([[-0.2, 0], [rear, 0], [rear - (hatch ? 0.03 : 0.09), 0.14], [-0.08, 0.14]], WIDTH - 0.05, 0, 0.22, KIT.glass, ROLE.kit);
  const top = rear - (hatch ? 0.04 : 0.1);
  h.prism([[-0.07, 0], [top, 0], [top, 0.025], [-0.07, 0.025]], WIDTH - 0.04, 0, 0.355, roof || paint, role(roof || paint));
  h.box(WIDTH - 0.035, 0.035, 0.14, 0, 0.08, 0.22, paint, role(paint));
  for (const y of [front + 0.01, back - 0.01]) h.box(WIDTH + 0.01, 0.04, 0.05, 0, y, 0.06, DARK, ROLE.kit);
  // Wheels: ten-sided, dark, with a metal hub on the outside.
  // From straight down, so a corner stands on the road.
  const round = (r: number, sides: number) =>
    Array.from({ length: sides }, (_, i): [number, number] => {
      const angle = -Math.PI / 2 + (2 * Math.PI * i) / sides;
      return [r * Math.cos(angle), r * Math.sin(angle)];
    });
  for (const y of [front + 0.2, back - 0.2]) {
    for (const s of [-1, 1]) {
      const x = s * (WIDTH / 2 - 0.01);
      h.prism(round(0.085, 10).map(([a, b]) => [y + a, 0.085 + b]), 0.06, x, 0, DARK, ROLE.kit);
      h.prism(round(0.042, 6).map(([a, b]) => [y + a, 0.085 + b]), 0.01, x + s * 0.035, 0, KIT.metal, ROLE.kit);
    }
  }
}

/** Each type's builder, returning its body's length. */
const BUILDERS: Record<CarType, (h: House) => number> = {
  // The kit's hatchback, in each car's own paint.
  hatch(h) {
    car(h, 0, 0.9, 0, true);
    for (const s of [-1, 1]) h.box(0.03, 0.03, 0.02, s * 0.2, -0.12, 0.29, DARK, ROLE.kit);
    return 0.9;
  },
  // The kit's electric saloon: a dark roof, a turquoise stripe down each side, a closed grille, a charging flap.
  electric(h) {
    car(h, 0, 0.95, DARK, false);
    for (const s of [-1, 1]) h.box(0.012, 0.8, 0.025, s * 0.211, 0, 0.13, 0x3cc4dc, ROLE.kit);
    h.box(0.18, 0.012, 0.04, 0, -0.479, 0.12, 0x3cc4dc, ROLE.kit);
    h.box(0.012, 0.06, 0.05, 0.212, 0.3, 0.17, 0x1f8fd0, ROLE.kit);
    return 0.95;
  },
  // The kit's taxi: yellow, an orange stripe down each side, a roof sign.
  taxi(h) {
    car(h, 0xffc72c, 0.95, 0, false);
    for (const s of [-1, 1]) h.box(0.012, 0.75, 0.03, s * 0.211, 0, 0.12, 0xff9a2e, ROLE.kit);
    h.box(0.16, 0.07, 0.05, 0, 0.06, 0.38, KIT.white, ROLE.kit);
    h.box(0.165, 0.075, 0.015, 0, 0.06, 0.39, 0xff9a2e, ROLE.kit);
    return 0.95;
  },
};

const models = new Map<CarType, CarModel>();

/** The model for cars of `type` (built the first time it's asked for), its length along +x, up +y, centred. */
export function carModel(type: CarType): CarModel {
  let model = models.get(type);
  if (!model) {
    const house = new House();
    const body = BUILDERS[type](house);
    const { geometry } = house.done();
    // The kit's front (our -z) to +x, the way cars travel; to size.
    geometry.rotateY(-Math.PI / 2).scale(SCALE, SCALE, SCALE);
    model = {
      paint: split(geometry, true),
      rest: split(geometry, false),
      length: (body + 0.02) * SCALE,
      lightAt: (body / 2 + 0.006) * SCALE,
      lightHeight: 0.14 * SCALE,
      lightOut: (WIDTH / 2 - 0.055) * SCALE,
      bodyHalfWidth: (WIDTH / 2) * SCALE,
    };
    geometry.dispose();
    models.set(type, model);
  }
  return model;
}

/** The triangles of `geometry` that are paint (role walls), or the rest. */
function split(geometry: BufferGeometry, paint: boolean): BufferGeometry {
  const position = geometry.getAttribute("position");
  const colour = geometry.getAttribute("color");
  const role = geometry.getAttribute("role");
  const [p, c]: number[][] = [[], []];
  for (let i = 0; i < position.count; i++) {
    if ((role.getX(i) === ROLE.walls) !== paint) continue;
    p.push(position.getX(i), position.getY(i), position.getZ(i));
    c.push(colour.getX(i), colour.getY(i), colour.getZ(i));
  }
  const out = new BufferGeometry();
  out.setAttribute("position", new Float32BufferAttribute(p, 3));
  out.setAttribute("color", new Float32BufferAttribute(c, 3));
  return out;
}
