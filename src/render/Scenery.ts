import { Color, Group, MeshBasicMaterial, type InstancedMesh } from "three";
import type { RoadGraph } from "../core/roadGraph";
import { CONIFER, LEAVES, plantParts, swayMaterial, treeGeometries, treeMeshes, TRUNK } from "./buildings";

/** Drawn with the buildings and cars. */
const ORDER = 20;

/**
 * The map's trees and bushes (see `core/scenery`): one instanced mesh for every trunk, one for every
 * ball of leaves and one for every pine's cone (swaying with the rest), however many there are. Rebuilt only when the scenery
 * changes, never per frame.
 */
export class Scenery extends Group {
  private shapes = treeGeometries();
  private trunkMaterial = new MeshBasicMaterial({ color: TRUNK, vertexColors: true });
  private leafMaterial = Object.assign(swayMaterial(new Color(1, 1, 1)), { vertexColors: true });
  private meshes: InstancedMesh[] = [];
  private unsubscribe: () => void;

  constructor(private graph: RoadGraph) {
    super();
    this.unsubscribe = graph.subscribe((e) => {
      if (e.type === "scenery" || e.type === "reset") this.rebuild();
    });
    this.rebuild();
  }

  private rebuild(): void {
    for (const mesh of this.meshes) {
      this.remove(mesh);
      mesh.dispose();
    }
    this.meshes = treeMeshes(this.shapes, this.trunkMaterial, this.leafMaterial, (push) => {
      for (const plant of this.graph.scenery) {
        const colours = plant.kind === "conifer" ? CONIFER : LEAVES;
        const colour = colours[plant.colour % colours.length];
        plantParts({ x: plant.x, z: plant.y, kind: plant.kind, size: plant.size, turn: plant.turn, colour }, push);
      }
    });
    for (const mesh of this.meshes) {
      mesh.renderOrder = ORDER;
      mesh.castShadow = true;
      // One bound for the whole map isn't worth working out; they're drawn whatever the view.
      mesh.frustumCulled = false;
      this.add(mesh);
    }
  }

  dispose(): void {
    this.unsubscribe();
    for (const mesh of this.meshes) mesh.dispose();
    for (const shape of Object.values(this.shapes)) shape.dispose();
    this.trunkMaterial.dispose();
    this.leafMaterial.dispose();
  }
}
