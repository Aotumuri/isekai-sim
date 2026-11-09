import assert from "node:assert/strict";
import test from "node:test";
import { getRelation } from "../../src/sim/diplomacy";
import { FINANCIAL_AID, sendFinancialAid } from "../../src/sim/financial-aid";
import { foodStorageLimit, updateFoodSupply } from "../../src/sim/food-supply";
import { expandGrainStorage } from "../../src/sim/grain-storage";
import { resourceReserve } from "../../src/sim/international-trade";
import { canIrrigate, installIrrigation } from "../../src/sim/irrigation";
import { updatePopulationMigration } from "../../src/sim/population-migration";
import { setFoodAsylum, setGrainExportProtection, setRationPolicy } from "../../src/sim/ration-policy";
import { createSimulationSettings } from "../../src/sim/simulation-settings";
import { updateSupplyAssessment } from "../../src/sim/supply-assessment";
import { getAdjacentNationPairs } from "../../src/sim/world-cache";
import { createSeededWorld } from "../helpers/seeded-world";

function scene() {
  const world = createSeededWorld({ quick: true });
  world.settings = createSimulationSettings();
  return world;
}

test("emergency rations conserve food without treating the planned ration as a famine", () => {
  const world = scene(), nation = world.nations[0]!, food = nation.food!;
  assert(setRationPolicy(world, nation.id, "emergency"));
  const previous = food.stock;
  world.time.slowTick = 10;
  updateFoodSupply(world);
  assert.equal(food.rationCoverage, 0.88);
  assert.equal(food.shortageCycles, 0);
  assert(Math.abs(food.stock - (previous + food.harvest - food.demand * 0.88)) < 1e-8);
  assert(setGrainExportProtection(world, nation.id, true));
  assert.equal(resourceReserve(nation, "food"), food.demand * 6);
});

test("irrigation increases harvest and reserve construction increases storage without adding grain", () => {
  const world = scene(), nation = world.nations[0]!, food = nation.food!;
  updateSupplyAssessment(world);
  nation.treasury!.balance = nation.resources.steel = 1000;
  const before = food.stock, capacity = foodStorageLimit(food.demand);
  assert(expandGrainStorage(world, nation.id));
  assert(foodStorageLimit(food.demand, food.storageLevel) > capacity);
  assert.equal(food.stock, before);
  const site = [...world.agriculturalLand!.keys()].find((id) =>
    canIrrigate(world, nation.id, id) && installIrrigation(world, nation.id, id));
  assert(site);
  assert(!installIrrigation(world, nation.id, site));
  const initialHarvest = food.harvest;
  world.time.slowTick = 10;
  updateFoodSupply(world);
  assert(food.harvest > initialHarvest);
});

test("an open reception policy increases famine refugee arrivals without creating population", () => {
  const baseline = scene(), open = scene();
  const [origin, destination] = getAdjacentNationPairs(open)[0]!;
  for (const world of [baseline, open]) {
    world.nations.find((nation) => nation.id === origin)!.food!.rationCoverage = 0;
    const total = () => [...world.regionalPopulations!.values()].reduce((sum, population) => sum + population.size, 0);
    const before = total();
    if (world === open) assert(setFoodAsylum(world, destination, true));
    world.time.slowTick = 10;
    updatePopulationMigration(world);
    assert(Math.abs(total() - before) < 1e-8);
  }
  const received = (world: typeof open) => world.nations.find((nation) => nation.id === destination)!.food!.refugeesReceived!;
  assert(received(open) > received(baseline));
});

test("allied financial aid conserves cash and enforces a cooldown", () => {
  const world = scene(), [donor, recipient] = world.nations;
  assert(donor && recipient);
  donor.treasury!.balance = 100;
  assert(!sendFinancialAid(world, donor.id, recipient.id));
  getRelation(world, donor.id, recipient.id).treaties.push({ type: "alliance", expiresAtSlowTick: 100 });
  const before = recipient.treasury!.balance;
  assert(sendFinancialAid(world, donor.id, recipient.id));
  assert.equal(donor.treasury!.balance, 100 - FINANCIAL_AID);
  assert.equal(recipient.treasury!.balance, before + FINANCIAL_AID);
  assert(!sendFinancialAid(world, donor.id, recipient.id));
});
