import assert from "node:assert/strict";
import test from "node:test";
import { getRelation } from "../../src/sim/diplomacy";
import { getDomesticUnrest } from "../../src/sim/domestic-unrest";
import { startDisplacementOrder, updateForcedDisplacement } from "../../src/sim/forced-displacement";
import { getNationalPolitics } from "../../src/sim/politics";
import { POPULATION_DIMENSIONS } from "../../src/sim/regional-population";
import { createSimulationSettings } from "../../src/sim/simulation-settings";
import { getAdjacentNationPairs, getOwnerByMesoId } from "../../src/sim/world-cache";
import { createSeededWorld } from "../helpers/seeded-world";

function scene() {
  const world = createSeededWorld({ quick: true });
  world.settings = createSimulationSettings();
  const [a, b] = getAdjacentNationPairs(world)[0]!;
  return { world, a: world.nations.find((nation) => nation.id === a)!, b };
}

for (const type of ["homeland", "religious"] as const) {
  test(`${type} expulsions move only the targeted group and preserve population`, () => {
    const { world, a, b } = scene();
    const dimension = type === "homeland" ? "ancestry" : "faith";
    a.populationPolicy = { type, group: 0 };
    const populations = world.regionalPopulations!, owners = getOwnerByMesoId(world);
    const own = [...populations].filter(([id]) => owners.get(id) === a.id).map(([, population]) => population);
    const total = () => [...populations.values()].reduce((sum, population) => sum + population.size, 0);
    const group = (index: number) => own.reduce((sum, population) => sum + population[dimension][index]!, 0);
    const before = total(), protectedCount = group(0), targetCount = group(1);
    const opinion = getRelation(world, a.id, b).opinion;
    assert(!startDisplacementOrder(world, a, 0));
    assert(startDisplacementOrder(world, a, 1));
    world.time.slowTick = 10;
    updateForcedDisplacement(world);
    assert(a.displacementOrder!.displaced > 0);
    assert.equal(group(0), protectedCount);
    assert(group(1) < targetCount);
    assert(Math.abs(total() - before) < 1e-8);
    assert(getDomesticUnrest(world, a.id).pressure > 0);
    assert(getRelation(world, a.id, b).opinion < opinion);
    for (const population of populations.values()) for (const category of POPULATION_DIMENSIONS) {
      assert(Math.abs(population[category].reduce((sum, count) => sum + count, 0) - population.size) < 1e-8);
    }
    a.populationPolicy = undefined;
    world.time.slowTick = 20;
    updateForcedDisplacement(world);
    assert.equal(a.displacementOrder, undefined);
  });
}

test("a monarchy in severe crisis can issue a homeland expulsion order", () => {
  const { world, a } = scene();
  a.populationPolicy = { type: "homeland", group: 0 };
  getNationalPolitics(world, a).system = "monarchy";
  getDomesticUnrest(world, a.id).pressure = 97;
  world.time.slowTick = 10;
  updateForcedDisplacement(world);
  assert(a.displacementOrder);
  assert.notEqual(a.displacementOrder.group, 0);
});
