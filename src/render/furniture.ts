import {
  BoxGeometry,
  CircleGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  Shape,
  ShapeGeometry,
  type BufferGeometry,
  type Material,
} from "three";
import type { SignalLight } from "../core/junction";
import type { Vec2 } from "../core/geometry";

/** Street furniture is drawn after the flat road layers, with normal depth testing. */
const FURNITURE_ORDER = 20;

const POLE_RADIUS = 0.7;
const SIGN_HEIGHT = 15;
const SIGN_RADIUS = 4.2;
const SIGNAL_HEIGHT = 19;
const HEAD = { width: 4, height: 11, depth: 2.4 };
const LAMP_RADIUS = 1.4;
/** Vertical spacing of the three lamps in a signal head. */
const LAMP_SPACING = 3.4;

/** One approach's sign or signal: where it stands and which way it faces (towards oncoming traffic). */
export interface FurnitureSpot {
  position: Vec2;
  facing: Vec2;
}

const LIGHTS: SignalLight[] = ["red", "yellow", "green"];
const LAMP_ON: Record<SignalLight, number> = { red: 0xff3b30, yellow: 0xffc400, green: 0x34c759 };
const LAMP_OFF: Record<SignalLight, number> = { red: 0x3a1512, yellow: 0x3a3010, green: 0x123a1c };

/**
 * Builds and owns the geometry and materials shared by all signs and signals, and creates
 * placed groups of them. Signals are returned with their lamps so lights can be switched.
 */
export class FurnitureKit {
  private geometries = {
    pole: new CylinderGeometry(POLE_RADIUS, POLE_RADIUS, 1, 8),
    octagon: new CircleGeometry(SIGN_RADIUS, 8),
    triangle: new CircleGeometry(SIGN_RADIUS * 1.25, 3),
    triangleInner: new CircleGeometry(SIGN_RADIUS * 0.8, 3),
    head: new BoxGeometry(HEAD.width, HEAD.height, HEAD.depth),
    lamp: new CircleGeometry(LAMP_RADIUS, 16),
    arrow: arrowGeometry(),
  };
  private materials = {
    pole: new MeshBasicMaterial({ color: 0x9aa0a6 }),
    /** Bare metal on the back of sign plates. */
    signBack: new MeshBasicMaterial({ color: 0x7d838a }),
    stop: new MeshBasicMaterial({ color: 0xd62d20 }),
    white: new MeshBasicMaterial({ color: 0xf4f4f4 }),
    yieldBorder: new MeshBasicMaterial({ color: 0xd62d20 }),
    head: new MeshBasicMaterial({ color: 0x1b1d20 }),
    lampOn: mapLights((l) => new MeshBasicMaterial({ color: LAMP_ON[l] })),
    lampOff: mapLights((l) => new MeshBasicMaterial({ color: LAMP_OFF[l] })),
  };

  stopSign(spot: FurnitureSpot): Group {
    const group = this.post(spot, SIGN_HEIGHT);
    // Flat top, like a real stop sign.
    this.plate(group, this.geometries.octagon, this.materials.stop, Math.PI / 8, 0.1);
    this.plateBack(group, this.geometries.octagon, Math.PI / 8);
    return group;
  }

  yieldSign(spot: FurnitureSpot): Group {
    const group = this.post(spot, SIGN_HEIGHT);
    // Point-down triangle: red border with a white centre.
    this.plate(group, this.geometries.triangle, this.materials.yieldBorder, -Math.PI / 2, 0.1);
    this.plate(group, this.geometries.triangleInner, this.materials.white, -Math.PI / 2, 0.15);
    this.plateBack(group, this.geometries.triangle, -Math.PI / 2);
    return group;
  }

