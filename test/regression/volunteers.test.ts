import assert from "node:assert/strict";
import test from "node:test";
import { createSocietyWorld } from "../helpers/society-world";
import { getRelation, getDiplomacyState } from "../../src/sim/diplomacy";
import { getAdjacentNationPairs } from "../../src/sim/world-cache";
import { findTradeRoute } from "../../src/sim/international-trade";
import { updateSupplyAssessment } from "../../src/sim/supply-assessment";
import { createUnitForType } from "../../src/sim/create-units";
import { createUnitId } from "../../src/sim/unit";
import { declareWar, findWar } from "../../src/sim/war-state";
import { sendVolunteers, updateVolunteers, recallVolunteers } from "../../src/sim/volunteers";
import { allFieldUnits, getMobilization, updateMobilization } from "../../src/sim/mobilization";

function scene() {
  const world = createSocietyWorld(); updateSupplyAssessment(world);
  const [a, b] = getAdjacentNationPairs(world).find(([a, b]) => !!findTradeRoute(world, a, b))!;
  const donor = world.nations.find((nation) => nation.id === a)!, host = world.nations.find((nation) => nation.id === b)!;
  const enemy = world.nations.find((nation) => nation.id !== a && nation.id !== b)!;
  declareWar(world.wars, enemy.id, host.id, 0);
  const relation = getRelation(world, a, b); relation.opinion = 80; relation.trust = 80;
  getDiplomacyState(world).influenceByNationId.set(a, 100);
  world.units = world.units.filter((unit) => unit.nationId !== a);
  for (let i = 0; i < 8; i++) world.units.push(createUnitForType(createUnitId(world.unitIdCounter++), a, donor.capitalMesoId, "Infantry"));
  donor.resources.fuel = 100;
  updateSupplyAssessment(world);
  return { world, donor, host, enemy, relation };
}

test("volunteers are existing troops, remain charged to the donor and fight under recipient command", () => {
  const { world, donor, host, enemy } = scene(), count = allFieldUnits(world).length;
  const mission = sendVolunteers(world, donor.id, host.id, 2)!; assert(mission);
  assert.equal(allFieldUnits(world).length, count); assert.equal(mission.transitUnits.length, 2);
  getMobilization(world, donor.id); world.time.slowTick++; updateMobilization(world);
  assert.equal(getMobilization(world, donor.id).landUnits, 8);
  world.time.slowTick = mission.arrivesAtSlowTick; updateVolunteers(world);
  assert.equal(mission.status, "active"); assert.equal(mission.transitUnits.length, 0);
  const deployed = world.units.filter((unit) => unit.volunteerMissionId === mission.id);
  assert.equal(deployed.length, 2); assert(deployed.every((unit) => unit.nationId === host.id && unit.volunteerOriginId === donor.id));
  assert.equal(findWar(world.wars, donor.id, enemy.id), null); assert.equal(allFieldUnits(world).length, count);
});

test("trust and protected relations cannot be bypassed by sending volunteer forces", () => {
  const { world, donor, host, enemy, relation } = scene(); relation.trust = 54;
  assert.equal(sendVolunteers(world, donor.id, host.id), null); relation.trust = 80;
  getRelation(world, donor.id, enemy.id).treaties.push({ type: "truce", expiresAtSlowTick: 100 });
  assert.equal(sendVolunteers(world, donor.id, host.id), null);
  assert.equal(getDiplomacyState(world).influenceByNationId.get(donor.id), 100);
});

test("recall returns only surviving units with their existing manpower, without duplication or resurrection", () => {
  const { world, donor, host } = scene(); const mission = sendVolunteers(world, donor.id, host.id, 2)!;
  world.time.slowTick = mission.arrivesAtSlowTick; updateVolunteers(world);
  const [survivor, dead] = world.units.filter((unit) => unit.volunteerMissionId === mission.id); survivor.manpower = 350;
  world.units = world.units.filter((unit) => unit !== dead); updateSupplyAssessment(world);
  assert(recallVolunteers(world, donor.id, mission.id)); updateVolunteers(world); assert.equal(mission.status, "returning");
  world.time.slowTick = mission.arrivesAtSlowTick; updateVolunteers(world);
  assert.equal(mission.returnedUnits, 1); assert.equal(survivor.manpower, 350); assert.equal(survivor.nationId, donor.id);
  assert.equal(survivor.volunteerOriginId, undefined); assert.equal(world.units.filter((unit) => unit.id === survivor.id).length, 1);
  assert.equal(allFieldUnits(world).some((unit) => unit.id === dead.id), false);
  assert.equal(sendVolunteers(world, donor.id, host.id), null);
});

test("outbound forces return when relations or routes fail, and expiry never duplicates their resources", () => {
  const { world, donor, host, relation } = scene(); const mission = sendVolunteers(world, donor.id, host.id, 2)!;
  const ids = [...mission.unitIds]; relation.trust = 30; updateVolunteers(world); assert.equal(mission.status, "returning");
  world.time.slowTick = mission.arrivesAtSlowTick; updateVolunteers(world); updateVolunteers(world);
  assert.equal(mission.status, "completed"); assert.equal(mission.returnedUnits, 2);
  for (const id of ids) assert.equal(world.units.filter((unit) => unit.id === id).length, 1);
});

test("a recipient cannot exceed its hard cap when recruits fill the slots during volunteer transit", () => {
  const { world, donor, host } = scene(); const mission = sendVolunteers(world, donor.id, host.id, 2)!;
  const actual = world.units.filter((unit) => unit.nationId === host.id && unit.domain === "land").length;
  for (let i = actual; i < 300; i++) world.units.push(createUnitForType(createUnitId(world.unitIdCounter++), host.id, host.capitalMesoId, "Infantry"));
  world.time.slowTick = mission.arrivesAtSlowTick; updateVolunteers(world); assert.equal(mission.status, "returning");
  assert.equal(world.units.filter((unit) => unit.nationId === host.id && unit.domain === "land").length, 300);
});
