import { BoxGeometry, Color, Group, InstancedMesh, Matrix4, MeshBasicMaterial, Quaternion, Vector3 } from "three";
import { CAR_LENGTH, CAR_WIDTH, type Simulation } from "../core/simulation";

const BODY_HEIGHT = 3;
const CABIN = { length: CAR_LENGTH * 0.5, width: CAR_WIDTH * 0.85, height: 2.2 };
const CABIN_COLOR = 0x1f2933;
/** Indicator lamps: size, colour, and flashes per second (on the simulation clock, so they pause with it). */
const LAMP = { length: 1.6, height: 1.2, width: 1.4 };
const LAMP_COLOR = 0xffa31a;
const BLINK_HZ = 1.5;
/** Cars draw after the flat road layers, with normal depth testing. */
const CAR_ORDER = 20;

/**
 * Draws every car as two instanced boxes (body and cabin), plus flashing indicator lamps at the
 * front and rear corners on the side it's signalling, updated from the simulation each frame.
 */
export class CarLayer extends Group {
  private bodyGeometry = new BoxGeometry(CAR_LENGTH, BODY_HEIGHT, CAR_WIDTH);
  private cabinGeometry = new BoxGeometry(CABIN.length, CABIN.height, CABIN.width);
  private bodyMaterial = new MeshBasicMaterial();
  private cabinMaterial = new MeshBasicMaterial({ color: CABIN_COLOR });
  private lampGeometry = new BoxGeometry(LAMP.length, LAMP.height, LAMP.width);
  private lampMaterial = new MeshBasicMaterial({ color: LAMP_COLOR });
  private lamps: InstancedMesh | null = null;
  private body: InstancedMesh | null = null;
  private cabin: InstancedMesh | null = null;
  private tmpMatrix = new Matrix4();
  private tmpPosition = new Vector3();
  private tmpRotation = new Quaternion();
  private tmpScale = new Vector3(1, 1, 1);
  private tmpUp = new Vector3(0, 1, 0);
  private tmpColor = new Color();

  update(sim: Simulation): void {
    const cars = sim.cars;
    if (!this.body || this.body.instanceMatrix.count < cars.length) this.grow(Math.max(64, cars.length * 2));
    const body = this.body!;
    const cabin = this.cabin!;
    const lamps = this.lamps!;
    const lit = Math.floor(sim.time * BLINK_HZ * 2) % 2 === 0;
    let lampCount = 0;
    cars.forEach((car, i) => {
      const { x, y, heading } = sim.pose(car);
      // World (x, y) is three.js (x, 0, y); turning by -heading about y points the box's length along travel.
      this.tmpRotation.setFromAxisAngle(this.tmpUp, -heading);
      this.tmpPosition.set(x, BODY_HEIGHT / 2, y);
      body.setMatrixAt(i, this.tmpMatrix.compose(this.tmpPosition, this.tmpRotation, this.tmpScale));
      body.setColorAt(i, this.tmpColor.setHex(car.color));
      this.tmpPosition.set(x, BODY_HEIGHT + CABIN.height / 2, y);
      cabin.setMatrixAt(i, this.tmpMatrix.compose(this.tmpPosition, this.tmpRotation, this.tmpScale));

      const side = lit ? sim.signal(car) : 0;
      if (!side) return;
      // Front and rear corners on the signalling side (+1: right of travel, which is world +y when heading +x).
      const cos = Math.cos(heading);
      const sin = Math.sin(heading);
      const across = side * (CAR_WIDTH / 2);
      for (const along of [CAR_LENGTH / 2 - LAMP.length / 2, -(CAR_LENGTH / 2 - LAMP.length / 2)]) {
        this.tmpPosition.set(x + cos * along - sin * across, BODY_HEIGHT * 0.65, y + sin * along + cos * across);
        lamps.setMatrixAt(lampCount++, this.tmpMatrix.compose(this.tmpPosition, this.tmpRotation, this.tmpScale));
      }
    });
    body.count = cabin.count = cars.length;
    lamps.count = lampCount;
    body.instanceMatrix.needsUpdate = cabin.instanceMatrix.needsUpdate = lamps.instanceMatrix.needsUpdate = true;
    if (body.instanceColor) body.instanceColor.needsUpdate = true;
  }

  private grow(capacity: number): void {
    for (const mesh of [this.body, this.cabin, this.lamps]) {
      if (!mesh) continue;
      this.remove(mesh);
      mesh.dispose();
    }
    this.body = new InstancedMesh(this.bodyGeometry, this.bodyMaterial, capacity);
    this.cabin = new InstancedMesh(this.cabinGeometry, this.cabinMaterial, capacity);
    this.lamps = new InstancedMesh(this.lampGeometry, this.lampMaterial, capacity * 2);
    this.body.setColorAt(0, this.tmpColor.setHex(0xffffff));
    for (const mesh of [this.body, this.cabin, this.lamps]) {
      mesh.renderOrder = CAR_ORDER;
      // Instances move every frame; their combined bounds aren't worth recomputing.
      mesh.frustumCulled = false;
      this.add(mesh);
    }
  }

  dispose(): void {
    this.body?.dispose();
    this.cabin?.dispose();
    this.lamps?.dispose();
    this.lampGeometry.dispose();
    this.lampMaterial.dispose();
    this.bodyGeometry.dispose();
    this.cabinGeometry.dispose();
    this.bodyMaterial.dispose();
    this.cabinMaterial.dispose();
  }
}
