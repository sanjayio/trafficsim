import { BufferGeometry, Float32BufferAttribute, Mesh, type MeshBasicMaterial } from "three";
import { COVERED } from "../core/grade";
import type { Car, Simulation } from "../core/simulation";
import { FlatLayer, flatMaterial } from "./flat";

const COLOR = 0x3b82f6;
const WIDTH = 2.5;
/** Spacing of the points the line follows, in world units. */
const STEP = 3;
/** Just above the road (or bridge deck) it lies on. */
const LIFT = 0.2;

/** The selected car's route: a blue line along the lanes it will drive, from the car to where its trip ends. */
export class RouteLine extends Mesh<BufferGeometry, MeshBasicMaterial> {
  constructor() {
    super(new BufferGeometry(), flatMaterial(COLOR, 0.85));
    this.renderOrder = FlatLayer.overlay;
    this.frustumCulled = false;
    this.visible = false;
  }

  /** Redraws the rest of `car`'s route, or hides the line when null. */
  update(sim: Simulation, car: Car | null): void {
    this.visible = car !== null;
    if (!car) return;
    const points = sim.routeAhead(car, STEP);
    const positions: number[] = [];
    const indices: number[] = [];
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i];
      const b = points[i + 1];
      // Out of sight where a tunnel's covered.
      if (a.h < COVERED && b.h < COVERED) continue;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 1e-3) continue;
      const nx = (-(b.y - a.y) / len) * (WIDTH / 2);
      const ny = ((b.x - a.x) / len) * (WIDTH / 2);
      const base = positions.length / 3;
      positions.push(a.x + nx, a.h + LIFT, a.y + ny, b.x + nx, b.h + LIFT, b.y + ny, b.x - nx, b.h + LIFT, b.y - ny, a.x - nx, a.h + LIFT, a.y - ny);
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    this.geometry.dispose();
    this.geometry = new BufferGeometry();
    this.geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
    this.geometry.setIndex(indices);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
