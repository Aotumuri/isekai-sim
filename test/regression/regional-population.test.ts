import assert from "node:assert/strict";
import test from "node:test";
import { getNationName } from "../../src/sim/nation-identity";
import { exchangePortPopulation, updatePopulationMigration } from "../../src/sim/population-migration";
import { getHomelandClaimBonus, updatePopulationPolitics } from "../../src/sim/population-politics";
import { getRegionalPopulations, groupAffinity, POPULATION_DIMENSIONS } from "../../src/sim/regional-population";
import { getOwnerByMesoId } from "../../src/sim/world-cache";
import { createSocietyWorld } from "../helpers/society-world";

test("seeded distributions are repeatable and land-only", () => {
  const world = createSocietyWorld();
  const populations = getRegionalPopulations(world);
  assert.deepEqual(populations, getRegionalPopulations(createSocietyWorld()));
  assert.equal(populations.size, world.mesoRegions.filter((region) => region.type !== "sea").length);
  assert(groupAffinity(0, 1) > groupAffinity(0, 3));
  assert.equal(groupAffinity(0, 1), groupAffinity(1, 0));
});

test("overland and port migration preserve every group and update local composition", () => {
  const world = createSocietyWorld();
  const before = getRegionalPopulations(world);
  const totals = () => POPULATION_DIMENSIONS.flatMap((dimension) =>
    before.values().next().value![dimension].map((_, i) =>
      [...getRegionalPopulations(world).values()].reduce((sum, p) => sum + p[dimension][i]!, 0)));
  const expected = totals();
  world.time.slowTick = 10;
  updatePopulationMigration(world);
  assert.notDeepEqual(before, getRegionalPopulations(world));
  const [from, to] = [...before.keys()];
  assert(from && to);
  exchangePortPopulation(world, from, to);
  totals().forEach((actual, i) => assert(Math.abs(actual - expected[i]!) < 1e-8));
  for (const p of getRegionalPopulations(world).values()) {
    for (const dimension of POPULATION_DIMENSIONS) {
      assert(p[dimension].every((count) => count >= 0));
      assert(Math.abs(p[dimension].reduce((sum, count) => sum + count, 0) - p.size) < 1e-8);
    }
  }
});

test("cohesionist self-determination gives way to a state religion after a mandate change", () => {
  const world = createSocietyWorld();
  const nation = world.nations[0]!;
  const populations = getRegionalPopulations(world);
  for (const [id, owner] of getOwnerByMesoId(world)) {
    if (owner !== nation.id) continue;
    const p = populations.get(id);
    if (!p) continue;
    p.faith = [p.size, 0, 0, 0, 0, 0];
  }
  const capital = populations.get(nation.capitalMesoId)!;
  capital.ancestry = [capital.size, 0, 0, 0, 0, 0];
  nation.ideologyId = "cohesionism";
  world.time.slowTick = 10;
  updatePopulationPolitics(world);
  assert.match(getNationName(world, nation.id), /Auvren Homeland/);
  assert.equal(getNationName(world, nation.id, "short"), nation.name);
  assert(getHomelandClaimBonus(world, nation.id, nation.capitalMesoId) > 0);
  nation.ideologyId = "capitalism";
  world.time.slowTick = 20;
  updatePopulationPolitics(world);
  assert.match(getNationName(world, nation.id), /Ember Covenant Holy State/);
  assert.equal(getNationName(world, nation.id, "short"), nation.name);
  assert.equal(getHomelandClaimBonus(world, nation.id, nation.capitalMesoId), 0);
});
