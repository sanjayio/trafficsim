import { AdditiveBlending, BoxGeometry, CanvasTexture, Color, Float32BufferAttribute, Group, InstancedMesh, Matrix4, MeshBasicMaterial, PlaneGeometry, Quaternion, Vector3 } from "three";
import { COVERED } from "../core/grade";
import { CAR_LENGTH, CAR_WIDTH, type CarType, type Simulation } from "../core/simulation";

/**
 * Each type's shape: overall length, body height (above the wheels' clearance), and the glass
 * greenhouse's length, offset back from the middle, and height. All fit the simulation's
 * CAR_LENGTH × CAR_WIDTH, which spaces cars.
 */
const SHAPES: Record<CarType, { length: number; body: number; cabin: number; back: number; glass: number }> = {
  sedan: { length: CAR_LENGTH, body: 2.4, cabin: 6.4, back: 0.6, glass: 1.9 },
  hatch: { length: CAR_LENGTH * 0.88, body: 2.6, cabin: 6.6, back: 1.6, glass: 2.1 },
  suv: { length: CAR_LENGTH, body: 3.4, cabin: 8.6, back: 1.4, glass: 2.4 },
};
/** Body height off the ground (the wheels show below it), and the wheels' size. */
const CLEARANCE = 0.9;
const WHEEL = { length: 2.8, height: 2.2, inset: 2.6 };
const GLASS_COLOR = 0x26323f;
const WHEEL_COLOR = 0x141518;
const DRL_COLOR = 0xf4f8ff;
/** Tail lights: dim while driving, bright on the brakes (slowing or held stopped), off when parked. */
const TAIL = { running: 0x8e0f17, braking: 0xff2b2b, off: 0x2a1012 };
/** Slowing faster than this (units/s²) counts as braking. */
const BRAKING = 2;
/** Indicator lamps: size, colour, and flashes per second (on the simulation clock, so they pause with it). */
const LAMP = { length: 1.6, height: 1.2, width: 1.4 };
const LAMP_COLOR = 0xffa31a;
const BLINK_HZ = 1.5;
/** Cars draw after the flat road layers, with normal depth testing. */
const CAR_ORDER = 20;

type Part = "body" | "glass" | "roof" | "wheels" | "drl" | "tail" | "lamps" | "beams";
/** Boxes of each part per car (lamps: up to two, on the side signalling; beams: the pool of headlight on the road, at night). */
const PER_CAR: Record<Part, number> = { body: 1, glass: 1, roof: 1, wheels: 2, drl: 2, tail: 2, lamps: 2, beams: 1 };
/** Headlights' pool of light on the road ahead: its length and width, and colour at full strength. */
const BEAM = { length: 28, width: 18 };
const BEAM_COLOR = 0xffe6a8;
/** Draws after the road layers, before cars. */
const BEAM_ORDER = 15;

/**
 * Draws every car from a few instanced unit boxes, stretched per car to its type (sedan, hatch,
 * SUV): body and roof in its paint, glass, wheels, daytime running lights, tail lights, and
 * flashing indicators on the side it's signalling. One draw call per part, however many cars.
 */
export class CarLayer extends Group {
  private box = shadedBox();
  private materials: Record<Part, MeshBasicMaterial> = {
    body: shaded(0xffffff),
    glass: shaded(GLASS_COLOR),
    roof: shaded(0xffffff),
    wheels: shaded(WHEEL_COLOR),
    // Lights glow: the same from every side, and as bright at night (no tone mapping).
    drl: new MeshBasicMaterial({ color: DRL_COLOR, toneMapped: false }),
    tail: new MeshBasicMaterial({ toneMapped: false }),
    lamps: new MeshBasicMaterial({ color: LAMP_COLOR, toneMapped: false }),
    beams: new MeshBasicMaterial({
      color: BEAM_COLOR,
      map: beamTexture(),
      transparent: true,
      opacity: 0,
      blending: AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    }),
  };
  /** A unit square lying on the ground, for the headlight pools. */
  private plane = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  private meshes: Partial<Record<Part, InstancedMesh>> = {};
  private capacity = 0;
  private tmpMatrix = new Matrix4();
  private tmpPosition = new Vector3();
  private tmpRotation = new Quaternion();
  private tmpScale = new Vector3();
  private tmpUp = new Vector3(0, 1, 0);
  private tmpColor = new Color();