  /**
   * A signal head on a pole; switch its lights with `setLight`. Over the green lamp, a green arrow
   * pointing kerb-side (`kerb`: 1 to the driver's right, -1 left), lit on red where turning that way is allowed.
   */
  signal(spot: FurnitureSpot, kerb: 1 | -1): { group: Group; lamps: Mesh[] } {
    const group = this.post(spot, SIGNAL_HEIGHT);
    const head = this.mesh(this.geometries.head, this.materials.head);
    head.position.set(0, SIGNAL_HEIGHT, POLE_RADIUS + HEAD.depth / 2);
    group.add(head);
    const lamps = LIGHTS.map((light, i) => {
      const lamp = this.mesh(this.geometries.lamp, this.materials.lampOff[light]);
      lamp.position.set(0, SIGNAL_HEIGHT + (1 - i) * LAMP_SPACING, POLE_RADIUS + HEAD.depth + 0.05);
      lamp.userData.light = light;
      group.add(lamp);
      return lamp;
    });
    const arrow = this.mesh(this.geometries.arrow, this.materials.lampOn.green);
    // Local +z faces the driver, so the driver's right is local +x.
    arrow.rotation.z = kerb === 1 ? 0 : Math.PI;
    arrow.position.set(0, SIGNAL_HEIGHT - LAMP_SPACING, POLE_RADIUS + HEAD.depth + 0.1);
    arrow.castShadow = false;
    arrow.visible = false;
    arrow.userData.arrow = true;
    group.add(arrow);
    return { group, lamps: [...lamps, arrow] };
  }

  /**
   * Lights the lamp for `light` and dims the others (only touches lamps that change). On red with
   * `freeTurn` (turning kerb-side on red allowed), the green arrow lights too.
   */
  setLight(lamps: Mesh[], light: SignalLight, freeTurn = false): void {
    for (const lamp of lamps) {
      if (lamp.userData.arrow) {
        lamp.visible = freeTurn && light === "red";
        continue;
      }
      const own = lamp.userData.light as SignalLight;
      const material = own === light ? this.materials.lampOn[own] : this.materials.lampOff[own];
      if (lamp.material !== material) lamp.material = material;
    }
  }

  dispose(): void {
    for (const geometry of Object.values(this.geometries)) geometry.dispose();
    const { lampOn, lampOff, ...rest } = this.materials;
    for (const material of [...Object.values(rest), ...Object.values(lampOn), ...Object.values(lampOff)]) {
      (material as Material).dispose();
    }
  }

  /** A sign face (visible from the front only), `z` in front of the pole, turned `spin` in its plane. */
  private plate(group: Group, geometry: BufferGeometry, material: Material, spin: number, z: number): void {
    const plate = this.mesh(geometry, material);
    plate.rotation.z = spin;
    plate.position.set(0, SIGN_HEIGHT, POLE_RADIUS + z);
    group.add(plate);
  }

  /**
   * The plain metal back of a sign: the same shape facing the other way, just behind the face,
   * so the sign doesn't vanish when seen from behind. Turning it to face backwards mirrors it
   * left-to-right but keeps up as up, so the same `spin` keeps the outline (both shapes are
   * symmetric left-to-right).
   */
  private plateBack(group: Group, geometry: BufferGeometry, spin: number): void {
    const back = this.mesh(geometry, this.materials.signBack);
    back.rotation.set(0, Math.PI, spin);
    back.position.set(0, SIGN_HEIGHT, POLE_RADIUS + 0.05);
    group.add(back);
  }

  /** A pole of `height` at the spot, in a group turned so local +z faces oncoming traffic. */
  private post(spot: FurnitureSpot, height: number): Group {
    const group = new Group();
    group.position.set(spot.position.x, 0, spot.position.y);
    group.lookAt(spot.position.x + spot.facing.x, 0, spot.position.y + spot.facing.y);
    const pole = this.mesh(this.geometries.pole, this.materials.pole);
    pole.scale.y = height;
    pole.position.y = height / 2;
    group.add(pole);
    return group;
  }

  private mesh(geometry: BufferGeometry, material: Material): Mesh {
    const mesh = new Mesh(geometry, material);
    mesh.renderOrder = FURNITURE_ORDER;
    mesh.castShadow = true;
    return mesh;
  }
}

/** An arrow pointing along +x, sized to sit within a lamp. */
function arrowGeometry(): ShapeGeometry {
  const r = LAMP_RADIUS;
  const shape = new Shape()
    .moveTo(-0.8 * r, -0.22 * r)
    .lineTo(0.1 * r, -0.22 * r)
    .lineTo(0.1 * r, -0.6 * r)
    .lineTo(0.85 * r, 0)
    .lineTo(0.1 * r, 0.6 * r)
    .lineTo(0.1 * r, 0.22 * r)
    .lineTo(-0.8 * r, 0.22 * r)
    .closePath();
  return new ShapeGeometry(shape);
}

function mapLights<T>(make: (light: SignalLight) => T): Record<SignalLight, T> {
  return { red: make("red"), yellow: make("yellow"), green: make("green") };
}
