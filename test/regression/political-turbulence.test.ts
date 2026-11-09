import assert from "node:assert/strict";
import test from "node:test";
import { getRelation } from "../../src/sim/diplomacy";
import { updateNationalistMovements } from "../../src/sim/nationalist-movements";
import { getForeignClaims } from "../../src/sim/territorial-claims";
import { createSocietyWorld } from "../helpers/society-world";

function scene() {
  const world = createSocietyWorld();
  world.settings!.politicalTurbulenceEnabled = true;
  return world;
}

test("reunification movements claim matching districts beyond the border and then expire", () => {
  const world = scene();
  const [a, b] = world.nations;
  a.populationPolicy = { type: "homeland", group: 0 };
  const districts = world.macroRegions.filter(({ nationId }) => nationId === b.id).flatMap(({ mesoRegionIds }) => mesoRegionIds);
  for (const id of districts) {
    const population = world.regionalPopulations!.get(id)!;
    population.ancestry = [population.size, 0, 0, 0, 0, 0];
  }
  const before = getForeignClaims(world, a.id, b.id).length;
  world.time.slowTick = 120;
  updateNationalistMovements(world);
  assert.equal(a.nationalistMovement?.targetId, b.id);
  assert.equal(getForeignClaims(world, a.id, b.id).length, districts.length);
  assert.ok(before < districts.length);
  assert.ok(getRelation(world, a.id, b.id).grievance >= 30);
  world.time.slowTick = 360;
  assert.equal(getForeignClaims(world, a.id, b.id).length, before);
});