  /** Places every car; `night` (0–1) turns the headlights on. */
  update(sim: Simulation, night: number): void {
    const cars = sim.cars;
    if (!this.meshes.body || this.capacity < cars.length) this.grow(Math.max(64, cars.length * 2));
    const m = this.meshes as Record<Part, InstancedMesh>;
    const counts: Record<Part, number> = { body: 0, glass: 0, roof: 0, wheels: 0, drl: 0, tail: 0, lamps: 0, beams: 0 };
    this.materials.beams.opacity = night * 0.32;
    const lit = Math.floor(sim.time * BLINK_HZ * 2) % 2 === 0;
    for (const car of cars) {
      // Parked underground: out of sight.
      if (car.leaveAt !== null && car.legs[car.leg].underground) continue;
      const { x, y, heading } = sim.pose(car);
      // Up on a bridge or down in a tunnel; out of sight where the tunnel's covered.
      const lift = sim.heightOf(car);
      if (lift < COVERED) continue;
      const shape = SHAPES[car.type];
      const cos = Math.cos(heading);
      const sin = Math.sin(heading);
      // World (x, y) is three.js (x, 0, y); turning by -heading about y points a box's length along travel.
      this.tmpRotation.setFromAxisAngle(this.tmpUp, -heading);
      // A box of (length, height, width) centred `along` ahead of the car's middle, `across` to its right, from height `base` up.
      const put = (part: Part, along: number, across: number, base: number, length: number, height: number, width: number) => {
        this.tmpPosition.set(x + cos * along - sin * across, lift + base + height / 2, y + sin * along + cos * across);
        this.tmpScale.set(length, height, width);
        m[part].setMatrixAt(counts[part]++, this.tmpMatrix.compose(this.tmpPosition, this.tmpRotation, this.tmpScale));
      };
      const half = shape.length / 2;
      const top = CLEARANCE + shape.body;
      this.tmpColor.setHex(car.color);
      m.body.setColorAt(counts.body, this.tmpColor);
      m.roof.setColorAt(counts.roof, this.tmpColor);
      put("body", 0, 0, CLEARANCE, shape.length, shape.body, CAR_WIDTH);
      const parked = car.leaveAt !== null;
      this.tmpColor.setHex(parked ? TAIL.off : car.accel < -BRAKING || car.v < 0.5 ? TAIL.braking : TAIL.running);
      m.tail.setColorAt(counts.tail, this.tmpColor);
      m.tail.setColorAt(counts.tail + 1, this.tmpColor);
      // Glass all round the cabin, with a slightly smaller roof in the paint on top: windows show at the sides, front and back.
      put("glass", -shape.back, 0, top, shape.cabin, shape.glass, CAR_WIDTH * 0.86);
      put("roof", -shape.back, 0, top + shape.glass, shape.cabin - 1.2, 0.35, CAR_WIDTH * 0.8);
      for (const along of [half - WHEEL.inset, -(half - WHEEL.inset)]) put("wheels", along, 0, 0, WHEEL.length, WHEEL.height, CAR_WIDTH + 0.3);
      for (const side of [1, -1]) {
        if (!parked) put("drl", half + 0.05, side * (CAR_WIDTH / 2 - 1.1), top - 1, 0.3, 0.45, 1.8);
        put("tail", -half - 0.05, side * (CAR_WIDTH / 2 - 1.1), top - 1.1, 0.3, 0.7, 1.6);
      }
      if (night > 0 && !parked) put("beams", half + BEAM.length / 2 - 1, 0, 0.05, BEAM.length, 1, BEAM.width);
      const side = lit ? sim.signal(car) : 0;
      if (!side) continue;
      // Front and rear corners on the signalling side (+1: right of travel, which is world +y when heading +x).
      for (const along of [half - LAMP.length / 2, -(half - LAMP.length / 2)]) {
        put("lamps", along, side * (CAR_WIDTH / 2), top - 1.4, LAMP.length, LAMP.height, LAMP.width);
      }
    }
    for (const part of Object.keys(counts) as Part[]) {
      m[part].count = counts[part];
      m[part].instanceMatrix.needsUpdate = true;
      if (m[part].instanceColor) m[part].instanceColor!.needsUpdate = true;
    }
  }

  private grow(capacity: number): void {
    this.capacity = capacity;
    for (const part of Object.keys(PER_CAR) as Part[]) {
      const old = this.meshes[part];
      if (old) {
        this.remove(old);
        old.dispose();
      }
      const mesh = new InstancedMesh(part === "beams" ? this.plane : this.box, this.materials[part], capacity * PER_CAR[part]);
      // Painted parts take their colour per car.
      if (part === "body" || part === "roof" || part === "tail") mesh.setColorAt(0, this.tmpColor.setHex(0xffffff));
      mesh.renderOrder = part === "beams" ? BEAM_ORDER : CAR_ORDER;
      mesh.castShadow = part === "body" || part === "glass" || part === "roof" || part === "wheels";
      // Instances move every frame; their combined bounds aren't worth recomputing.
      mesh.frustumCulled = false;
      this.meshes[part] = mesh;
      this.add(mesh);
    }
  }

  dispose(): void {
    for (const mesh of Object.values(this.meshes)) mesh.dispose();
    for (const material of Object.values(this.materials)) material.dispose();
    this.box.dispose();
    this.plane.dispose();
    this.materials.beams.map?.dispose();
  }
}

/** A material whose colour is darkened per face by the box's vertex colours (the scene has no lights). */
function shaded(color: number): MeshBasicMaterial {
  return new MeshBasicMaterial({ color, vertexColors: true });
}

/** A unit box with light from above baked into its vertex colours: top lit, ends a step darker, sides darker still. */
function shadedBox(): BoxGeometry {
  const box = new BoxGeometry(1, 1, 1);
  // BoxGeometry's faces, 4 vertices each, in order: +x, -x, +y, -y, +z, -z.
  const tones = [0.82, 0.82, 1, 0.5, 0.68, 0.68];
  const colors = tones.flatMap((t) => Array(12).fill(t) as number[]);
  box.setAttribute("color", new Float32BufferAttribute(colors, 3));
  return box;
}

/**
 * A headlight pool, seen from above with the car at the left: brightest just ahead of the car,
 * fading with distance and towards the sides, widening as it goes. Black adds no light.
 */
function beamTexture(): CanvasTexture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const along = x / (size - 1);
      const across = Math.abs(y / (size - 1) - 0.5) * 2;
      const spread = 0.6 + 0.4 * along;
      const v = Math.max(0, 1 - across / spread) ** 1.5 * (1 - along) ** 1.2 * Math.min(1, along * 6);
      const i = (y * size + x) * 4;
      image.data[i] = image.data[i + 1] = image.data[i + 2] = Math.round(v * 255);
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return new CanvasTexture(canvas);
}
