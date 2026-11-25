import { BackSide, Color, Mesh, ShaderMaterial, SphereGeometry, Vector2, Vector3 } from "three";
import type { Atmosphere } from "./atmosphere";

/**
 * A sky dome round the camera: haze at the horizon (the fog's colour, so distant ground fades
 * into it) shading up to the zenith, with the sun, drifting clouds and, at night, stars. All
 * in its shader; drawn first, behind everything.
 */
export class Sky extends Mesh<SphereGeometry, ShaderMaterial> {
  /** How far the clouds have drifted, in cloud-layer units. */
  readonly drift = new Vector2();

  constructor(renderOrder: number) {
    super(
      new SphereGeometry(1, 48, 24),
      new ShaderMaterial({
        uniforms: {
          horizon: { value: new Color() },
          zenith: { value: new Color() },
          sun: { value: new Vector3(0, 1, 0) },
          sunGlow: { value: 1 },
          cover: { value: 0.3 },
          cloudColor: { value: new Color(0xffffff) },
          drift: { value: new Vector2() },
          stars: { value: 0 },
        },
        vertexShader: `
          varying vec3 direction;
          void main() {
            direction = position;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: `
          uniform vec3 horizon;
          uniform vec3 zenith;
          uniform vec3 sun;
          uniform float sunGlow;
          uniform float cover;
          uniform vec3 cloudColor;
          uniform vec2 drift;
          uniform float stars;
          varying vec3 direction;

          float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float noise(vec2 p) {
            vec2 i = floor(p);
            vec2 f = fract(p);
            vec2 u = f * f * (3.0 - 2.0 * f);
            return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
          }
          float fbm(vec2 p) {
            float sum = 0.0;
            float amp = 0.5;
            for (int i = 0; i < 5; i++) {
              sum += amp * noise(p);
              p = p * 2.03 + vec2(1.7, 9.2);
              amp *= 0.5;
            }
            return sum;
          }

          void main() {
            vec3 dir = normalize(direction);
            float up = max(dir.y, 0.0);
            vec3 color = mix(horizon, zenith, pow(up, 0.55));

            // Stars: a small dot in a few cells of a fine 3D grid round the sky (a few pixels each).
            if (stars > 0.0) {
              vec3 grid = dir * 420.0;
              vec3 cell = floor(grid);
              float lit = step(0.9965, hash(cell.xy + cell.z * 37.0));
              float dot = 1.0 - smoothstep(0.12, 0.32, length(fract(grid) - 0.5));
              color += vec3(lit * dot * stars * (0.5 + 0.5 * hash(cell.zx))) * smoothstep(0.02, 0.2, up);
            }

            // The sun: a disc and a soft glow round it.
            float toward = max(dot(dir, sun), 0.0);
            vec3 sunlight = mix(vec3(1.0, 0.75, 0.45), vec3(1.0, 0.97, 0.9), clamp(sun.y * 3.0, 0.0, 1.0));
            color += sunlight * (smoothstep(0.99975, 0.99985, toward) * 3.0 + pow(toward, 1500.0) * 1.5 + pow(toward, 80.0) * 0.18 + pow(toward, 6.0) * 0.1) * sunGlow * step(-0.02, dir.y);

            // Clouds: noise on a flat layer overhead, seen in perspective, thinning towards the horizon.
            if (dir.y > 0.0) {
              vec2 layer = dir.xz / (dir.y + 0.12) * 1.6 + drift;
              float n = fbm(layer);
              float cloud = smoothstep(1.0 - cover, 1.0 - cover + 0.32, n + cover * 0.25) * smoothstep(0.0, 0.18, dir.y);
              // Brighter edges towards the sun, darker bellies in thick cloud.
              vec3 shade = cloudColor * (1.0 - 0.35 * smoothstep(0.55, 0.95, n)) + sunlight * pow(toward, 8.0) * 0.25 * sunGlow;
              color = mix(color, shade, cloud * 0.95);
            }
            gl_FragColor = vec4(color, 1.0);
            #include <colorspace_fragment>
          }`,
        side: BackSide,
        depthWrite: false,
        depthTest: false,
      }),
    );
    this.renderOrder = renderOrder;
    this.frustumCulled = false;
  }

  /** Sets the sky for `a`, drifting the clouds on by `dt` seconds of wall-clock time. */
  update(a: Atmosphere, dt: number): void {
    const u = this.material.uniforms;
    u.horizon.value.copy(a.horizon);
    u.zenith.value.copy(a.zenith);
    u.sun.value.set(a.sun.x, a.sun.y, a.sun.z);
    u.sunGlow.value = a.sunGlow;
    u.cover.value = a.clouds.cover;
    u.cloudColor.value.copy(a.clouds.color);
    u.stars.value = a.stars;
    this.drift.x += (a.clouds.speed * dt) / 400;
    this.drift.y += (a.clouds.speed * dt) / 1200;
    u.drift.value.copy(this.drift);
  }

  /** Keeps the dome centred on the camera, inside its far plane. */
  follow(position: { x: number; y: number; z: number }, radius: number): void {
    this.position.set(position.x, position.y, position.z);
    this.scale.setScalar(radius);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
