import { Group, Mesh, type BufferGeometry, type InstancedMesh, type MeshBasicMaterial } from "three";
import { SampledCurve, type Curve } from "../core/curve";
import type { Vec2 } from "../core/geometry";
import { levelHeight } from "../core/grade";
import { roadWidth, type RoadSpec } from "../core/roadSpec";
import { concreteMaterial, gradeStructure } from "./grade";
import type { Overlay } from "../tools/Tool";
import { KERB_HEIGHT, capsuleGeometry, convexGeometry, FlatLayer, flatMaterial, stripOutline } from "./flat";
import { palette } from "./palette";
import { buildRoadParts, ROAD_PART_STYLE, surface, type RoadPart } from "./roadParts";

const DOT_RADIUS = 4;
const GUIDE_WIDTH = 1.5;
/** Snapping guideline style, in screen pixels. */
const GUIDE_DOT = 4;
const GUIDE_GAP = 5;
const GUIDE_LINE_PX = 1.75;
const GUIDE_CROSS_PX = 7;
const PREVIEW_OPACITY = 0.6;

/** How far up the overlay's drawn for a bridge or tunnel `height` up (or down): over its deck and footpaths (they write depth, which would hide it). */
const lift = (height: number) => (height ? height + KERB_HEIGHT + 0.2 : 0);

/** three.js implementation of the tools' overlay. Contents are small and rebuilt only on input. */
export class OverlayLayer extends Group implements Overlay {
  /** Translucent copies of the road materials, shared by every preview. */
  private previewMaterials = Object.fromEntries(
    Object.entries(ROAD_PART_STYLE).map(([part, style]) => [part, flatMaterial(style.color, PREVIEW_OPACITY)]),
  ) as Record<RoadPart, MeshBasicMaterial>;
  /** Used for every part of a preview that can't be built. */
  private invalidMaterial = flatMaterial(palette.danger, 0.5);
  /** A bridge's or tunnel's concrete (parapets, pillars, walls) in a preview. */
  private concrete = Object.assign(concreteMaterial(), { transparent: true, opacity: PREVIEW_OPACITY, depthWrite: false });

  /** Removes all children like `Object3D.clear`, and frees their GPU resources. */
  override clear(): this {
    this.position.y = 0;
    for (const child of [...this.children]) {
      const mesh = child as Mesh;
      this.remove(mesh);
      // A bridge's concrete shares its box with every other.
      if ((mesh as InstancedMesh).isInstancedMesh) (mesh as InstancedMesh).dispose();
      else mesh.geometry.dispose();
      if (mesh.userData.ownsMaterial) (mesh.material as MeshBasicMaterial).dispose();
    }
    return this;
  }

  raise(height: number): void {
    this.position.y = lift(height);
  }

  roadPreview(curve: Curve, spec: RoadSpec, valid: boolean): void {
    const path = new SampledCurve(curve);
    // A bridge's parapets and pillars (a tunnel's walls), as built: at their height in the world, not lifted with the rest.
    const level = spec.level ?? 0;
    if (level) {
      const h = levelHeight(level);
      const structure = gradeStructure(path, roadWidth(spec), () => h, valid ? this.concrete : this.invalidMaterial, spec.footpath ? KERB_HEIGHT : 0, () => [0, path.length]);
      structure.position.y = -lift(h);
      structure.renderOrder = FlatLayer.overlay;
      structure.castShadow = false;
      this.add(structure);
    }
    for (const { part, geometry } of buildRoadParts(path, spec)) {
      const material = valid ? this.previewMaterials[part] : this.invalidMaterial;
      // Keep the parts' relative order (footpath < asphalt < markings) above everything else.
      const mesh = this.addMesh(geometry, material, FlatLayer.overlay + ROAD_PART_STYLE[part].layer, false);
      // Footpaths (and medians) stand above the road, as built.
      if (part === "footpath" || part === "median") mesh.position.y = KERB_HEIGHT;
    }
  }

  highlight(curve: Curve, width: number, color: number, alpha: number): void {
    const geometry = convexGeometry(surface(new SampledCurve(curve), width));
    this.addMesh(geometry, flatMaterial(color, alpha), FlatLayer.overlay, true);
  }

  line(a: Vec2, b: Vec2, color: number): void {
    this.addMesh(convexGeometry([stripOutline(a, b, GUIDE_WIDTH)]), flatMaterial(color, 0.8), FlatLayer.overlay + 8, true);
  }

  guide(origin: Vec2, to: Vec2, color: number, pixel: number): void {
    const len = Math.hypot(to.x - origin.x, to.y - origin.y);
    if (len === 0) return;
    const ux = (to.x - origin.x) / len;
    const uy = (to.y - origin.y) / len;
    const at = (d: number): Vec2 => ({ x: origin.x + ux * d, y: origin.y + uy * d });
    const width = GUIDE_LINE_PX * pixel;

    // Dots start clear of the ✕ so the two don't merge.
    const dashes: Vec2[][] = [];
    const step = (GUIDE_DOT + GUIDE_GAP) * pixel;
    for (let d = GUIDE_CROSS_PX * pixel; d < len; d += step) {
      dashes.push(stripOutline(at(d), at(Math.min(d + GUIDE_DOT * pixel, len)), width));
    }
    // ✕ at the origin, rotated 45° to the line.
    const arm = GUIDE_CROSS_PX * pixel;
    const d1 = { x: (ux - uy) * Math.SQRT1_2 * arm, y: (uy + ux) * Math.SQRT1_2 * arm };
    const d2 = { x: (ux + uy) * Math.SQRT1_2 * arm, y: (uy - ux) * Math.SQRT1_2 * arm };
    dashes.push(
      stripOutline({ x: origin.x - d1.x, y: origin.y - d1.y }, { x: origin.x + d1.x, y: origin.y + d1.y }, width),
      stripOutline({ x: origin.x - d2.x, y: origin.y - d2.y }, { x: origin.x + d2.x, y: origin.y + d2.y }, width),
    );
    this.addMesh(convexGeometry(dashes), flatMaterial(color, 0.9), FlatLayer.overlay + 8, true);
  }

  area(points: Vec2[], color: number, alpha: number): void {
    this.addMesh(convexGeometry([points]), flatMaterial(color, alpha), FlatLayer.overlay, true);
    for (let i = 0; i < points.length; i++) this.line(points[i], points[(i + 1) % points.length], color);
  }

  dot(p: Vec2, color: number): void {
    this.addMesh(capsuleGeometry(p, p, DOT_RADIUS * 2), flatMaterial(color), FlatLayer.overlay + 9, true);
  }

  dispose(): void {
    this.clear();
    for (const material of Object.values(this.previewMaterials)) material.dispose();
    this.invalidMaterial.dispose();
  }

  private addMesh(geometry: BufferGeometry, material: MeshBasicMaterial, order: number, ownsMaterial: boolean): Mesh {
    const mesh = new Mesh(geometry, material);
    mesh.renderOrder = order;
    mesh.userData.ownsMaterial = ownsMaterial;
    this.add(mesh);
    return mesh;
  }
}
