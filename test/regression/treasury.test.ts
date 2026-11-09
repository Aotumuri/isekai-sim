import assert from "node:assert/strict";
import test from "node:test";
import { updateBudgetPolicies } from "../../src/sim/budget-policy";
import { getDomesticUnrest, updateDomesticUnrest } from "../../src/sim/domestic-unrest";
import { isMilitaryFunded, militaryFundingCost, updateMilitaryFunding } from "../../src/sim/military-funding";
import { updatePopulationMigration } from "../../src/sim/population-migration";
import { commissionPublicWork, getPublicWorkIssue, PUBLIC_WORKS, updatePublicWorks } from "../../src/sim/public-works";
import { distributePublicRelief, reliefCost } from "../../src/sim/public-relief";
import { updateResearch } from "../../src/sim/research";
import { createSimulationSettings } from "../../src/sim/simulation-settings";
import { updateSupplyAssessment } from "../../src/sim/supply-assessment";
import { setTaxRate, splitTreasury, updateTreasuries } from "../../src/sim/treasury";
import { getAdjacentNationPairs, getOwnerByMesoId } from "../../src/sim/world-cache";
import { createSeededWorld } from "../helpers/seeded-world";

function scene() {
  const world = createSeededWorld({ quick: true });
  world.settings = createSimulationSettings();
  return world;
}

test("taxes follow taxable population and collect once per interval", () => {
  const world = scene(), nation = world.nations[0]!, treasury = nation.treasury!;
  const owners = getOwnerByMesoId(world);
  const district = world.mesoRegions.find((region) => owners.get(region.id) === nation.id && region.type !== "sea")!;
  const removed = world.regionalPopulations!.get(district.id)!.size;
  const balance = treasury.balance, population = treasury.population;
  assert(setTaxRate(world, nation.id, 25));
  assert(!setTaxRate(world, nation.id, 99));
  world.occupation.mesoById.set(district.id, world.nations[1]!.id);
  world.time.slowTick = 10;
  updateTreasuries(world);
  const expected = (population - removed) * 0.25;
  assert(Math.abs(treasury.lastRevenue - expected) < 1e-8);
  assert(Math.abs(treasury.balance - balance - expected) < 1e-8);
  const collected = treasury.balance;
  updateTreasuries(world);
  assert.equal(treasury.balance, collected);
  const split = splitTreasury(treasury, 0.25)!;
  assert.equal(treasury.balance + split.balance, collected);
});

test("high taxes raise peacetime unrest, low taxes ease it and relief cannot be replayed", () => {
  const world = scene(), nation = world.nations[0]!, treasury = nation.treasury!;
  const unrest = getDomesticUnrest(world, nation.id);
  unrest.pressure = 35;
  assert(setTaxRate(world, nation.id, 30));
  world.time.slowTick = 10;
  updateDomesticUnrest(world);
  assert(unrest.pressure > 35);
  assert(setTaxRate(world, nation.id, 5));
  world.time.slowTick = 20;
  updateDomesticUnrest(world);
  assert(unrest.pressure < 35);
  const before = unrest.pressure, balance = treasury.balance;
  assert(distributePublicRelief(world, nation.id));
  assert.equal(unrest.pressure, before - 22);
  assert.equal(treasury.balance, balance - reliefCost(treasury));
  assert(!distributePublicRelief(world, nation.id));
});

test("military funds expire when the next appropriation cannot be paid", () => {
  const world = scene(), nation = world.nations[0]!, treasury = nation.treasury!;
  treasury.militaryFunding = true;
  treasury.balance = militaryFundingCost(treasury);
  world.time.slowTick = 10;
  updateMilitaryFunding(world);
  updateMilitaryFunding(world);
  assert(isMilitaryFunded(world, treasury));
  assert.equal(treasury.balance, 0);
  assert.equal(treasury.spent.military, militaryFundingCost(treasury));
  world.time.slowTick = 20;
  updateMilitaryFunding(world);
  assert(!isMilitaryFunded(world, treasury));
});

test("research funding spends cash only when materials support additional work", () => {
  const world = scene(), nation = world.nations[0]!, treasury = nation.treasury!;
  treasury.researchFunding = true;
  nation.resources.steel = 0;
  nation.resources.weapons = 100;
  updateSupplyAssessment(world);
  world.time.slowTick = 1;
  updateResearch(world);
  assert.equal(treasury.spent.research, 0);
  nation.resources.steel = 100;
  world.time.slowTick = 2;
  updateResearch(world);
  assert(treasury.spent.research > 0);
});

test("a funded city waits out occupation and consumes its budget only once", () => {
  const world = scene();
  updateSupplyAssessment(world);
  const owners = getOwnerByMesoId(world);
  const site = world.mesoRegions.find((region) => {
    const owner = world.nations.find((item) => item.id === owners.get(region.id));
    if (!owner?.treasury || region.building !== null || region.type === "sea") return false;
    owner.treasury.balance = owner.resources.steel = owner.resources.fuel = 200;
    return !getPublicWorkIssue(world, owner.id, region.id, "city");
  });
  assert(site);
  const owner = world.nations.find((item) => item.id === owners.get(site.id))!;
  const enemy = world.nations.find((item) => item.id !== owner.id)!;
  assert(commissionPublicWork(world, owner.id, site.id, "city"));
  assert(!commissionPublicWork(world, owner.id, site.id, "city"));
  const duration = PUBLIC_WORKS.city.duration;
  world.occupation.mesoById.set(site.id, enemy.id);
  world.occupation.version++;
  world.time.slowTick = duration;
  updatePublicWorks(world);
  assert.equal(site.building, null);
  assert.equal(world.publicWorks?.get(site.id)?.remaining, duration);
  world.occupation.mesoById.delete(site.id);
  world.occupation.version++;
  world.time.slowTick += duration;
  updatePublicWorks(world);
  assert.equal(site.building, "city");
  assert.equal(owner.treasury!.spent.construction, PUBLIC_WORKS.city.cash);
  assert(!world.publicWorks?.has(site.id));
});

test("automatic budgets lower taxes and offer relief during domestic crises", () => {
  const world = scene(), nation = world.nations[0]!, treasury = nation.treasury!;
  treasury.automaticBudget = true;
  treasury.balance = 1000;
  const unrest = getDomesticUnrest(world, nation.id);
  unrest.pressure = 70;
  world.time.slowTick = 10;
  updateBudgetPolicies(world);
  assert.equal(treasury.taxRate, 10);
  assert(unrest.pressure < 70);
  assert(treasury.researchFunding);
});

test("raising taxes shifts peaceful border migration away from the taxed country", () => {
  const baseline = scene(), taxed = scene();
  const [owner] = getAdjacentNationPairs(taxed)[0]!;
  assert(setTaxRate(taxed, owner, 30));
  for (const world of [baseline, taxed]) {
    world.time.slowTick = 10;
    updatePopulationMigration(world);
    updateTreasuries(world);
  }
  const population = (world: typeof baseline) => world.nations.find((nation) => nation.id === owner)!.treasury!.population;
  assert(population(taxed) < population(baseline));
});
