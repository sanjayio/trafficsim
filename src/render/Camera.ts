import { PerspectiveCamera, Plane, Raycaster, Vector2, Vector3, type Object3D } from "three";
import type { Vec2 } from "../core/geometry";

const FOV_DEGREES = 45;
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 4;
/** Camera pitch limits, in radians above the ground plane. 90° is straight down (top-down); low enough to see the sky. */
const MIN_PITCH = (5 * Math.PI) / 180;
/** Zooming and drag-panning hold the ground under the pointer only this many orbit distances from the focus (not out at the horizon). */
const GRAB_REACH = 4;
const MAX_PITCH = Math.PI / 2;
/** Keyboard pan speed in screen pixels per second at the focus point, so it feels the same at every zoom level. */
const KEY_PAN_SPEED = 800;
/** Keyboard rotation speed in radians per second. */
const KEY_ROTATE_SPEED = Math.PI / 2;
/** Keyboard zoom speed: zoom is multiplied by e^this per second (~3.3x). */
const KEY_ZOOM_SPEED = 1.2;
/** Keyboard tilt speed in radians per second. */
const KEY_TILT_SPEED = (60 * Math.PI) / 180;
/** Shift multiplies all keyboard camera speeds by this. */
const KEY_FAST_MULTIPLIER = 2.5;

// Physical key codes, so the keys keep their position on non-QWERTY layouts.
const PAN_UP = ["KeyW", "ArrowUp"];
const PAN_DOWN = ["KeyS", "ArrowDown"];
const PAN_LEFT = ["KeyA", "ArrowLeft"];
const PAN_RIGHT = ["KeyD", "ArrowRight"];
const ROTATE_CCW = ["KeyQ"];
const ROTATE_CW = ["KeyE"];
const ZOOM_IN = ["KeyR"];
const ZOOM_OUT = ["KeyF"];
const TILT_DOWN = ["KeyT"];
const TILT_UP = ["KeyG"];
const CAMERA_KEYS = new Set([
  ...PAN_UP,
  ...PAN_DOWN,
  ...PAN_LEFT,
  ...PAN_RIGHT,
  ...ROTATE_CCW,
  ...ROTATE_CW,
  ...ZOOM_IN,
  ...ZOOM_OUT,
  ...TILT_DOWN,
  ...TILT_UP,
]);

