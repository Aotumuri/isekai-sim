import { getAdjacentNationPairs } from "../../src/sim/world-cache";
import assert from "node:assert/strict";
import test from "node:test";
import { createSocietyWorld } from "../helpers/society-world";
import { allFieldUnits, getArmyLimits, getMobilization, getMobilizationThreat, updateMobilization, updateDemobilization } from "../../src/sim/mobilization";
import { getRelation } from "../../src/sim/diplomacy";
import { updateWarCooperation } from "../../src/sim/war-cooperation";
import { declareWar } from "../../src/sim/war-state";
import { createUnitForType } from "../../src/sim/create-units";
import { createUnitId } from "../../src/sim/unit";
import { updateProduction } from "../../src/sim/production";
import { updateSupplyAssessment } from "../../src/sim/supply-assessment";
import { WORLD_BALANCE } from "../../src/data/balance";
import { createSeededWorld } from "../helpers/seeded-world";

const tick = (world: ReturnType<typeof createSocietyWorld>, count = 1) => {
  for (let i = 0; i < count; i++) { world.time.slowTick++; updateMobilization(world); }
};
function addArmy(world: ReturnType<typeof createSocietyWorld>, count: number) {
  const nation = world.nations[0];
  for (let i = 0; i < count; i++) world.units.push(createUnitForType(createUnitId(world.unitIdCounter++), nation.id, nation.capitalMesoId, "Infantry"));
}

test("peace keeps a standing army while crises and war gradually authorize larger forces", () => {
  const world = createSocietyWorld(), [a, b] = world.nations, item = getMobilization(world, a.id);
  tick(world); assert.equal(item.authorizedArmy, item.standingArmy); assert(item.authorizedArmy < item.maximumArmy);
  getRelation(world, a.id, b.id).crisis = { aggressorId: b.id, demand: "concessions", openedAtSlowTick: 1, deadlineSlowTick: 31 };
  tick(world); const early = item.authorizedArmy;
  tick(world, 10); assert(item.authorizedArmy > early); assert.equal(item.phase, "mobilizing"); assert(item.readiness < 0.75);
  declareWar(world.wars, a.id, b.id, 0); tick(world, 50);
  assert.equal(item.phase, "war"); assert.equal(item.readiness, 1);
});

test("public support expands the army ceiling beyond 100 where population permits, with a hard limit of 300", () => {
  const world = createSeededWorld({ seed: 101, quick: true, config: { systems: { mobilizationEnabled: true } } }), a = world.nations[0], item = getMobilization(world, a.id); item.readiness = 1;
  a.warCooperation = 1; const high = getArmyLimits(world, a, item);
  a.warCooperation = 0.2; const low = getArmyLimits(world, a, item);
  assert(high.maximum > low.maximum); assert(high.maximum > 100); assert(high.maximum <= 300);
  assert.equal(WORLD_BALANCE.production.maxMobilizedLandUnits, 300);
});

test("sustained mass deployment accumulates strain; civilian relief reduces it and support penalties do not compound per frame", () => {
  const world = createSocietyWorld(), a = world.nations[0], item = getMobilization(world, a.id);
  addArmy(world, 160); tick(world, 300);
  assert(item.burden > 10); const burden = item.burden;
  updateWarCooperation(world); const support = a.warCooperation;
  for (let i = 0; i < 100; i++) updateWarCooperation(world);
  assert(a.warCooperation >= support); assert(a.warCooperation > 0.4);
  world.units = world.units.filter((unit) => unit.nationId !== a.id); tick(world, 200);
  assert(item.burden < burden); assert.equal(item.continuousDeployment, 0);
});

test("automatic demobilization returns only surviving personnel and partial equipment, without touching war or cargo units", () => {
  const world = createSocietyWorld(), [a, b] = world.nations, item = getMobilization(world, a.id);
  world.units = world.units.filter((unit) => unit.nationId !== a.id); addArmy(world, 20);
  for (const unit of world.units.filter((unit) => unit.nationId === a.id)) { unit.manpower = 600; unit.org = 0.2; }
  updateSupplyAssessment(world); item.authorizedArmy = 3; item.threat = 0; item.quietSinceSlowTick = 0; world.time.slowTick = 40;
  const before = a.resources.manpower, weapons = a.resources.weapons;
  updateDemobilization(world); assert.equal(item.demobilized, 2);
  assert.equal(a.initialUnitCount, 18);
  assert.equal(a.resources.manpower - before, 1200); assert.equal(a.resources.weapons - weapons, 6);
  const count = world.units.length; updateDemobilization(world); assert.equal(world.units.length, count);
  declareWar(world.wars, a.id, b.id, 0); world.time.slowTick += 10; updateDemobilization(world); assert.equal(world.units.length, count);
});

