import { Color, Group, InstancedMesh, MeshBasicMaterial, type Matrix4 } from "three";
import type { RoadGraph } from "../core/roadGraph";
import { CONIFER, LEAVES, plantBoxes, shadedBox, swayMaterial } from "./buildings";

/** Drawn with the buildings and cars. */
const ORDER = 20;

/**
 * The map's trees and bushes (see `core/scenery`): every trunk one instanced mesh, every block of
 * leaves another (swaying with the rest), however many there are. Rebuilt only when the scenery
 * changes, never per frame.
 */
export class Scenery extends Group {
  private box = shadedBox();
  private trunkMaterial = new MeshBasicMaterial({ color: 0x6b4a33, vertexColors: true });
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
    const trunks: Matrix4[] = [];
    const leaves: { m: Matrix4; colour: number }[] = [];
    for (const plant of this.graph.scenery) {
      const colours = plant.kind === "conifer" ? CONIFER : LEAVES;
      const colour = colours[plant.colour % colours.length];
      plantBoxes({ x: plant.x, z: plant.y, kind: plant.kind, size: plant.size, turn: plant.turn, colour }, (m, leaf) =>
        leaf === null ? trunks.push(m) : leaves.push({ m, colour: leaf }),
      );
    }
    const trunkMesh = new InstancedMesh(this.box, this.trunkMaterial, Math.max(1, trunks.length));
    trunkMesh.count = trunks.length;
    trunks.forEach((m, i) => trunkMesh.setMatrixAt(i, m));
    const leafMesh = new InstancedMesh(this.box, this.leafMaterial, Math.max(1, leaves.length));
    leafMesh.count = leaves.length;
    const tint = new Color();
    leaves.forEach(({ m, colour }, i) => {
      leafMesh.setMatrixAt(i, m);
      leafMesh.setColorAt(i, tint.setHex(colour));
    });
    this.meshes = [trunkMesh, leafMesh];
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
    this.box.dispose();
    this.trunkMaterial.dispose();
    this.leafMaterial.dispose();
  }
}
