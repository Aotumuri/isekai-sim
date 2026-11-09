import assert from "node:assert/strict";
import test from "node:test";
import { getRelation, proposeTreaty } from "../../src/sim/diplomacy";
import { addPersecutionImpact, createPersecutionImpact, getPublicOutrage, publishPersecutionImpact } from "../../src/sim/persecution-reaction";
import { getNationalPolitics } from "../../src/sim/politics";
import { POPULATION_DIMENSIONS } from "../../src/sim/regional-population";
import { createSimulationSettings } from "../../src/sim/simulation-settings";
import { isTradeEmbargoed } from "../../src/sim/trade-embargo";
import { getOwnerByMesoId } from "../../src/sim/world-cache";
import { createSeededWorld } from "../helpers/seeded-world";

function scene() {
  const world = createSeededWorld({ quick: true });
  world.settings = createSimulationSettings({ politicalTurbulenceEnabled: true });
  return world;
}

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
