import { BufferGeometry, Color, Float32BufferAttribute, LineSegments, ShaderMaterial, Vector3 } from "three";

/** Raindrops in the box round the camera's focus. */
const DROPS = 4000;

/**
 * Rain: streaks falling in a box that follows the camera's focus, sized to its zoom. Each drop's
 * start is fixed; the shader moves it with the clock, wrapping round the box, so nothing is
 * updated on the CPU. One draw call, shown only in rain.
 */
export class Rain extends LineSegments<BufferGeometry, ShaderMaterial> {
  private time = 0;

  constructor(renderOrder: number) {
    super(drops(), material());
    this.renderOrder = renderOrder;
    this.frustumCulled = false;
    this.visible = false;
  }

  /** Rains (or not) round `focus` (three.js coordinates), for a camera `scale` (its orbit distance) away, blown by `wind`. */
  update(raining: boolean, focus: Vector3, scale: number, wind: number, brightness: number, dt: number): void {
    this.visible = raining;
    if (!raining) return;
    this.time += dt;
    const u = this.material.uniforms;
    u.time.value = this.time;
    u.focus.value.copy(focus);
    u.size.value = scale;
    u.wind.value = wind;
    u.color.value.setScalar(brightness);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/** Each drop: a start in a unit box (x, z in -1..1, y in 0..1) and a speed factor, for both ends of its streak. */
function drops(): BufferGeometry {
  // Positions are unused (the shader places each drop) but three.js needs them to count vertices.
  const position: number[] = [];
  const start: number[] = [];
  const tail: number[] = [];
  let seed = 11;
  const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  for (let i = 0; i < DROPS; i++) {
    const p = [random() * 2 - 1, random(), random() * 2 - 1, 0.75 + random() * 0.5];
    for (const end of [0, 1]) {
      position.push(0, 0, 0);
      start.push(...p);
      tail.push(end);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(position, 3));
  geometry.setAttribute("start", new Float32BufferAttribute(start, 4));
  geometry.setAttribute("tail", new Float32BufferAttribute(tail, 1));
  return geometry;
}

function material(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      time: { value: 0 },
      focus: { value: new Vector3() },
      size: { value: 100 },
      wind: { value: 0 },
      color: { value: new Color(1, 1, 1) },
    },
    vertexShader: `
      attribute vec4 start;
      attribute float tail;
      uniform float time;
      uniform vec3 focus;
      uniform float size;
      uniform float wind;
      void main() {
        // The box: wide as the view, as tall as the camera is far.
        float reach = size * 0.9;
        float height = size * 0.7;
        float y = mod(start.y * height - time * 1.1 * size * start.w, height);
        vec2 offset = start.xz * reach + vec2(wind * (height - y) * 0.6, 0.0);
        // Wrapped round the focus, so drops stay put on the ground as the camera pans.
        vec2 at = focus.xz + mod(offset - focus.xz + reach, 2.0 * reach) - reach;
        vec3 world = vec3(at.x, y, at.y) + vec3(wind * 0.6, 1.0, 0.0) * tail * size * 0.035;
        gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 color;
      void main() {
        gl_FragColor = vec4(color * vec3(0.55, 0.6, 0.7), 0.7);
      }`,
    transparent: true,
    depthWrite: false,
  });
}
