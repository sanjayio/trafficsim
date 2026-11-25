import type { RoadGraph } from "./roadGraph";

/** Fixed simulation timestep in seconds, so traffic logic never sees a variable dt. */
export const SIM_DT = 1 / 60;

/**
 * Traffic simulation. Advanced in fixed steps by the engine, independent of frame rate.
 * Vehicles, routing and signals will live here.
 */
export class Simulation {
  time = 0;
  ticks = 0;

  constructor(readonly graph: RoadGraph) {}

  step(dt: number): void {
    this.time += dt;
    this.ticks++;
  }
}
