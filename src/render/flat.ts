import { AlwaysStencilFunc, BufferGeometry, Color, DoubleSide, EqualStencilFunc, Float32BufferAttribute, MeshBasicMaterial, ReplaceStencilOp, ShapeUtils, Vector2, type Material } from "three";
import type { Vec2 } from "../core/geometry";
import { palette } from "./palette";

/**
 * Everything on the ground is flat and sits at y = 0. Instead of offsetting heights (which
 * flickers at a distance), flat layers skip depth writes and draw in a fixed order.
 * Future 3D objects (cars, buildings) use normal depth testing and draw on top.
 */
export const FlatLayer = {
  sky: -2,
  ground: -1,
  grid: 0,
  footpath: 1,
  asphalt: 2,
  markings: 3,
  /** Previews draw above everything; their own parts keep the same relative order. */
  overlay: 10,
} as const;

const CAP_SEGMENTS = 12;

/**
 * Width of the kerb stones along a footpath's road edge (a lighter band, so the footpath reads as
 * raised). Laid under the asphalt's edge, which covers all of the band but its outer strip.
 */
export const KERB_WIDTH = 1;
/**
 * How far footpaths stand above the road (see Kit Cidade Low Poly's streets). The footpath's mesh is
 * lifted by this; its kerb's face drops back down to the road (see `pavedGeometry`).
 */
export const KERB_HEIGHT = 1;

/**
 * Marks in the stencil buffer where `material` draws: raised (footpaths, islands, plots, a kerb's
 * height up) or not (a road's surface, which covers footpaths at junctions). The sun's shadows fall
 * at the height each mark says (see `SunShadows`).
 */
export function marksRaised<M extends MeshBasicMaterial>(material: M, raised: boolean): M {
  material.stencilWrite = true;
  material.stencilFunc = AlwaysStencilFunc;
  material.stencilRef = raised ? STENCIL.raised : 0;
  // Its own bit only: a ramp's cutting marks another (see `STENCIL`).
  material.stencilWriteMask = STENCIL.raised;
  material.stencilZPass = ReplaceStencilOp;
  return material;
}

/** Stencil bits: where something raised is drawn (see `marksRaised`), and where a ramp's cutting opens the ground (see `trenchMask`). */
export const STENCIL = { raised: 1, cutting: 2 };

/** Draws `material` only where no ramp's cutting opens the ground (the ground and what lies flat on it). */
export function outsideCuttings<M extends Material>(material: M): M {
  return Object.assign(material, {
    stencilWrite: true,
    stencilWriteMask: 0,
    stencilFuncMask: STENCIL.cutting,
    stencilRef: 0,
    stencilFunc: EqualStencilFunc,
  });
}
/** The kerb's face, upright, drawn a step darker than its top. */
const KERB_FACE_TONE = 0.6;

export function flatMaterial(color: number, opacity = 1): MeshBasicMaterial {
  return new MeshBasicMaterial({
    color,
    opacity,
    transparent: opacity < 1,
    depthWrite: false,
    side: DoubleSide,
  });
}

/**
 * Triangles exactly covering the polygon `outline` (closed back to its start), whatever its shape:
 * kerbs along curved roads can fold back as seen from any single point, so a fan won't do.
 */
export function fill(outline: Vec2[]): Vec2[][] {
  const points = outline.filter((p, i) => i === 0 || Math.hypot(p.x - outline[i - 1].x, p.y - outline[i - 1].y) > 1e-3);
  while (points.length > 1 && Math.hypot(points[0].x - points[points.length - 1].x, points[0].y - points[points.length - 1].y) <= 1e-3) points.pop();
  if (points.length < 3) return [];
  const contour = points.map((p) => new Vector2(p.x, p.y));
  return ShapeUtils.triangulateShape(contour, []).map(([i, j, k]) => [points[i], points[j], points[k]]);
}

/** A strip of `width` from `a` to `b` with round caps, lying on the ground. A circle when a = b. */
export function capsuleGeometry(a: Vec2, b: Vec2, width: number): BufferGeometry {
  const h = width / 2;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const ux = len > 0 ? (b.x - a.x) / len : 1;
  const uy = len > 0 ? (b.y - a.y) / len : 0;
  // Sweep each cap from the left side (normal n) through the end direction to the right side.
  const angleN = Math.atan2(ux, -uy);
  const outline: Vec2[] = [];
  for (const [end, start] of [
    [b, angleN],
    [a, angleN - Math.PI],
  ] as const) {
    for (let i = 0; i <= CAP_SEGMENTS; i++) {
      const theta = start - (Math.PI * i) / CAP_SEGMENTS;
      outline.push({ x: end.x + h * Math.cos(theta), y: end.y + h * Math.sin(theta) });
    }
  }
  return convexGeometry([outline]);
}

