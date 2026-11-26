import { describe, expect, it } from "vitest";
import { ROLE, VILLA_VARIANTS, villaLook, villaModel } from "./villas";

describe("villas", () => {
  it.each(VILLA_VARIANTS)("%s: stands on the ground, in its footprint, with walls, roof, glass and a garage door, in few triangles", (variant) => {
    const model = villaModel(variant);
    const position = model.geometry.getAttribute("position");
    const roles = new Set(Array.from(model.geometry.getAttribute("role").array));
    const ys = Array.from({ length: position.count }, (_, i) => position.getY(i));
    expect(Math.min(...ys)).toBeCloseTo(0, 6);
    for (let i = 0; i < position.count; i++) {
      expect(position.getX(i)).toBeGreaterThanOrEqual(model.minX - 1e-6);
      expect(position.getX(i)).toBeLessThanOrEqual(model.maxX + 1e-6);
    }
    for (const role of [ROLE.walls, ROLE.roof, ROLE.glass]) expect(roles.has(role)).toBe(true);
    // The garage door is on the front, within the house.
    expect(model.garageX).toBeGreaterThan(model.minX);
    expect(model.garageX).toBeLessThan(model.maxX);
    expect(position.count / 3).toBeLessThan(600);
  });

  it("picks a villa's variant and colours by where it stands, the same each time, and all variants turn up", () => {
    expect(villaLook({ x: 120, y: 40 })).toEqual(villaLook({ x: 120, y: 40 }));
    const seen = new Set(Array.from({ length: 60 }, (_, i) => villaLook({ x: i * 36, y: 18 }).variant));
    expect(seen.size).toBe(VILLA_VARIANTS.length);
  });
});
