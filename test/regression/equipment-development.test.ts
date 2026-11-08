import assert from "node:assert/strict";
import test from "node:test";
import { createUnitForType } from "../../src/sim/create-units";
import { getDevelopedUnitWeaponCost, refitUnit } from "../../src/sim/equipment-development";
import { designFromResearch, emptyResearchLevels, getResearchPortfolio, EQUIPMENT_FAMILIES } from "../../src/sim/research";
import { updateProduction } from "../../src/sim/production";
import { updateSupplyAssessment } from "../../src/sim/supply-assessment";
import { getUnitCombatStrength } from "../../src/sim/unit-strength";
import { createUnitId } from "../../src/sim/unit";
import { createSocietyWorld } from "../helpers/society-world";

function preparedWorld() {
  const world = createSocietyWorld(), nation = world.nations[0]!;
  for (const item of world.nations) item.nextUnitProductionTick = Infinity;
  nation.resources = { manpower: 100_000, weapons: 10_000, steel: 10_000, fuel: 10_000 };
  updateSupplyAssessment(world);
  return { world, nation, portfolio: getResearchPortfolio(world, nation.id) };
}

test("new production fields researched designs and pays their actual weapons cost", () => {
  const { world, nation, portfolio } = preparedWorld();
  for (const family of EQUIPMENT_FAMILIES) { const program = getResearchPortfolio(world, nation.id, family); program.levels.firepower = family === "TransportShip" ? 0 : 5; program.levels.reliability = 5; }
  nation.nextUnitProductionTick = 0;
  const originalIds = new Set(world.units.map((unit) => unit.id));
  updateProduction(world);
  const built = world.units.filter((unit) => unit.nationId === nation.id && !originalIds.has(unit.id));
  assert(built.length > 0);
  for (const unit of built) {
    assert.equal(unit.design?.generation, unit.type === "TransportShip" ? 5 : 10);
    assert(getUnitCombatStrength(unit) > getUnitCombatStrength({ ...unit, design: undefined }));
    assert(getDevelopedUnitWeaponCost(unit.type, unit.design) > getDevelopedUnitWeaponCost(unit.type));
  }
  assert.equal(nation.resourceFlow.usage.weapons, built.reduce((sum, unit) => sum + getDevelopedUnitWeaponCost(unit.type, unit.design), 0));
});

test("refits cost resources at a supplied facility and do not instantly upgrade every unit", () => {
  const { world, nation, portfolio } = preparedWorld();
  portfolio.levels.firepower = 2;
  const unit = world.units.find((item) => item.nationId === nation.id)!;
  const before = nation.resources.weapons, manpower = unit.manpower;
  assert(refitUnit(world, unit.id));
  assert.equal(unit.manpower, manpower);
  assert.equal(unit.design?.generation, 2);
  assert(nation.resources.weapons < before);
  portfolio.levels.firepower = 5;
  assert.equal(unit.design?.generation, 2);
  unit.moveToId = world.mesoRegions.find((region) => region.id !== unit.regionId)!.id;
  assert.equal(refitUnit(world, unit.id), false);
});

test("researched fuel economy affects operating consumption and keeps designs after fuel-status updates", () => {
  const { world, nation } = preparedWorld();
  const tank = createUnitForType(createUnitId(world.unitIdCounter++), nation.id, nation.capitalMesoId, "Tank");
  tank.design = designFromResearch(nation.id, { ...emptyResearchLevels(), firepower: 8 }, "Tank");
  world.units.push(tank);
  updateProduction(world);
  const heavyConsumption = nation.resourceFlow.usage.fuel;
  const heavyDesign = tank.design;
  tank.design = designFromResearch(nation.id, { ...emptyResearchLevels(), firepower: 8, fuel: 8 }, "Tank");
  world.time.slowTick += 1;
  updateProduction(world);
  assert(nation.resourceFlow.usage.fuel < heavyConsumption);
  assert(tank.design.firepower === heavyDesign.firepower && tank.combatPower > 0);
});