function isTextInput(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

/**
 * Orbit camera around a focus point on the ground. World (x, y) is the ground plane,
 * three.js (x, 0, y), viewed from above with +y pointing down the screen at yaw 0.
 *
 * - Zoom sets the orbit distance so that, looking straight down, 1 world unit = `zoom` screen pixels.
 * - Tilt (pitch) orbits around the focus point, which stays at the screen centre; rotation (yaw)
 *   by key turns on the spot, the camera staying where it stands.
 * - Screen → world goes through a ray cast onto the ground plane, so it's exact at any angle.
 *
 * Pan: middle/right drag anywhere, left drag when `leftDragPans()` is true, or WASD / arrow keys.
 * Rotate: Q (anticlockwise) / E (clockwise). Zoom: wheel / pinch at the cursor, R (in) / F (out) at the centre.
 * Tilt: T (towards 5°, more 3D, the horizon and sky in view) / G (back towards 90°, top-down).
 * Hold Shift for faster keyboard movement. Keyboard input is applied in `update()`, called once per frame.
 */
export class Camera {
  readonly camera = new PerspectiveCamera(FOV_DEGREES, 1, 1, 10_000);

  private focus: Vec2 = { x: 0, y: 0 };
  private yaw = 0;
  private pitch = MAX_PITCH;
  private zoomLevel = 1;
  private width = 1;
  private height = 1;

  private panning = false;
  /** Ground point held under the cursor while drag-panning. */
  private grabbed: Vec2 | null = null;
  private heldKeys = new Set<string>();
  private fast = false;

  private raycaster = new Raycaster();
  private ground = new Plane(new Vector3(0, 1, 0), 0);
  private ndc = new Vector2();
  private hit = new Vector3();
  private projected = new Vector3();

  constructor(
    private element: HTMLElement,
    private leftDragPans: () => boolean,
  ) {
    element.addEventListener("pointerdown", this.onDown);
    element.addEventListener("pointermove", this.onMove);
    element.addEventListener("pointerup", this.onUp);
    element.addEventListener("pointercancel", this.onUp);
    element.addEventListener("wheel", this.onWheel, { passive: false });
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.releaseKeys);
    this.apply();
  }

  get isPanning(): boolean {
    return this.panning;
  }

  get zoom(): number {
    return this.zoomLevel;
  }

  /** Distance from the camera to the focus point, in world units. */
  /** Where the camera is: its focus, turn, tilt and zoom (to keep between visits). */
  get view(): { x: number; y: number; yaw: number; pitch: number; zoom: number } {
    return { x: this.focus.x, y: this.focus.y, yaw: this.yaw, pitch: this.pitch, zoom: this.zoomLevel };
  }

  /** Puts the camera back where `view` says, ignoring anything missing or out of range. */
  setView(view: Record<string, unknown>): void {
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const [x, y, yaw, pitch, zoom] = ["x", "y", "yaw", "pitch", "zoom"].map((k) => num(view[k]));
    if (x !== null && y !== null) this.focus = { x, y };
    if (yaw !== null) this.yaw = yaw;
    if (pitch !== null) this.pitch = Math.min(MAX_PITCH, Math.max(MIN_PITCH, pitch));
    if (zoom !== null) this.zoomLevel = this.clampZoom(zoom);
    this.apply();
  }

  /** The ground point the camera orbits, at the screen's centre. */
  get target(): Vec2 {
    return this.focus;
  }

  get distance(): number {
    const halfFov = (FOV_DEGREES * Math.PI) / 360;
    return this.height / 2 / Math.tan(halfFov) / this.zoomLevel;
  }

  setViewport(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.camera.aspect = this.width / this.height;
    this.apply();
  }

  centerOn(x: number, y: number): void {
    this.focus = { x, y };
    this.apply();
  }

  /** The ground point under screen point `s` (canvas pixels), or null if that ray misses the ground; or where it meets a level `height` up (a bridge's deck). */
  screenToWorld(s: Vec2, height = 0): Vec2 | null {
    this.ndc.set((s.x / this.width) * 2 - 1, -(s.y / this.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    this.ground.constant = -height;
    const hit = this.raycaster.ray.intersectPlane(this.ground, this.hit);
    return hit ? { x: hit.x, y: hit.z } : null;
  }

  /** The nearest of `objects` (or their children) under screen point `s`. */
  pick(s: Vec2, objects: Object3D[]): Object3D | null {
    this.ndc.set((s.x / this.width) * 2 - 1, -(s.y / this.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    return this.raycaster.intersectObjects(objects)[0]?.object ?? null;
  }

  /** Screen position (canvas pixels) of ground point `w`, or of the point `height` above it. */
  worldToScreen(w: Vec2, height = 0): Vec2 {
    const v = this.projected.set(w.x, height, w.y).project(this.camera);
    return { x: ((v.x + 1) / 2) * this.width, y: ((1 - v.y) / 2) * this.height };
  }

  /** Applies keyboard camera movement for this frame. Returns true if the camera moved. */
  update(deltaMS: number): boolean {
    const held = (codes: string[]) => (codes.some((c) => this.heldKeys.has(c)) ? 1 : 0);
    const speedScale = ((this.fast ? KEY_FAST_MULTIPLIER : 1) * deltaMS) / 1000;
    const right = held(PAN_RIGHT) - held(PAN_LEFT);
    const forward = held(PAN_UP) - held(PAN_DOWN);
    // Q turns the view anticlockwise (to the left), E clockwise.
    const spin = held(ROTATE_CW) - held(ROTATE_CCW);
    const zoomDir = held(ZOOM_IN) - held(ZOOM_OUT);
    const tiltDir = held(TILT_UP) - held(TILT_DOWN);
    let moved = false;

    if (right !== 0 || forward !== 0) {
      const length = Math.hypot(right, forward);
      const step = ((KEY_PAN_SPEED / this.zoomLevel) * speedScale) / length;
      const { forward: f, right: r } = this.groundAxes();
      this.focus = {
        x: this.focus.x + (r.x * right + f.x * forward) * step,
        y: this.focus.y + (r.y * right + f.y * forward) * step,
      };
      moved = true;
    }

    if (spin !== 0) {
      // Turning on the spot: the camera stays where it stands and the view swings round it.
      const back = this.distance * Math.cos(this.pitch);
      const before = this.groundAxes().forward;
      const stand = { x: this.focus.x - before.x * back, y: this.focus.y - before.y * back };
      this.yaw = (this.yaw + spin * KEY_ROTATE_SPEED * speedScale) % (Math.PI * 2);
      const after = this.groundAxes().forward;
      this.focus = { x: stand.x + after.x * back, y: stand.y + after.y * back };
      moved = true;
    }

    if (zoomDir !== 0) {
      const zoom = this.clampZoom(this.zoomLevel * Math.exp(zoomDir * KEY_ZOOM_SPEED * speedScale));
      moved ||= zoom !== this.zoomLevel;
      this.zoomLevel = zoom;
    }

    if (tiltDir !== 0) {
      const pitch = Math.min(MAX_PITCH, Math.max(MIN_PITCH, this.pitch + tiltDir * KEY_TILT_SPEED * speedScale));
      moved ||= pitch !== this.pitch;
      this.pitch = pitch;
    }

    if (moved) this.apply();
    return moved;
  }

  /** Unit vectors on the ground for "up the screen" and "right on the screen". */
  private groundAxes(): { forward: Vec2; right: Vec2 } {
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    return { forward: { x: sin, y: -cos }, right: { x: cos, y: sin } };
  }

  /** Recomputes the three.js camera from focus, yaw, pitch and zoom. */
  private apply(): void {
    const d = this.distance;
    const { forward } = this.groundAxes();
    const back = d * Math.cos(this.pitch);
    this.camera.position.set(this.focus.x - forward.x * back, d * Math.sin(this.pitch), this.focus.y - forward.y * back);
    // "Up" on screen is the forward ground direction; this stays valid even looking straight down.
    this.camera.up.set(forward.x, 0, forward.y);
    this.camera.lookAt(this.focus.x, 0, this.focus.y);
    this.camera.near = d * 0.05;
    this.camera.far = d * 20;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }

  /** The ground under screen point `s`, if it's near enough to hold while zooming or panning. */
  private grabAt(s: Vec2): Vec2 | null {
    const p = this.screenToWorld(s);
    return p && Math.hypot(p.x - this.focus.x, p.y - this.focus.y) < this.distance * GRAB_REACH ? p : null;
  }

  private clampZoom(zoom: number): number {
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
  }

  private toCanvas(e: MouseEvent): Vec2 {
    const rect = this.element.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  /** Shifts the focus so ground point `held` ends up under screen point `s`. */
  private keepUnder(held: Vec2, s: Vec2): void {
    const now = this.screenToWorld(s);
    if (!now) return;
    this.focus = { x: this.focus.x + held.x - now.x, y: this.focus.y + held.y - now.y };
    this.apply();
  }

  private onKeyDown = (e: KeyboardEvent) => {
    this.fast = e.shiftKey;
    // macOS doesn't deliver keyup for keys released while Cmd is held, so drop everything instead.
    // Alt is fine (and is held to flip road snapping), so it doesn't block camera keys.
    if (e.metaKey || e.ctrlKey) return this.releaseKeys();
    if (!CAMERA_KEYS.has(e.code) || isTextInput(e.target)) return;
    e.preventDefault();
    this.heldKeys.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.fast = e.shiftKey;
    this.heldKeys.delete(e.code);
  };

  private releaseKeys = () => {
    this.heldKeys.clear();
    this.fast = false;
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const s = this.toCanvas(e);
    const anchor = this.grabAt(s);
    this.zoomLevel = this.clampZoom(this.zoomLevel * Math.exp(-e.deltaY * 0.0015));
    this.apply();
    if (anchor) this.keepUnder(anchor, s);
  };

  private onDown = (e: PointerEvent) => {
    if (e.button === 1 || e.button === 2 || (e.button === 0 && this.leftDragPans())) {
      this.panning = true;
      this.grabbed = this.grabAt(this.toCanvas(e));
    }
  };

  private onMove = (e: PointerEvent) => {
    if (!this.panning) return;
    const s = this.toCanvas(e);
    if (this.grabbed) this.keepUnder(this.grabbed, s);
    else this.grabbed = this.grabAt(s);
  };

  private onUp = () => {
    this.panning = false;
    this.grabbed = null;
  };

  destroy(): void {
    this.element.removeEventListener("pointerdown", this.onDown);
    this.element.removeEventListener("pointermove", this.onMove);
    this.element.removeEventListener("pointerup", this.onUp);
    this.element.removeEventListener("pointercancel", this.onUp);
    this.element.removeEventListener("wheel", this.onWheel);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.releaseKeys);
  }
}
