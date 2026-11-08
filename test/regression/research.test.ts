import assert from "node:assert/strict";
import test from "node:test";
import { designFromResearch, emptyResearchLevels, getResearchCost, getResearchPortfolio, getResearchPriorities,
  getResearchState, RESEARCH_BRANCHES, EQUIPMENT_FAMILIES, updateResearch } from "../../src/sim/research";
import { updateSupplyAssessment } from "../../src/sim/supply-assessment";
import { createSocietyWorld } from "../helpers/society-world";

function fundedWorld() {
  const world = createSocietyWorld();
  const nation = world.nations[0]!;
  nation.resources.steel = 1000; nation.resources.weapons = 1000;
  updateSupplyAssessment(world);
  return { world, nation, portfolio: getResearchPortfolio(world, nation.id) };
}

test("research spends real resources, preserves parallel progress and completes incremental projects", () => {
  const { world, nation, portfolio } = fundedWorld();
  portfolio.focus = "firepower";
  portfolio.progress.firepower = getResearchCost(portfolio, "firepower") - 0.001;
  const before = { ...nation.resources };
  updateResearch(world);
  assert.equal(portfolio.levels.firepower, 1);
  assert(portfolio.progress.reliability > 0);
  assert(nation.resources.steel < before.steel && nation.resources.weapons < before.weapons);
  assert(Math.abs(before.steel - nation.resources.steel - getResearchState(world).steelSpent) < 1e-8);
  const progress = portfolio.totalScience;
  updateResearch(world);
  assert.equal(portfolio.totalScience, progress);
});

test("research pauses without a budget and when disabled, and stops at the level cap", () => {
  const { world, nation, portfolio } = fundedWorld();
  nation.resources.steel = 0; nation.resources.weapons = 0;
  updateResearch(world);
  assert.equal(portfolio.status, "saving resources");
  assert.equal(portfolio.totalScience, 0);
  world.time.slowTick += 1; world.settings!.researchEnabled = false;
  nation.resources.steel = 1000; nation.resources.weapons = 1000;
  updateResearch(world);
  assert.equal(portfolio.totalScience, 0);
  world.settings!.researchEnabled = true;
  for (const family of EQUIPMENT_FAMILIES) for (const branch of RESEARCH_BRANCHES) getResearchPortfolio(world, nation.id, family).levels[branch] = 10;
  updateResearch(world);
  assert.equal(portfolio.status, "complete");
  assert.equal(nation.resources.steel, 1000);
});

test("firepower carries resource and reliability penalties that other research can offset", () => {
  const { nation } = fundedWorld();
  const heavy = designFromResearch(nation.id, { ...emptyResearchLevels(), firepower: 8 }, "Tank");
  const mature = designFromResearch(nation.id, { ...emptyResearchLevels(), firepower: 8, reliability: 8, materials: 8, fuel: 8 }, "Tank");
  assert(heavy.firepower > 1 && heavy.weaponCost > 1 && heavy.fuelUse > 1 && heavy.reliability < 1);
  assert.equal(mature.firepower, heavy.firepower);
  assert(mature.reliability > heavy.reliability && mature.weaponCost < heavy.weaponCost && mature.fuelUse < heavy.fuelUse);
});

test("national doctrine, shortages and manual focus change research priorities", () => {
  const { world, nation, portfolio } = fundedWorld();
  nation.character = { doctrine: "merchant", aggression: 0.25, cooperation: 0.9, innovation: 0.5, thrift: 0.85 };
  const merchant = getResearchPriorities(world, nation.id);
  nation.character.doctrine = "guardian";
  const guardian = getResearchPriorities(world, nation.id);
  assert(merchant.production > guardian.production);
  assert(guardian.reliability > merchant.reliability);
  const beforeFuel = getResearchPriorities(world, nation.id, "Tank").fuel;
  nation.resourceFlow.delta.fuel = -10;
  assert(getResearchPriorities(world, nation.id, "Tank").fuel > beforeFuel);
  portfolio.focus = "firepower";
  assert(getResearchPriorities(world, nation.id).firepower > guardian.firepower);
});

test("the military economy reserves enough steel for research instead of consuming the entire science budget", async () => {
  const { updateProduction } = await import("../../src/sim/production");
  const { world, nation, portfolio } = fundedWorld();
  nation.resources.steel = 10;
  nation.resources.weapons = 20;
  nation.nextUnitProductionTick = Infinity;
  updateProduction(world);
  const scienceStock = nation.resources.steel;
  assert(scienceStock >= 8);
  updateResearch(world);
  assert.equal(portfolio.status, "researching");
  assert(nation.resources.steel < scienceStock);
});
