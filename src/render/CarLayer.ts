import { AdditiveBlending, BoxGeometry, CanvasTexture, Color, Float32BufferAttribute, Group, InstancedMesh, Matrix4, MeshBasicMaterial, PlaneGeometry, Quaternion, Vector3 } from "three";
import { CAR_TYPES, type CarType, type Simulation } from "../core/simulation";
import { carModel } from "./cars";

const DRL_COLOR = 0xf4f8ff;
/** Tail lights: dim while driving, bright on the brakes (slowing or held stopped), off when parked. */
const TAIL = { running: 0x8e0f17, braking: 0xff2b2b, off: 0x2a1012 };
/** Slowing faster than this (units/s²) counts as braking. */
const BRAKING = 2;
/** Indicator lamps: size, colour, and flashes per second (on the simulation clock, so they pause with it). */
const LAMP = { length: 0.7, height: 0.45, width: 0.5 };
const LAMP_COLOR = 0xffa31a;
const BLINK_HZ = 1.5;
/** Cars draw after the flat road layers, with normal depth testing. */
const CAR_ORDER = 20;

/** The car itself, per type: its paint (tinted per car) and the rest (see `cars`). */
type Body = `${CarType}:${"paint" | "rest"}`;
/** Each type's paint and rest; a type painted all its own colours (a taxi) has no paint. */
const BODIES = CAR_TYPES.flatMap((type) => [...(carModel(type).paint.getAttribute("position").count ? [`${type}:paint`] : []), `${type}:rest`] as Body[]);
type Part = Body | "drl" | "tail" | "lamps" | "beams";
/** Instances of each part per car (lamps: up to two, on the side signalling; beams: the pool of headlight on the road, at night). */
const PER_CAR: Record<Part, number> = { ...(Object.fromEntries(BODIES.map((b) => [b, 1])) as Record<Body, number>), drl: 2, tail: 2, lamps: 2, beams: 1 };
/** Headlights' pool of light on the road ahead: its length and width, and colour at full strength. */
const BEAM = { length: 28, width: 18 };
const BEAM_COLOR = 0xffe6a8;
/** Draws after the road layers, before cars. */
const BEAM_ORDER = 15;

/**
 * Draws every car, each its type's kit model (see `cars`) in its own paint, with daytime running
 * lights, tail lights, and flashing indicators on the side it's signalling, from boxes. One draw
 * call per part, however many cars.
 */
export class CarLayer extends Group {
  private box = shadedBox();
  private materials: Record<Part, MeshBasicMaterial> = {
    ...(Object.fromEntries(BODIES.map((b) => [b, new MeshBasicMaterial({ vertexColors: true })])) as Record<Body, MeshBasicMaterial>),
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
    if (!this.meshes.drl || this.capacity < cars.length) this.grow(Math.max(64, cars.length * 2));
    const m = this.meshes as Record<Part, InstancedMesh>;
    const counts = Object.fromEntries(Object.keys(PER_CAR).map((p) => [p, 0])) as Record<Part, number>;
    this.materials.beams.opacity = night * 0.32;
    const lit = Math.floor(sim.time * BLINK_HZ * 2) % 2 === 0;
    for (const car of cars) {
      // Parked underground: out of sight.
      if (car.leaveAt !== null && car.legs[car.leg].underground) continue;
      const { x, y, heading } = sim.pose(car);
      // Up on a bridge or down in a tunnel (the ground hides it there, but in the underground view).
      const lift = sim.heightOf(car);
      const shape = carModel(car.type);
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
      // The car: its model where it stands, its paint in its colour.
      this.tmpPosition.set(x, lift, y);
      this.tmpScale.set(1, 1, 1);
      this.tmpMatrix.compose(this.tmpPosition, this.tmpRotation, this.tmpScale);
      const paint = m[`${car.type}:paint`] as InstancedMesh | undefined;
      if (paint) {
        paint.setColorAt(counts[`${car.type}:paint`], this.tmpColor.setHex(car.color));
        paint.setMatrixAt(counts[`${car.type}:paint`]++, this.tmpMatrix);
      }
      m[`${car.type}:rest`].setMatrixAt(counts[`${car.type}:rest`]++, this.tmpMatrix);
      const light = shape.lightHeight;
      const parked = car.leaveAt !== null;
      this.tmpColor.setHex(parked ? TAIL.off : car.accel < -BRAKING || car.v < 0.5 ? TAIL.braking : TAIL.running);
      m.tail.setColorAt(counts.tail, this.tmpColor);
      m.tail.setColorAt(counts.tail + 1, this.tmpColor);
      // Head and tail lights where the kit has them, either side at the front and back.
      for (const side of [1, -1]) {
        if (!parked) put("drl", shape.lightAt, side * shape.lightOut, light - 0.3, 0.3, 0.6, 1.2);
        put("tail", -shape.lightAt, side * shape.lightOut, light - 0.3, 0.3, 0.6, 1);
      }
      if (night > 0 && !parked) put("beams", half + BEAM.length / 2 - 1, 0, 0.05, BEAM.length, 1, BEAM.width);
      const side = lit ? sim.signal(car) : 0;
      if (!side) continue;
      // Front and rear corners on the signalling side (+1: right of travel, which is world +y when heading +x).
      // Small lamps on the body's corners, at headlight height, just proud of its front, back and side.
      for (const along of [shape.lightAt - LAMP.length / 2 + 0.1, -(shape.lightAt - LAMP.length / 2 + 0.1)]) {
        put("lamps", along, side * (shape.bodyHalfWidth - LAMP.width / 2 + 0.1), shape.lightHeight - LAMP.height / 2, LAMP.length, LAMP.height, LAMP.width);
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
      const [type, piece] = part.split(":") as [CarType, "paint" | "rest" | undefined];
      const geometry = piece ? carModel(type)[piece] : part === "beams" ? this.plane : this.box;
      const mesh = new InstancedMesh(geometry, this.materials[part], capacity * PER_CAR[part]);
      // Paint and tail lights take their colour per car.
      if (piece === "paint" || part === "tail") mesh.setColorAt(0, this.tmpColor.setHex(0xffffff));
      mesh.renderOrder = part === "beams" ? BEAM_ORDER : CAR_ORDER;
      mesh.castShadow = !!piece;
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
