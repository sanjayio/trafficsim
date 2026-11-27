import { Box3, BoxGeometry, CanvasTexture, DoubleSide, Group, Matrix4, Mesh, MeshBasicMaterial, RepeatWrapping, SRGBColorSpace, Vector3, type Object3D } from "three";

/** Seconds the scaffold takes to go up round a building, to stay while the work's done, and to come down. */
const RISE = 1.2;
const HOLD = 0.5;
const FALL = 1.2;
/** How far the scaffold stands out from the building, and above it. */
const MARGIN = 1.5;
/** One bay of scaffolding (poles and planks) in world units, as drawn on its texture. */
const BAY = 6;
/** Drawn with the buildings. */
const ORDER = 20;

/**
 * A building going up a level (or being rebuilt), as in Cities: Skylines: scaffolding rises from
 * the ground all round the old building, the new one takes its place while it's covered, then the
 * scaffolding sinks back into the ground. The scaffold is one box, its sides a see-through texture
 * of poles, planks and netting.
 */
export class Scaffolding extends Group {
  private geometry = new BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  private material: MeshBasicMaterial | null = null;
  private jobs: { scaffold: Mesh; from: Object3D; to: Object3D; t: number; height: number; done: (old: Object3D) => void }[] = [];

  /**
   * Swaps `from` (shown now) for `to` (already in the scene, hidden till it's covered) behind
   * scaffolding, both turned as `to` is; `done` frees `from` once it's gone.
   */
  start(from: Object3D, to: Object3D, done: (old: Object3D) => void): void {
    to.visible = false;
    // Their buildings' extent in `to`'s own frame (not their plots or trees).
    const box = new Box3();
    to.updateMatrixWorld(true);
    const toLocal = new Matrix4().copy(to.matrixWorld).invert();
    for (const g of [from, to]) {
      g.updateMatrixWorld(true);
      g.traverse((o) => {
        if (!o.userData.body) return;
        const b = new Box3().setFromObject(o);
        // The world box's corners into `to`'s frame.
        for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) box.expandByPoint(new Vector3(x, y, z).applyMatrix4(toLocal));
      });
    }
    if (box.isEmpty()) {
      to.visible = true;
      done(from);
      return;
    }
    box.expandByVector(new Vector3(MARGIN, 0, MARGIN));
    box.max.y += MARGIN;
    const size = box.getSize(new Vector3());
    const scaffold = new Mesh(this.geometry, this.scaffoldMaterial());
    scaffold.renderOrder = ORDER;
    scaffold.castShadow = true;
    // In `to`'s frame: a child of a holder placed and turned like it.
    const holder = new Group();
    holder.position.copy(to.position);
    holder.rotation.copy(to.rotation);
    scaffold.position.set((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2);
    scaffold.scale.set(size.x, 0.001, size.z);
    holder.add(scaffold);
    this.add(holder);
    this.jobs.push({ scaffold, from, to, t: 0, height: size.y, done });
  }

  /** Moves every scaffold on by `seconds`. */
  update(seconds: number): void {
    if (!this.jobs.length) return;
    for (const job of this.jobs) {
      const before = job.t;
      job.t += seconds;
      // Up, covering the old building; at the top, the new one in its place; then down.
      if (before < RISE + HOLD / 2 && job.t >= RISE + HOLD / 2) {
        job.from.visible = false;
        job.to.visible = true;
        job.done(job.from);
      }
      const t = job.t;
      const up = t < RISE ? ease(t / RISE) : t < RISE + HOLD ? 1 : 1 - ease(Math.min(1, (t - RISE - HOLD) / FALL));
      job.scaffold.scale.y = Math.max(0.001, job.height * up);
    }
    for (const job of this.jobs.filter((j) => j.t >= RISE + HOLD + FALL)) this.remove(job.scaffold.parent!);
    this.jobs = this.jobs.filter((j) => j.t < RISE + HOLD + FALL);
  }

  /** Finishes every scaffold at once (as when the whole map is rebuilt). */
  finish(): void {
    for (const job of this.jobs) {
      if (job.t < RISE + HOLD / 2) {
        job.from.visible = false;
        job.to.visible = true;
        job.done(job.from);
      }
      this.remove(job.scaffold.parent!);
    }
    this.jobs = [];
  }

  dispose(): void {
    this.finish();
    this.geometry.dispose();
    this.material?.map?.dispose();
    this.material?.dispose();
  }

  private scaffoldMaterial(): MeshBasicMaterial {
    if (!this.material) {
      const map = new CanvasTexture(scaffoldCanvas());
      map.wrapS = map.wrapT = RepeatWrapping;
      map.colorSpace = SRGBColorSpace;
      this.material = new MeshBasicMaterial({ map, transparent: true, alphaTest: 0.1, side: DoubleSide });
      // The texture by world size: a bay of poles every BAY units, however big the scaffold.
      this.material.onBeforeCompile = function (shader, renderer) {
        MeshBasicMaterial.prototype.onBeforeCompile.call(this, shader, renderer);
        shader.vertexShader = shader.vertexShader.replace(
          "#include <uv_vertex>",
          `#include <uv_vertex>
          #ifdef USE_MAP
            vec3 worldSize = vec3(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz), length(modelMatrix[2].xyz));
            vec3 local = position * worldSize;
            vec2 across = abs(normal.x) > 0.5 ? local.zy : abs(normal.y) > 0.5 ? local.xz : local.xy;
            vMapUv = across / ${BAY.toFixed(1)};
          #endif`,
        );
      };
      this.material.customProgramCacheKey = () => "scaffold";
    }
    return this.material;
  }
}

/** Smooth start and finish. */
const ease = (t: number) => t * t * (3 - 2 * t);

/** One bay of scaffolding: grey poles at the sides, planks across top and bottom, a brace, and green netting between. */
function scaffoldCanvas(): HTMLCanvasElement {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "rgba(76, 140, 74, 0.82)";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#9aa1a8";
  ctx.fillRect(0, 0, 5, size);
  ctx.fillRect(size - 5, 0, 5, size);
  ctx.fillStyle = "#b5874f";
  ctx.fillRect(0, size - 6, size, 6);
  ctx.fillRect(0, 0, size, 3);
  ctx.strokeStyle = "#8a9097";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(4, size - 6);
  ctx.lineTo(size - 4, 3);
  ctx.stroke();
  return canvas;
}