test("embarked troops count toward mobilization and cannot be demobilized from transport holds", () => {
  const world = createSocietyWorld(), a = world.nations[0], item = getMobilization(world, a.id);
  world.units = world.units.filter((unit) => unit.nationId !== a.id);
  const ship = createUnitForType(createUnitId(world.unitIdCounter++), a.id, a.capitalMesoId, "TransportShip");
  for (let i = 0; i < 15; i++) ship.cargoUnits.push(createUnitForType(createUnitId(world.unitIdCounter++), a.id, a.capitalMesoId, "Infantry"));
  world.units.push(ship); tick(world); assert.equal(item.landUnits, 15); assert.equal(allFieldUnits(world).filter((unit) => unit.nationId === a.id).length, 16);
  item.authorizedArmy = 3; item.quietSinceSlowTick = 0; world.time.slowTick = 40; updateSupplyAssessment(world); updateDemobilization(world);
  assert.equal(ship.cargoUnits.length, 15); assert.equal(item.demobilized, 0);
});

test("production respects standing-army authorization, keeps resources real and cannot bypass the cap with cargo", () => {
  const world = createSocietyWorld(), a = world.nations[0], item = getMobilization(world, a.id);
  tick(world); const cap = getArmyLimits(world, a, item).authorized;
  world.units = world.units.filter((unit) => unit.nationId !== a.id);
  const ship = createUnitForType(createUnitId(world.unitIdCounter++), a.id, a.capitalMesoId, "TransportShip");
  for (let i = 0; i < cap; i++) ship.cargoUnits.push(createUnitForType(createUnitId(world.unitIdCounter++), a.id, a.capitalMesoId, "Infantry"));
  world.units.push(ship); a.resources.manpower = 100000; a.resources.weapons = 10000; a.resources.steel = 10000;
  a.nextUnitProductionTick = 0; updateSupplyAssessment(world); updateProduction(world);
  assert.equal(allFieldUnits(world).filter((unit) => unit.nationId === a.id && unit.domain === "land").length, cap);
});

test("new worlds begin with a smaller standing army and disabling mobilization freezes strain without catch-up", () => {
  const reduced = createSeededWorld({ seed: 101, quick: true, config: { systems: { mobilizationEnabled: true } } });
  const legacy = createSeededWorld({ seed: 101, quick: true });
  assert(reduced.units.length < legacy.units.length);
  const world = createSocietyWorld(), item = getMobilization(world, world.nations[0].id); item.burden = 50;
  world.settings!.mobilizationEnabled = false; world.time.slowTick = 1000; updateMobilization(world);
  world.settings!.mobilizationEnabled = true; tick(world);
  assert(item.burden > 49); assert(item.burden <= 50);
});

test("strain clamped at zero support cannot manufacture support when it is later relieved", () => {
  const world = createSocietyWorld(), a = world.nations[0], item = getMobilization(world, a.id);
  a.warCooperation = 0.1; item.burden = 100;
  for (let i = 0; i < 100; i++) updateWarCooperation(world);
  assert.equal(a.warCooperation, 0);
  item.burden = 0; updateWarCooperation(world);
  assert(a.warCooperation > 0.1 && a.warCooperation < 0.13);
});


test("civilian opposition moderates ambiguous alerts, while actual ultimatums protect mobilized troops", () => {
  const world = createSocietyWorld(), [aId, bId] = getAdjacentNationPairs(world)[0];
  const a = world.nations.find((nation) => nation.id === aId)!, item = getMobilization(world, aId);
  const relation = getRelation(world, aId, bId); relation.opinion = -70; relation.tension = 90;
  item.burden = 90; item.readiness = 0.6; item.quietSinceSlowTick = 0;
  for (let i = 0; i < 80; i++) world.units.push(createUnitForType(createUnitId(world.unitIdCounter++), aId, a.capitalMesoId, "Infantry"));
  world.time.slowTick = 40; updateMobilization(world); updateSupplyAssessment(world); updateDemobilization(world);
  assert(item.readiness < 0.6); assert(item.demobilized > 0);
  const before = item.demobilized;
  relation.crisis = { aggressorId: bId, demand: "concessions", openedAtSlowTick: 40, deadlineSlowTick: 100 };
  world.time.slowTick += 40; updateMobilization(world); updateDemobilization(world);
  assert.equal(item.demobilized, before); assert.equal(item.phase, "mobilizing");
});
