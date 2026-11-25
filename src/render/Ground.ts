import { CanvasTexture, Color, Float32BufferAttribute, Mesh, MeshBasicMaterial, PlaneGeometry, RepeatWrapping, SRGBColorSpace } from "three";
import { WORLD_SIZE } from "../core/constants";
import { palette } from "./palette";

/** Size of one repeat of the grass texture, in world units, and of its canvas in pixels. */
const TILE = 48;
const PIXELS = 256;
/** Grid squares of the ground mesh: enough for its broad colour patches to look smooth. */
const SEGMENTS = 96;

/**
 * Grass covering the buildable world, under everything else. A small generated texture
 * (speckle and short blades) repeats across it, and broad, slowly varying patches of lighter and
 * darker green (baked into its vertex colours) hide the repeat. Built once; one draw call.
 */
export class Ground extends Mesh<PlaneGeometry, MeshBasicMaterial> {
  constructor(renderOrder: number) {
    const geometry = new PlaneGeometry(WORLD_SIZE, WORLD_SIZE, SEGMENTS, SEGMENTS).rotateX(-Math.PI / 2).translate(WORLD_SIZE / 2, 0, WORLD_SIZE / 2);
    const position = geometry.getAttribute("position");
    const colors: number[] = [];
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const z = position.getZ(i);
      // A few overlapping waves of different sizes and directions: lighter and darker drifts.
      const n =
        Math.sin(x * 0.0042 + z * 0.0017) * 0.5 +
        Math.sin(x * -0.0021 + z * 0.0053 + 1.7) * 0.35 +
        Math.sin(x * 0.011 + z * -0.0093 + 4.1) * 0.15;
      const t = 0.9 + n * 0.12;
      colors.push(t, t * (1 + n * 0.03), t);
    }
    geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
    const texture = new CanvasTexture(grassCanvas());
    texture.wrapS = texture.wrapT = RepeatWrapping;
    texture.repeat.set(WORLD_SIZE / TILE, WORLD_SIZE / TILE);
    texture.colorSpace = SRGBColorSpace;
    // Seen at a low angle, keep the far grass from blurring into one smear.
    texture.anisotropy = 8;
    super(geometry, new MeshBasicMaterial({ map: texture, vertexColors: true, depthWrite: false }));
    this.renderOrder = renderOrder;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.map?.dispose();
    this.material.dispose();
  }
}

/** One tile of grass: a base green with fine speckle and short blades in lighter and darker greens. Tiles seamlessly. */
function grassCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = PIXELS;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = `#${new Color(palette.grass).getHexString()}`;
  ctx.fillRect(0, 0, PIXELS, PIXELS);
  // Seeded, so the grass looks the same every time.
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const shades = ["#4f7a3a", "#5b8842", "#45702f", "#679448", "#3d6229", "#729e52"];
  // Drawn at x and wrapped round the tile's edges, so it repeats without seams.
  const wrapped = (draw: (dx: number, dy: number) => void) => {
    for (const dx of [-PIXELS, 0, PIXELS]) for (const dy of [-PIXELS, 0, PIXELS]) draw(dx, dy);
  };
  for (let i = 0; i < 2600; i++) {
    const x = random() * PIXELS;
    const y = random() * PIXELS;
    const size = 1 + random() * 2.5;
    ctx.fillStyle = shades[Math.floor(random() * shades.length)];
    wrapped((dx, dy) => ctx.fillRect(x + dx, y + dy, size, size));
  }
  ctx.lineWidth = 1.2;
  for (let i = 0; i < 900; i++) {
    const x = random() * PIXELS;
    const y = random() * PIXELS;
    const angle = random() * Math.PI * 2;
    const length = 3 + random() * 5;
    ctx.strokeStyle = shades[Math.floor(random() * shades.length)];
    wrapped((dx, dy) => {
      ctx.beginPath();
      ctx.moveTo(x + dx, y + dy);
      ctx.lineTo(x + dx + Math.cos(angle) * length, y + dy + Math.sin(angle) * length);
      ctx.stroke();
    });
  }
  return canvas;
}
