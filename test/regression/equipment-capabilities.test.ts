import assert from "node:assert/strict";
import test from "node:test";
import { createSocietyWorld } from "../helpers/society-world";
import { createUnitForType } from "../../src/sim/create-units";
import { createUnitId } from "../../src/sim/unit";
import { designFromResearch, emptyResearchLevels, getResearchPortfolio } from "../../src/sim/research";
import { equipNewUnit, refitUnit } from "../../src/sim/equipment-development";
import { getMoveMsPerRegion } from "../../src/sim/movement";
import { getUnitCombatStrength } from "../../src/sim/unit-strength";
import { getUnitTransportCapacity, planTransportLoading } from "../../src/sim/unit-capabilities";
import { updateSupplyAssessment } from "../../src/sim/supply-assessment";
import { updateBattles } from "../../src/sim/battles";
import { declareWar } from "../../src/sim/war-state";

test("production and refits use only the matching equipment program", () => {
  const world = createSocietyWorld(), nation = world.nations[0]!;
  nation.resources.steel = nation.resources.weapons = 1000;
  getResearchPortfolio(world, nation.id, "Tank").levels.mobility = 5;
  updateSupplyAssessment(world);
  const tank = equipNewUnit(world, createUnitForType(createUnitId(world.unitIdCounter++), nation.id, nation.capitalMesoId, "Tank"));
  const rifle = equipNewUnit(world, createUnitForType(createUnitId(world.unitIdCounter++), nation.id, nation.capitalMesoId, "Infantry"));
  assert.equal(tank.design?.family, "Tank"); assert.equal(tank.design?.generation, 5);
  assert.equal(rifle.design?.generation, 0);
  world.units.push(tank, rifle);
  getResearchPortfolio(world, nation.id, "Infantry").levels.handling = 4;
  assert(refitUnit(world, rifle.id)); assert.equal(rifle.design?.generation, 4);
  assert.equal(tank.design?.generation, 5);
});
test("researched speed shortens movement and gun handling increases effective fire", () => {
  const world = createSocietyWorld(), nation = world.nations[0]!;
  const tank = createUnitForType(createUnitId(999), nation.id, nation.capitalMesoId, "Tank");
  const baseTime = getMoveMsPerRegion(tank);
  tank.design = designFromResearch(nation.id, { ...emptyResearchLevels(), mobility: 5 }, "Tank");
  assert(getMoveMsPerRegion(tank) < baseTime);
  tank.moveTicksPerRegion = Infinity; assert.equal(getMoveMsPerRegion(tank), Infinity);
  const rifle = createUnitForType(createUnitId(1000), nation.id, nation.capitalMesoId, "Infantry");
  const baseStrength = getUnitCombatStrength(rifle);
  rifle.design = designFromResearch(nation.id, { ...emptyResearchLevels(), handling: 5 }, "Infantry");
  assert(getUnitCombatStrength(rifle) > baseStrength);
});
test("armor reduces actual battlefield losses instead of merely changing a displayed statistic", () => {
  const fight = (armored: boolean) => {
    const world = createSocietyWorld(), [a, b] = world.nations;
    const target = world.mesoRegions.find((region) => region.id === b.capitalMesoId)!;
    const source = target.neighbors.find((neighbor) => world.mesoRegions.find((region) => region.id === neighbor.id)?.type !== "sea")!.id;
    const attacker = createUnitForType(createUnitId(900), a.id, source, "Tank"); attacker.moveToId = target.id;
    const defender = createUnitForType(createUnitId(901), b.id, target.id, "Tank");
    if (armored) defender.design = designFromResearch(b.id, { ...emptyResearchLevels(), armor: 8 }, "Tank");
    world.units = [attacker, defender]; world.wars = []; declareWar(world.wars, a.id, b.id, 0);
    updateBattles(world); return defender;
  };
  const normal = fight(false), armored = fight(true);
  assert(armored.manpower > normal.manpower); assert(armored.org > normal.org);
});
test("mixed transport designs load their real capacities atomically and stay bounded at late research levels", () => {
  const world = createSocietyWorld(), nation = world.nations[0]!;
  const old = createUnitForType(createUnitId(900), nation.id, nation.capitalMesoId, "TransportShip");
  const modern = createUnitForType(createUnitId(901), nation.id, nation.capitalMesoId, "TransportShip");
  modern.design = designFromResearch(nation.id, { ...emptyResearchLevels(), capacity: 10 }, "TransportShip");
  assert.equal(getUnitTransportCapacity(old), 10); assert.equal(getUnitTransportCapacity(modern), 25);
  const force = Array.from({ length: 35 }, (_, index) => createUnitForType(createUnitId(1000 + index), nation.id, nation.capitalMesoId, "Infantry"));
  const loading = planTransportLoading([old, modern], force)!;
  assert.deepEqual(loading.map((entry) => entry.cargo.length), [10, 25]);
  assert.equal(new Set(loading.flatMap((entry) => entry.cargo.map((unit) => unit.id))).size, 35);
  assert.equal(planTransportLoading([modern], force), null); assert.equal(modern.cargoUnits.length, 0);
});
