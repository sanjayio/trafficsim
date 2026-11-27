import {
  Color,
  DirectionalLight,
  DoubleSide,
  EqualStencilFunc,
  KeepStencilOp,
  NotEqualStencilFunc,
  type StencilFunc,
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
import { KERB_HEIGHT } from "./flat";

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

/** Over a deck's kerbs: their footpaths (hidden under a junction's surface where its roads end) cast too. */
const CATCHER_LIFT = KERB_HEIGHT + 0.3;
/**
 * Show the sun's shadows, as dark as `SunShadows` sets them: on the ground (and roads), on what's a
 * kerb's height up (footpaths, islands, plots: where they've marked, see `marksRaised`), and over
 * bridge decks (see `catchShadows`). Both sides, as the road parts they lie over are drawn (their
 * triangles face either way).
 */
const catcher = (stencil?: { func: StencilFunc }) =>
  new ShadowMaterial({
    opacity: 0.4,
    depthWrite: false,
    side: DoubleSide,
    ...(stencil ? { stencilWrite: true, stencilRef: 1, stencilFunc: stencil.func, stencilZPass: KeepStencilOp } : {}),
  });
const GROUND = catcher({ func: NotEqualStencilFunc });
const RAISED = catcher({ func: EqualStencilFunc });
const CATCHER = catcher();

/**
 * Shows the sun's shadows on `mesh` (a bridge's deck, which, drawn without lighting,
 * can't take them itself): a clear copy of it that does, over it.
 */
export function catchShadows(mesh: Mesh): void {
  const catcher = new Mesh(mesh.geometry, CATCHER);
  // Over it and all its layers, so the deck (which casts too) doesn't shade itself.
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
  /** Over the ground, and a kerb's height up over footpaths and plots. */
  private catchers: Mesh<PlaneGeometry, ShadowMaterial>[];

  constructor(renderer: WebGLRenderer, renderOrder: number) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFSoftShadowMap;
    this.light.castShadow = true;
    this.light.shadow.mapSize.set(2048, 2048);
    this.light.shadow.bias = -0.0004;
    const plane = new PlaneGeometry(WORLD_SIZE, WORLD_SIZE).rotateX(-Math.PI / 2).translate(WORLD_SIZE / 2, 0, WORLD_SIZE / 2);
    this.catchers = [GROUND, RAISED].map((material) => {
      const mesh = new Mesh(plane, material);
      mesh.receiveShadow = true;
      mesh.renderOrder = renderOrder;
      return mesh;
    });
    this.catchers[1].position.y = KERB_HEIGHT;
  }

  get objects(): Object3D[] {
    return [this.light, this.light.target, ...this.catchers];
  }

  /**
   * Shadows cast away from `sun` (a unit vector), round ground point (`x`, `z`) for a view `scale`
   * (the camera's orbit distance) across, as dark as `strength` (0 for none).
   */
  update(sun: { x: number; y: number; z: number }, x: number, z: number, scale: number, strength: number): void {
    const on = strength > 0.01 && sun.y > 0.02;
    this.light.castShadow = on;
    for (const mesh of this.catchers) mesh.visible = on;
    if (!on) return;
    for (const material of [GROUND, RAISED, CATCHER]) material.opacity = strength;
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
    this.catchers[0].geometry.dispose();
  }
}
