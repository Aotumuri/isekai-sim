import assert from "node:assert/strict";
import test from "node:test";
import { getDiplomacyState, getRelation, proposeTreaty } from "../../src/sim/diplomacy";
import { getNationalMilitaryStrength, openDiplomaticCrisis, respondToCrisis, startDiplomaticWar,
  updateDiplomaticCrises } from "../../src/sim/diplomatic-crises";
import { updateSupplyAssessment } from "../../src/sim/supply-assessment";
import { updateStrategicThreatObservation } from "../../src/sim/strategic-threat-observation";
import { findWar } from "../../src/sim/war-state";
import { createFixedSocietyWorld } from "../helpers/fixed-society-world";

export function createCrisisWorld() {
  const world = createFixedSocietyWorld();
  updateSupplyAssessment(world); updateStrategicThreatObservation(world);
  const exposure = world.strategicThreatObservation.exposures.find((item) => item.landAdjacent)!;
  const a = exposure.observerNationId, b = exposure.threatNationId;
  world.nations.find((nation) => nation.id === a)!.character =
    { doctrine: "expansionist", aggression: 0.9, cooperation: 0.3, innovation: 0.5, thrift: 0.3 };
  world.nations.find((nation) => nation.id === b)!.character =
    { doctrine: "pragmatist", aggression: 0.6, cooperation: 0.5, innovation: 0.5, thrift: 0.5 };
  const ratio = getNationalMilitaryStrength(world, b) / Math.max(1, getNationalMilitaryStrength(world, a));
  for (const unit of world.units.filter((item) => item.nationId === a)) unit.manpower *= ratio * 1.2;
  getDiplomacyState(world).influenceByNationId.set(a, 100);
  return { world, a, b, relation: getRelation(world, a, b) };
}

test("an ultimatum allows negotiations before escalating into a real war", () => {
  const { world, a, b, relation } = createCrisisWorld();
  assert(openDiplomaticCrisis(world, a, b));
  assert.equal(world.wars.length, 0);
  updateDiplomaticCrises(world);
  assert.equal(world.wars.length, 0);
  world.time.slowTick = relation.crisis!.deadlineSlowTick;
  updateDiplomaticCrises(world);
  assert.equal(findWar(world.wars, a, b)?.cause, "diplomatic-crisis");
  assert.equal(relation.crisis, null);
});

test("concessions transfer real weapons and create a protected cooling period", () => {
  const { world, a, b, relation } = createCrisisWorld();
  const attacker = world.nations.find((nation) => nation.id === a)!;
  const defender = world.nations.find((nation) => nation.id === b)!;
  defender.resources.weapons = 50;
  assert(openDiplomaticCrisis(world, a, b));
  const stock = attacker.resources.weapons;
  assert(respondToCrisis(world, b, a, "concede"));
  assert.equal(defender.resources.weapons, 20);
  assert.equal(attacker.resources.weapons, stock + 30);
  assert.equal(relation.crisis, null);
  assert.equal(openDiplomaticCrisis(world, a, b), false);
  assert.equal(startDiplomaticWar(world, a, b), false);
});

test("non-aggression pacts prevent crisis declarations and military collapse deters escalation", () => {
  const { world, a, b, relation } = createCrisisWorld();
  relation.opinion = 80; relation.trust = 80;
  assert(proposeTreaty(world, a, b, "non-aggression"));
  assert.equal(openDiplomaticCrisis(world, a, b), false);
  relation.treaties = [];
  assert(openDiplomaticCrisis(world, a, b));
  for (const unit of world.units.filter((item) => item.nationId === a)) unit.combatPower = 0;
  updateDiplomaticCrises(world);
  assert.equal(relation.crisis, null);
  assert.equal(world.wars.length, 0);
});

test("defensive allies join the defender and do not create recursive alliance wars", () => {
  const { world, a, b } = createCrisisWorld();
  const c = world.nations.find((nation) => nation.id !== a && nation.id !== b)!.id;
  const relation = getRelation(world, b, c); relation.opinion = 90; relation.trust = 90;
  getDiplomacyState(world).influenceByNationId.set(b, 100);
  assert(proposeTreaty(world, b, c, "alliance"));
  assert(startDiplomaticWar(world, a, b));
  updateDiplomaticCrises(world);
  assert.equal(findWar(world.wars, c, a)?.cause, "defensive-alliance");
  assert.equal(getDiplomacyState(world).defensiveInterventions, 1);
  const count = world.wars.length;
  world.time.slowTick += 10; updateDiplomaticCrises(world);
  assert.equal(world.wars.length, count);
});
