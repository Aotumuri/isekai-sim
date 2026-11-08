import assert from "node:assert/strict";
import test from "node:test";
import { createSocietyWorld } from "../helpers/society-world";
import { updateSupplyAssessment } from "../../src/sim/supply-assessment";
import { EQUIPMENT_FAMILIES, getResearchPortfolio, getNationalDesign, getNationalResearchSummary, updateResearch,
  getResearchCost, emptyResearchLevels, designFromResearch, cargoCapacityMultiplier, getResearchPriorities } from "../../src/sim/research";
function scene() {
  const world = createSocietyWorld(), nation = world.nations[0]!;
  nation.resources.steel = nation.resources.weapons = 1000; updateSupplyAssessment(world);
  return { world, nation };
}
test("equipment programs have independent levels, progress, focus and priorities", () => {
  const { world, nation } = scene();
  for (const family of EQUIPMENT_FAMILIES) getResearchPortfolio(world, nation.id, family).priority = "paused";
  const tank = getResearchPortfolio(world, nation.id, "Tank"); tank.priority = "high"; tank.focus = "mobility";
  tank.progress.mobility = getResearchCost(tank, "mobility") - 0.001;
  updateResearch(world);
  assert.equal(tank.levels.mobility, 1); assert(tank.lastScience > 0);
  for (const family of ["Infantry", "CombatShip", "TransportShip"] as const) {
    const program = getResearchPortfolio(world, nation.id, family);
    assert.equal(program.lastScience, 0); assert.equal(program.levels.mobility, 0); assert.equal(program.totalScience, 0);
    assert.equal(getNationalDesign(world, nation.id, family).mobility, 1);
  }
  assert(getNationalDesign(world, nation.id, "Tank").mobility! > 1);
});
test("all equipment programs divide one national science budget and pauses preserve work", () => {
  const first = scene(), second = scene();
  for (const family of EQUIPMENT_FAMILIES) {
    getResearchPortfolio(first.world, first.nation.id, family).priority = family === "Infantry" ? "high" : "paused";
    getResearchPortfolio(second.world, second.nation.id, family).priority = "normal";
  }
  updateResearch(first.world); updateResearch(second.world);
  assert.equal(first.nation.resources.steel, second.nation.resources.steel);
  assert.equal(first.nation.resources.weapons, second.nation.resources.weapons);
  assert(Math.abs(getNationalResearchSummary(first.world, first.nation.id).lastScience - getNationalResearchSummary(second.world, second.nation.id).lastScience) < 1e-9);
  const infantry = getResearchPortfolio(first.world, first.nation.id); const before = infantry.progress.firepower;
  infantry.priority = "paused"; first.world.time.slowTick++; updateResearch(first.world);
  assert.equal(infantry.progress.firepower, before); assert.equal(infantry.lastScience, 0);
});
test("family-specific upgrades have real benefits, costs and compensating research", () => {
  const { nation } = scene();
  const tank = designFromResearch(nation.id, { ...emptyResearchLevels(), armor: 6, mobility: 6 }, "Tank");
  assert(tank.armor! > 1 && tank.mobility! > 1 && tank.weaponCost > 1 && tank.fuelUse > 1 && tank.reliability < 1);
  const mature = designFromResearch(nation.id, { ...tank.levels, materials: 6, fuel: 6, reliability: 6 }, "Tank");
  assert(mature.weaponCost < tank.weaponCost && mature.fuelUse < tank.fuelUse && mature.reliability > tank.reliability);
  const gun = designFromResearch(nation.id, { ...emptyResearchLevels(), handling: 6, armor: 10, capacity: 10 }, "Infantry");
  assert(gun.handling! > 1 && gun.recovery > 1); assert.equal(gun.armor, 1); assert.equal(gun.capacity, 1);
  const ship = designFromResearch(nation.id, { ...emptyResearchLevels(), firepower: 5, armor: 5, mobility: 5 }, "CombatShip");
  assert(ship.firepower > 1 && ship.armor! > 1 && ship.mobility! > 1);
});
test("transport payload has strictly diminishing gains and a bounded late-game ceiling", () => {
  let previousGain = Infinity;
  for (let level = 1; level <= 10; level++) {
    const gain = cargoCapacityMultiplier(level) - cargoCapacityMultiplier(level - 1);
    assert(gain > 0 && gain < previousGain); previousGain = gain;
  }
  assert(cargoCapacityMultiplier(10) < 2.6);
  assert.equal(cargoCapacityMultiplier(100000), cargoCapacityMultiplier(10));
  assert.equal(cargoCapacityMultiplier(NaN), 1);
});
test("branch focus is restricted to the selected equipment class", () => {
  const { world, nation } = scene();
  const tank = getResearchPortfolio(world, nation.id, "Tank"); tank.focus = "armor";
  const weights = getResearchPriorities(world, nation.id, "Tank"); assert(weights.armor > weights.firepower);
  assert.equal(getResearchPriorities(world, nation.id, "Infantry").armor, 0);
  assert.equal(getResearchPriorities(world, nation.id, "TransportShip").firepower, 0);
});

test("legacy unified technology migrates once and then separates without sharing mutable levels", () => {
  const { world, nation } = scene();
  const legacy = getResearchPortfolio(world, nation.id);
  legacy.levels.firepower = 4; legacy.levels.fuel = 3; legacy.progress.reliability = 12; delete legacy.programs;
  const tank = getResearchPortfolio(world, nation.id, "Tank"), ship = getResearchPortfolio(world, nation.id, "CombatShip");
  assert.equal(tank.levels.firepower, 4); assert.equal(tank.levels.fuel, 3); assert.equal(ship.levels.firepower, 4);
  assert.equal(tank.progress.reliability, 12);
  tank.levels.firepower = 5; assert.equal(ship.levels.firepower, 4); assert.equal(legacy.levels.firepower, 4);
  assert.equal(getResearchPortfolio(world, nation.id).levels.fuel, 0);
});

test("recognized exile governments retain separate research programs while work pauses", async () => {
  const { createExileWorld } = await import("../helpers/exile-world");
  const { updateSurrender } = await import("../../src/sim/surrender");
  const { world, a } = createExileWorld();
  const tank = getResearchPortfolio(world, a.id, "Tank"); tank.levels.armor = 5; tank.progress.mobility = 20;
  updateSurrender(world); updateResearch(world);
  assert.equal(getResearchPortfolio(world, a.id, "Tank"), tank);
  assert.equal(tank.levels.armor, 5); assert.equal(tank.progress.mobility, 20);
  assert.equal(tank.status, "government in exile"); assert.equal(tank.lastScience, 0);
});
