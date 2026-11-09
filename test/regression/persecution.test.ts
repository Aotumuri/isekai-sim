import assert from "node:assert/strict";
import test from "node:test";
import { getRelation, proposeTreaty } from "../../src/sim/diplomacy";
import { getDomesticUnrest } from "../../src/sim/domestic-unrest";
import { getPersecutionTargets, startDisplacementOrder, updateForcedDisplacement } from "../../src/sim/forced-displacement";
import { addPersecutionImpact, createPersecutionImpact, getPublicOutrage, publishPersecutionImpact } from "../../src/sim/persecution-reaction";
import { getNationalPolitics } from "../../src/sim/politics";
import { POPULATION_DIMENSIONS } from "../../src/sim/regional-population";
import { getReligiousBan, startReligiousBan, updateReligiousPersecution } from "../../src/sim/religious-persecution";
import { createSimulationSettings } from "../../src/sim/simulation-settings";
import { isTradeEmbargoed } from "../../src/sim/trade-embargo";
import { getOwnerByMesoId } from "../../src/sim/world-cache";
import { createSeededWorld } from "../helpers/seeded-world";

function scene() {
  const world = createSeededWorld({ quick: true });
  world.settings = createSimulationSettings({ politicalTurbulenceEnabled: true });
  return world;
}

test("a blanket religious ban harms every minority faith without converting its followers", () => {
  const world = scene(), [offender, first, second] = world.nations;
  assert.ok(!startReligiousBan(world, offender));
  offender.populationPolicy = { type: "religious", group: 0 };
  const populations = world.regionalPopulations!;
  for (const [id, owner] of getOwnerByMesoId(world)) {
    const population = populations.get(id)!;
    population.ancestry = [0, 0, 0, 0, 0, population.size];
    population.culture = [0, 0, 0, 0, 0, population.size];
    if (owner === offender.id) population.faith = [0.5, 0.1, 0.1, 0.1, 0.1, 0.1].map((share) => share * population.size);
    else {
      const faith = owner === first.id ? 1 : owner === second.id ? 2 : 0;
      population.faith = Array.from({ length: 6 }, (_, index) => index === faith ? population.size : 0);
      population.ancestry = [population.size, 0, 0, 0, 0, 0];
      population.culture = [population.size, 0, 0, 0, 0, 0];
    }
  }
  const before = structuredClone(populations);
  assert.ok(startReligiousBan(world, offender));
  world.time.slowTick = 10;
  updateReligiousPersecution(world);
  const pressure = getDomesticUnrest(world, offender.id).pressure;
  assert.ok(pressure > 0);
  assert.ok(getPublicOutrage(world, first.id, offender.id) > 0);
  assert.ok(getPublicOutrage(world, second.id, offender.id) > 0);
  assert.deepEqual(populations, before);
  updateReligiousPersecution(world);
  assert.equal(getDomesticUnrest(world, offender.id).pressure, pressure);
  world.time.slowTick = 150;
  updateReligiousPersecution(world);
  assert.equal(getReligiousBan(world, offender), undefined);
  assert.ok(!startReligiousBan(world, offender));
});

test("a killing order reduces population without moving it across borders", () => {
  const world = scene(), [offender, observer] = world.nations;
  offender.populationPolicy = { type: "homeland", group: 0 };
  const populations = world.regionalPopulations!, owners = getOwnerByMesoId(world);
  const own = [...populations].filter(([id]) => owners.get(id) === offender.id);
  const foreign = [...populations].filter(([id]) => owners.get(id) !== offender.id);
  for (const [, population] of own) {
    population.ancestry = [population.size, 0, 0, 0, 0, 0];
    population.culture = [population.size * 0.6, population.size * 0.4, 0, 0, 0, 0];
  }
  for (const [id, population] of foreign) {
    if (owners.get(id) === observer.id) population.culture = [0, population.size, 0, 0, 0, 0];
  }
  assert.ok(!getPersecutionTargets(world, offender).some(({ dimension, group }) => dimension === "culture" && group === 0));
  const original = own.reduce((sum, [, population]) => sum + population.size, 0);
  const protectedCulture = own.reduce((sum, [, population]) => sum + population.culture[0]!, 0);
  const foreignBefore = structuredClone(foreign);
  assert.ok(startDisplacementOrder(world, offender, 1, "killing", "culture"));
  world.time.slowTick = 10;
  updateForcedDisplacement(world);
  const dead = offender.displacementOrder?.killed ?? 0;
  assert.ok(dead > 0);
  assert.equal(offender.displacementOrder?.displaced, 0);
  assert.ok(Math.abs(original - own.reduce((sum, [, population]) => sum + population.size, 0) - dead) < 1e-8);
  assert.equal(own.reduce((sum, [, population]) => sum + population.culture[0]!, 0), protectedCulture);
  assert.deepEqual(foreign, foreignBefore);
  assert.ok(getPublicOutrage(world, observer.id, offender.id) > 0);
  for (const [, population] of own) for (const dimension of POPULATION_DIMENSIONS) {
    assert.ok(Math.abs(population[dimension].reduce((sum, count) => sum + count, 0) - population.size) < 1e-8);
  }
  updateForcedDisplacement(world);
  assert.equal(offender.displacementOrder?.killed, dead);
});

test("affected communities drive stronger democratic outrage regardless of shared ideology", () => {
  const world = scene(), [offender, democracy, monarchy, unrelated] = world.nations;
  assert.ok(unrelated);
  for (const nation of [offender, democracy, monarchy, unrelated]) nation.ideologyId = "capitalism";
  getNationalPolitics(world, democracy).system = "democracy";
  getNationalPolitics(world, monarchy).system = "monarchy";
  for (const [id, owner] of getOwnerByMesoId(world)) {
    const population = world.regionalPopulations!.get(id)!;
    const group = owner === democracy.id || owner === monarchy.id || owner === offender.id ? 0 : 1;
    for (const dimension of POPULATION_DIMENSIONS) {
      population[dimension] = Array.from({ length: 6 }, (_, index) => index === group ? population.size : 0);
    }
  }
  const source = world.regionalPopulations!.get(offender.capitalMesoId)!;
  const impact = createPersecutionImpact();
  addPersecutionImpact(impact, source, "ancestry", 0, 5);
  const relation = getRelation(world, democracy.id, offender.id);
  relation.treaties.push({ type: "alliance", expiresAtSlowTick: 600 }, { type: "truce", expiresAtSlowTick: 600 });
  for (const tick of [10, 20]) {
    world.time.slowTick = tick;
    publishPersecutionImpact(world, offender.id, impact, "forced expulsion");
  }
  assert.ok(getPublicOutrage(world, democracy.id, offender.id) > 65);
  assert.ok(getPublicOutrage(world, monarchy.id, offender.id) < 45);
  assert.equal(getPublicOutrage(world, unrelated.id, offender.id), 0);
  assert.equal(getPublicOutrage(world, offender.id, democracy.id), 0);
  assert.deepEqual(relation.treaties.map(({ type }) => type), ["truce"]);
  assert.ok(isTradeEmbargoed(world, democracy.id, offender.id));
  relation.opinion = relation.trust = 100;
  assert.equal(proposeTreaty(world, offender.id, democracy.id, "alliance"), false);
  world.time.slowTick = 1500;
  assert.equal(getPublicOutrage(world, democracy.id, offender.id), 0);
  assert.ok(!isTradeEmbargoed(world, democracy.id, offender.id));
});
