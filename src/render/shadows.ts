import {
  Color,
  DirectionalLight,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  PCFSoftShadowMap,
  PlaneGeometry,
  ShadowMaterial,
  Vector2,
  type Object3D,
  type WebGLRenderer,
} from "three";
import { WORLD_SIZE } from "../core/constants";

/**
 * Shared by every basic material's shader (see `installCloudShadows`), so setting them once
 * moves the cloud shadows everywhere.
 */
const cloudUniforms = {
  sceneTint: { value: new Color(1, 1, 1) },
  cloudShade: { value: 0 },
  cloudCover: { value: 0.3 },
  cloudDrift: { value: new Vector2() },
};

/**
 * The time of day's colour cast and cloud shadows on everything: every MeshBasicMaterial (the
 * whole scene uses them, lit by hand) is tinted, and darkens where drifting cloud noise lies over
 * its world position. Lights (not tone mapped) are left alone. Done once, for all materials, by
 * patching their shader at compile time.
 */
export function installCloudShadows(): void {
  MeshBasicMaterial.prototype.onBeforeCompile = function (this: MeshBasicMaterial, shader) {
    if (!this.toneMapped) return;
    Object.assign(shader.uniforms, cloudUniforms);
    shader.vertexShader = shader.vertexShader
      .replace("void main() {", "varying vec2 vCloudXZ;\nvoid main() {")
      .replace(
        "#include <project_vertex>",
        `#include <project_vertex>
        vec4 cloudWorld = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          cloudWorld = instanceMatrix * cloudWorld;
        #endif
        vCloudXZ = (modelMatrix * cloudWorld).xz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "void main() {",
        `varying vec2 vCloudXZ;
        uniform vec3 sceneTint;
        uniform float cloudShade;
        uniform float cloudCover;
        uniform vec2 cloudDrift;
        float cloudHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float cloudNoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(cloudHash(i), cloudHash(i + vec2(1.0, 0.0)), u.x), mix(cloudHash(i + vec2(0.0, 1.0)), cloudHash(i + vec2(1.0, 1.0)), u.x), u.y);
        }
        void main() {`,
      )
      .replace(
        "#include <tonemapping_fragment>",
        `gl_FragColor.rgb *= sceneTint;
        if (cloudShade > 0.0) {
          vec2 p = vCloudXZ / 900.0 + cloudDrift;
          float n = cloudNoise(p) * 0.55 + cloudNoise(p * 2.1 + 3.7) * 0.3 + cloudNoise(p * 4.3 + 8.1) * 0.15;
          // Patches with soft edges, covering more of the ground the cloudier it is.
          float edge = 0.62 - cloudCover * 0.25;
          gl_FragColor.rgb *= 1.0 - cloudShade * smoothstep(edge, edge + 0.1, n);
        }
        #include <tonemapping_fragment>`,
      );
  };
}

/** Shows the sun's shadows, as dark as `SunShadows` sets them: on the ground, and over raised parts (see `catchShadows`). */
const CATCHER_LIFT = 0.3;
// Both sides, as the road parts it lies over are drawn (their triangles face either way).
const CATCHER = new ShadowMaterial({ opacity: 0.4, depthWrite: false, side: DoubleSide });

/**
 * Shows the sun's shadows on `mesh` (a bridge's deck, which, drawn without lighting,
 * can't take them itself): a clear copy of it that does, over it.
 */
export function catchShadows(mesh: Mesh): void {
  const catcher = new Mesh(mesh.geometry, CATCHER);
  // A little over it, so the deck (which casts too) doesn't shade itself where the sun is low.
  catcher.position.y = CATCHER_LIFT;
  catcher.receiveShadow = true;
  mesh.add(catcher);
}

/**
 * The sun's shadows: a directional light along the sun renders a shadow map from everything that
 * casts (buildings, trees, cars, signs and signals), and a clear layer over the ground, roads and
 * lots shows it. Its shadow camera follows the view, sized to it.
 */
export class SunShadows {
  readonly light = new DirectionalLight(0xffffff, 0);
  readonly catcher: Mesh<PlaneGeometry, ShadowMaterial>;

  constructor(renderer: WebGLRenderer, renderOrder: number) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFSoftShadowMap;
    this.light.castShadow = true;
    this.light.shadow.mapSize.set(2048, 2048);
    this.light.shadow.bias = -0.0004;
    this.catcher = new Mesh(
      new PlaneGeometry(WORLD_SIZE, WORLD_SIZE).rotateX(-Math.PI / 2).translate(WORLD_SIZE / 2, 0, WORLD_SIZE / 2),
      CATCHER,
    );
    this.catcher.receiveShadow = true;
    this.catcher.renderOrder = renderOrder;
  }

  get objects(): Object3D[] {
    return [this.light, this.light.target, this.catcher];
  }

  /**
   * Shadows cast away from `sun` (a unit vector), round ground point (`x`, `z`) for a view `scale`
   * (the camera's orbit distance) across, as dark as `strength` (0 for none).
   */
  update(sun: { x: number; y: number; z: number }, x: number, z: number, scale: number, strength: number): void {
    const on = strength > 0.01 && sun.y > 0.02;
    this.light.castShadow = on;
    this.catcher.visible = on;
    if (!on) return;
    this.catcher.material.opacity = strength;
    const reach = scale * 3;
    this.light.target.position.set(x, 0, z);
    this.light.position.set(x + sun.x * reach, sun.y * reach, z + sun.z * reach);
    const camera = this.light.shadow.camera;
    const half = scale * 1.2;
    camera.left = -half;
    camera.right = half;
    camera.top = half;
    camera.bottom = -half;
    camera.near = 1;
    camera.far = reach * 2;
    camera.updateProjectionMatrix();
    this.light.target.updateMatrixWorld();
  }

  /** The colour cast over the scene (not lights), and cloud shadows: how dark (0 for none), how much of the sky is cloud, and how far they've drifted. */
  static clouds(tint: Color, shade: number, cover: number, drift: Vector2): void {
    cloudUniforms.sceneTint.value.copy(tint);
    cloudUniforms.cloudShade.value = shade;
    cloudUniforms.cloudCover.value = cover;
    cloudUniforms.cloudDrift.value.copy(drift);
  }

  dispose(): void {
    this.light.dispose();
    this.catcher.geometry.dispose();
  }
}
