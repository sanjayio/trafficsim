import { BufferGeometry, Float32BufferAttribute, Group, LineBasicMaterial, LineSegments } from "three";
import { GRID_MAJOR_EVERY, GRID_SIZE, WORLD_SIZE } from "../core/constants";
import { FlatLayer, outsideCuttings } from "./flat";
import { palette } from "./palette";

/** Static ground grid, built once. Minor and major lines are separate so minor can hide when zoomed out. */
export class Grid extends Group {
  readonly minor: LineSegments;
  readonly major: LineSegments;

  constructor() {
    super();
    const minor: number[] = [];
    const major: number[] = [];
    const cells = WORLD_SIZE / GRID_SIZE;
    for (let i = 0; i <= cells; i++) {
      const lines = i % GRID_MAJOR_EVERY === 0 ? major : minor;
      const v = i * GRID_SIZE;
      lines.push(v, 0, 0, v, 0, WORLD_SIZE);
      lines.push(0, 0, v, WORLD_SIZE, 0, v);
    }
    this.minor = gridLines(minor, palette.gridMinor);
    this.major = gridLines(major, palette.gridMajor);
    this.add(this.minor, this.major);
  }

  dispose(): void {
    for (const l of [this.minor, this.major]) {
      l.geometry.dispose();
      (l.material as LineBasicMaterial).dispose();
    }
  }
}

function gridLines(positions: number[], color: number): LineSegments {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  const segments = new LineSegments(geometry, outsideCuttings(new LineBasicMaterial({ color, depthWrite: false })));
  segments.renderOrder = FlatLayer.grid;
  return segments;
}
