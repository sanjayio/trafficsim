import { Mesh, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { buildingSize, type Building, type Lot } from "../core/terminal";
import { BuildingKit } from "./buildings";
import { APARTMENT_VARIANTS, apartmentLook, apartmentModel } from "./apartments";
import { CAR_LENGTH, CAR_TYPES } from "../core/simulation";
import { carModel } from "./cars";
import { COMMERCIAL_VARIANTS, commercialLook, commercialModel } from "./commercial";
import { ROLE, VILLA_VARIANTS, villaLook, villaModel, type KitModel } from "./villas";

/** A kit home stands on the ground, within its footprint, with walls, roof, glass and a way in for cars, in few triangles. */
function checkModel(model: KitModel, maxTriangles: number): void {
  const position = model.geometry.getAttribute("position");
  const roles = new Set(Array.from(model.geometry.getAttribute("role").array));
  const ys = Array.from({ length: position.count }, (_, i) => position.getY(i));
  expect(Math.min(...ys)).toBeCloseTo(0, 6);
  for (const role of [ROLE.walls, ROLE.roof, ROLE.glass]) expect(roles.has(role)).toBe(true);
  expect(model.garageX).toBeGreaterThan(model.minX);
  expect(model.garageX).toBeLessThan(model.maxX);
  expect(position.count / 3).toBeLessThan(maxTriangles);
}

describe("villas", () => {
  it.each(VILLA_VARIANTS)("%s: stands on the ground with walls, roof, glass and a garage door, in few triangles", (variant) => {
    checkModel(villaModel(variant), 600);
  });

  it("picks a villa's variant and colours by where it stands, the same each time, and all variants turn up", () => {
    expect(villaLook({ x: 120, y: 40 })).toEqual(villaLook({ x: 120, y: 40 }));
    const seen = new Set(Array.from({ length: 60 }, (_, i) => villaLook({ x: i * 36, y: 18 }).variant));
    expect(seen.size).toBe(VILLA_VARIANTS.length);
  });

  it.each(APARTMENT_VARIANTS)("apartments, %s: stand on the ground with walls, accents, glass and a car park entrance, within the kit's budget", (variant) => {
    checkModel(apartmentModel(variant), 1500);
  });

  it("pick an apartment building's variant by where it stands, all variants turning up", () => {
    expect(apartmentLook({ x: 80, y: 40 })).toEqual(apartmentLook({ x: 80, y: 40 }));
    const seen = new Set(Array.from({ length: 60 }, (_, i) => apartmentLook({ x: i * 54, y: 27 }).variant));
    expect(seen.size).toBe(APARTMENT_VARIANTS.length);
  });

  it.each(Object.values(COMMERCIAL_VARIANTS).flat())("shops and offices, %s: stand on the ground with glass and a place for their name, within the kit's budget", (variant) => {
    const model = commercialModel(variant);
    const position = model.geometry.getAttribute("position");
    expect(Math.min(...Array.from({ length: position.count }, (_, i) => position.getY(i)))).toBeCloseTo(0, 6);
    expect(Array.from(model.geometry.getAttribute("role").array)).toContain(ROLE.glass);
    expect(model.sign).toBeDefined();
    expect(position.count / 3).toBeLessThan(1500);
  });

  it.each([
    ["villa", (c: Lot["centre"]) => villaModel(villaLook(c).variant)],
    ["apartment", (c: Lot["centre"]) => apartmentModel(apartmentLook(c).variant)],
    ["largeOffice", (c: Lot["centre"]) => commercialModel(commercialLook("largeOffice", c).variant)],
    ["smallOffice", (c: Lot["centre"]) => commercialModel(commercialLook("smallOffice", c).variant)],
  ] as const)("put the %s's garage where its driveway meets it, the driveway off-centre either way", (building, modelAt) => {
    const kit = new BuildingKit();
    for (const [x, door] of [[0, 7], [40, -7], [80, 3], [120, -3]]) {
      // Along the road (+x), the building beyond it (+y); the driveway `door` from the lot's middle.
      const centre = { x, y: 30 };
      const { length, depth } = buildingSize({ building: building as Building });
      const lot: Lot = { building: building as Building, level: 1, centre, along: { x: 1, y: 0 }, out: { x: 0, y: 1 }, at: 0, door: { x: x + door, y: 10 }, front: 10, length, depth };
      const group = kit.model(lot);
      group.updateMatrixWorld(true);
      const model = modelAt(centre);
      let found: Mesh | undefined;
      group.traverse((o) => {
        if ((o as Mesh).geometry === model.geometry) found = o as Mesh;
      });
      const garage = found!.localToWorld(new Vector3(model.garageX, 0, model.minZ));
      expect(garage.x).toBeCloseTo(x + door, 0);
    }
  });

  it.each(CAR_TYPES)("cars, %s: stand on the ground, no longer than the cars the simulation spaces, painted per car (a taxi is always yellow)", (type) => {
    const model = carModel(type);
    const ys = (g: typeof model.rest) => Array.from({ length: g.getAttribute("position").count }, (_, i) => g.getAttribute("position").getY(i));
    expect(Math.min(...ys(model.rest))).toBeCloseTo(0, 6);
    model.rest.computeBoundingBox();
    const box = model.rest.boundingBox!;
    expect(box.max.x - box.min.x).toBeLessThanOrEqual(CAR_LENGTH + 0.01);
    expect(model.paint.getAttribute("position").count > 0).toBe(type !== "taxi");
  });
});
