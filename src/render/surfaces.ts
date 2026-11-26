import { CanvasTexture, Color, NoColorSpace, RepeatWrapping, type MeshBasicMaterial, type Texture } from "three";
import { palette } from "./palette";

/**
 * Surface texture for asphalt and footpaths. Their shapes carry no texture coordinates, so the
 * texture is laid by world position in the shader: no extra geometry or draw calls, one small
 * shared texture each. It only shades the material's own colour (a factor about 1), so the palette
 * still decides the colour. Fine grain is in the red channel; broad, slow patches in green, sampled
 * at another scale so the repeat doesn't show.
 */
export type Surface = "asphalt" | "footpath";

/** Canvas size in pixels; world units one repeat of the fine grain covers; how much larger the patches' repeat is. */
const PIXELS = 256;
const TILE: Record<Surface, number> = { asphalt: 24, footpath: 20 };
const PATCH_SCALE = 6.3;

const textures = new Map<Surface, Texture>();

/** Lays `surface`'s texture over `material` (and keeps it on clones made with `material.clone()` passed back here). */
export function textureSurface(material: MeshBasicMaterial, surface: Surface): MeshBasicMaterial {
  const tile = TILE[surface];
  // Made on first draw (not before: tests build road layers without a page to draw a canvas on).
  // Footpaths carry their kerb stones (vertices marked `kerb`, see `pavedGeometry`): drawn in the kerb's colour.
  const kerb = surface === "footpath";
  material.onBeforeCompile = (shader) => {
    shader.uniforms.surfaceMap = { value: surfaceTexture(surface) };
    shader.uniforms.surfaceTile = { value: tile };
    shader.uniforms.kerbColour = { value: new Color(palette.kerb) };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\nvarying vec2 vSurface;${kerb ? "\nattribute float kerb;\nvarying float vKerb;" : ""}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\nvSurface = (modelMatrix * vec4(transformed, 1.0)).xz;${kerb ? "\nvKerb = kerb;" : ""}`);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>\nvarying vec2 vSurface;\nuniform sampler2D surfaceMap;\nuniform float surfaceTile;${kerb ? "\nvarying float vKerb;\nuniform vec3 kerbColour;" : ""}`,
      )
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
        ${kerb ? "diffuseColor.rgb = mix(diffuseColor.rgb, kerbColour, step(0.5, vKerb));" : ""}
        float grain = texture2D(surfaceMap, vSurface / surfaceTile).r;
        float patches = texture2D(surfaceMap, vSurface / (surfaceTile * ${PATCH_SCALE.toFixed(1)}) + 0.37).g;
        diffuseColor.rgb *= grain * 2.0 * (patches * 2.0);`,
      );
  };
  // Textured and plain flat materials compile apart.
  material.customProgramCacheKey = () => `surface:${surface}`;
  return material;
}

function surfaceTexture(surface: Surface): Texture {
  let map = textures.get(surface);
  if (!map) {
    map = new CanvasTexture(surfaceCanvas(surface));
    map.wrapS = map.wrapT = RepeatWrapping;
    // A shading factor, not a colour: read as is.
    map.colorSpace = NoColorSpace;
    // Seen at a low angle, keep the far road from blurring into one smear.
    map.anisotropy = 8;
    textures.set(surface, map);
  }
  return map;
}

/** Disposes the shared textures (once nothing draws with them). */
export function disposeSurfaces(): void {
  for (const map of textures.values()) map.dispose();
  textures.clear();
}

/**
 * One tile of a surface, grey about mid (128, a factor of 1): red the fine grain, green the broad
 * patches. Asphalt: dark and light stones in the tar, worn patches. Footpath: fine concrete speckle,
 * a few hairline cracks, patchy weathering. Seeded, and wrapped at the edges, so it repeats without seams.
 */
function surfaceCanvas(surface: Surface): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = PIXELS;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "rgb(128, 128, 0)";
  ctx.fillRect(0, 0, PIXELS, PIXELS);
  let seed = surface === "asphalt" ? 11 : 23;
  const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const wrapped = (draw: (dx: number, dy: number) => void) => {
    for (const dx of [-PIXELS, 0, PIXELS]) for (const dy of [-PIXELS, 0, PIXELS]) draw(dx, dy);
  };
  // Each channel drawn on its own: lighter adds, darker takes away, leaving the other channel be.
  const channel = (red: boolean, amount: number, draw: () => void) => {
    ctx.globalCompositeOperation = amount > 0 ? "lighter" : "difference";
    const v = Math.round(Math.abs(amount));
    ctx.fillStyle = ctx.strokeStyle = red ? `rgb(${v}, 0, 0)` : `rgb(0, ${v}, 0)`;
    draw();
  };
  // A soft round patch: full strength in the middle, fading to nothing at its edge.
  const blob = (red: boolean, amount: number, x: number, y: number, r: number) => {
    ctx.globalCompositeOperation = amount > 0 ? "lighter" : "difference";
    const v = Math.round(Math.abs(amount));
    wrapped((dx, dy) => {
      const g = ctx.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
      g.addColorStop(0, red ? `rgb(${v}, 0, 0)` : `rgb(0, ${v}, 0)`);
      g.addColorStop(1, "rgb(0, 0, 0)");
      ctx.fillStyle = g;
      ctx.fillRect(x + dx - r, y + dy - r, r * 2, r * 2);
    });
  };

  // Broad patches (green): soft, overlapping, lighter and darker.
  for (let i = 0; i < 26; i++) blob(false, (random() - 0.5) * 40, random() * PIXELS, random() * PIXELS, 20 + random() * 40);

  if (surface === "asphalt") {
    // Stones in the tar: many small, mostly darker, some light chips.
    for (let i = 0; i < 5200; i++) {
      const x = random() * PIXELS;
      const y = random() * PIXELS;
      const size = 0.8 + random() * 1.6;
      const amount = random() < 0.6 ? -(14 + random() * 30) : 20 + random() * 50;
      channel(true, amount, () => wrapped((dx, dy) => ctx.fillRect(x + dx, y + dy, size, size)));
    }
    // Worn and resurfaced patches, soft-edged.
    for (let i = 0; i < 7; i++) blob(true, (random() - 0.6) * 30, random() * PIXELS, random() * PIXELS, 10 + random() * 22);
  } else {
    // Fine concrete speckle.
    for (let i = 0; i < 3800; i++) {
      const x = random() * PIXELS;
      const y = random() * PIXELS;
      const amount = (random() - 0.5) * 40;
      channel(true, amount, () => wrapped((dx, dy) => ctx.fillRect(x + dx, y + dy, 1, 1)));
    }
    // Weathering: soft darker stains.
    for (let i = 0; i < 9; i++) blob(true, -(8 + random() * 16), random() * PIXELS, random() * PIXELS, 8 + random() * 20);
    // A few hairline cracks, wandering.
    ctx.lineWidth = 1;
    for (let i = 0; i < 6; i++) {
      let x = random() * PIXELS;
      let y = random() * PIXELS;
      let angle = random() * Math.PI * 2;
      const points: [number, number][] = [[x, y]];
      for (let k = 0; k < 8; k++) {
        angle += (random() - 0.5) * 1.2;
        x += Math.cos(angle) * 6;
        y += Math.sin(angle) * 6;
        points.push([x, y]);
      }
      channel(true, -40, () =>
        wrapped((dx, dy) => {
          ctx.beginPath();
          points.forEach(([px, py], k) => (k ? ctx.lineTo(px + dx, py + dy) : ctx.moveTo(px + dx, py + dy)));
          ctx.stroke();
        }),
      );
    }
  }
  ctx.globalCompositeOperation = "source-over";
  return canvas;
}