/** Outline of a flat rectangle of `width` from `a` to `b` (no caps). */
export function stripOutline(a: Vec2, b: Vec2, width: number): Vec2[] {
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const nx = (-(b.y - a.y) / len) * (width / 2);
  const ny = ((b.x - a.x) / len) * (width / 2);
  return [
    { x: a.x + nx, y: a.y + ny },
    { x: b.x + nx, y: b.y + ny },
    { x: b.x - nx, y: b.y - ny },
    { x: a.x - nx, y: a.y - ny },
  ];
}

/**
 * One geometry holding several convex polygons (e.g. all dashes of a lane line), so they
 * cost a single draw call. World (x, y) maps to three.js (x, 0, y).
 */
export function convexGeometry(outlines: Vec2[][]): BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const outline of outlines) {
    // Triangle fan from the outline's centroid.
    const base = positions.length / 3;
    const cx = outline.reduce((sum, p) => sum + p.x, 0) / outline.length;
    const cy = outline.reduce((sum, p) => sum + p.y, 0) / outline.length;
    positions.push(cx, 0, cy);
    for (const p of outline) positions.push(p.x, 0, p.y);
    for (let i = 0; i < outline.length; i++) {
      indices.push(base, base + i + 1, base + ((i + 1) % outline.length) + 1);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  return geometry;
}

/**
 * Footpath and its kerb stones in one geometry (one draw call): the kerb's triangles come after
 * the footpath's, so they draw over it, and their vertices are marked (attribute `kerb`: 1) for the
 * footpath material to colour them (see `kerbColouring`). Every footpath-material geometry needs
 * the mark, so pass no kerb for a plain one.
 *
 * `faces`: lines along the road's edge where the footpath (drawn `KERB_HEIGHT` up) meets it, each
 * becoming the kerb's upright face down to the road (marked 2). Drawn before the road, they show
 * where the footpath stands beyond the road and are covered by the road where it's in front.
 */
export function pavedGeometry(footpath: Vec2[][], kerb: Vec2[][] = [], faces: Vec2[][] = []): BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const marks: number[] = [];
  const upright = (lines: Vec2[][], mark: number) => {
    for (const line of lines) {
      for (let i = 1; i < line.length; i++) {
        const [a, b] = [line[i - 1], line[i]];
        const base = positions.length / 3;
        positions.push(a.x, -KERB_HEIGHT, a.y, b.x, -KERB_HEIGHT, b.y, b.x, 0, b.y, a.x, 0, a.y);
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        marks.push(mark, mark, mark, mark);
      }
    }
  };
  const flat = convexGeometry([...footpath, ...kerb]);
  // convexGeometry adds a centre vertex per outline.
  const plain = footpath.reduce((sum, outline) => sum + outline.length + 1, 0);
  const base = positions.length / 3;
  positions.push(...(flat.getAttribute("position").array as Float32Array));
  indices.push(...Array.from(flat.getIndex()!.array, (i) => i + base));
  marks.push(...Array.from({ length: flat.getAttribute("position").count }, (_, i) => (i < plain ? 0 : 1)));
  flat.dispose();
  upright(faces, 2);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("kerb", new Float32BufferAttribute(marks, 1));
  geometry.setIndex(indices);
  return geometry;
}

/**
 * `material` (the footpath's) drawing the vertices `pavedGeometry` marks as kerb in the kerb's
 * colour. Keeps the scene's own shader changes (tint, cloud shadows: see `installCloudShadows`).
 */
export function kerbColouring(material: MeshBasicMaterial): MeshBasicMaterial {
  const kerbColour = { value: new Color(palette.kerb) };
  material.onBeforeCompile = function (shader, renderer) {
    MeshBasicMaterial.prototype.onBeforeCompile.call(this, shader, renderer);
    shader.uniforms.kerbColour = kerbColour;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float kerb;\nvarying float vKerb;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvKerb = kerb;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vKerb;\nuniform vec3 kerbColour;")
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
        diffuseColor.rgb = mix(diffuseColor.rgb, kerbColour * (vKerb > 1.5 ? ${KERB_FACE_TONE} : 1.0), step(0.5, vKerb));`,
      );
  };
  material.customProgramCacheKey = () => "paved";
  return material;
}
