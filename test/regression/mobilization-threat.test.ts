import assert from "node:assert/strict";
import test from "node:test";
import { getRelation, relationKey } from "../../src/sim/diplomacy";
import { grantMilitaryAccess, hasMilitaryAccess } from "../../src/sim/military-access";
import { getMobilization, getMobilizationThreat, updateMobilization } from "../../src/sim/mobilization";
import type { WorldState } from "../../src/sim/world-state";
import { getAdjacentNationPairs } from "../../src/sim/world-cache";
import { declareWar } from "../../src/sim/war-state";
import { createSimulationSettings } from "../../src/sim/simulation-settings";
import { createSeededWorld } from "../helpers/seeded-world";
import { createSocietyWorld } from "../helpers/society-world";

function updateThreats(world: WorldState) {
  world.time.slowTick++;
  updateMobilization(world);
}

test("mobilization leaves an isolated peaceful nation at standing readiness", () => {
  const world = createSocietyWorld();
  const [nation] = world.nations;
  world.nations = [nation];
  world.macroRegions = world.macroRegions.filter((region) => region.nationId === nation.id);
  world.territoryVersion++;
  updateThreats(world);
  const { phase, readiness, threat } = getMobilization(world, nation.id);
  assert.deepEqual({ phase, readiness, threat }, { phase: "standing", readiness: 0, threat: 0 });
});

test("the highest unsuppressed nearby threat wins across different treaty types and expiry", () => {
  const world = createSeededWorld({ seed: 822748319780, quick: true, config: { systems: createSimulationSettings() } });
  const pairs = getAdjacentNationPairs(world);
  const neighbors = (id: typeof world.nations[number]["id"]) =>
    pairs.flatMap(([a, b]) => a === id ? [b] : b === id ? [a] : []);
  const { id } = world.nations.find((nation) => neighbors(nation.id).length >= 2)!;
  const [first, second] = neighbors(id);
  const item = getMobilization(world, id);
  const hostile = getRelation(world, id, first);
  Object.assign(hostile, { tension: 90, opinion: -50, treaties: [{ type: "truce", expiresAtSlowTick: 2 }] });
  const aggrieved = getRelation(world, id, second);
  Object.assign(aggrieved, { tension: 60, opinion: 0, grievance: 25, treaties: [{ type: "trade", expiresAtSlowTick: 10 }] });

  updateThreats(world);
  assert.equal(item.threat, 0.35);
  updateThreats(world);
  assert.equal(item.threat, 0.6);

  hostile.treaties = [{ type: "alliance", expiresAtSlowTick: 10 }];
  aggrieved.treaties.push({ type: "non-aggression", expiresAtSlowTick: 10 });
  updateThreats(world);
  assert.equal(item.threat, 0);
});

test("directional maritime exposure and remote crises use the current relation table", () => {
  const world = createSocietyWorld();
  const [a, b] = world.nations;
  for (const region of world.mesoRegions) region.neighbors = [];
  const itemA = getMobilization(world, a.id), itemB = getMobilization(world, b.id);
  const relation = getRelation(world, a.id, b.id);
  Object.assign(relation, { tension: 85, opinion: -40 });
  updateThreats(world);
  assert.equal(itemA.threat, 0);
  assert.equal(itemB.threat, 0);

  world.strategicThreatObservation.exposures.push({ observerNationId: a.id, threatNationId: b.id,
    sharedSeaComponent: true, landAdjacent: false, atWar: false, capitalProximity: null, score: 1, supplyExposure: 0 });
  updateThreats(world);
  assert.equal(itemA.threat, 0.6);
  assert.equal(itemB.threat, 0);

  relation.crisis = { aggressorId: b.id, demand: "concessions", openedAtSlowTick: 2, deadlineSlowTick: 20 };
  relation.treaties.push({ type: "truce", expiresAtSlowTick: 30 });
  updateThreats(world);
  assert.equal(itemA.threat, 0.75);
  assert.equal(itemB.threat, 0.75);

  world.diplomacy!.relations.delete(relationKey(a.id, b.id));
  updateThreats(world);
  assert.equal(itemA.threat, 0);
  assert.equal(itemB.threat, 0);
  const replacement = getRelation(world, a.id, b.id);
  Object.assign(replacement, { tension: 60, opinion: -19 });
  updateThreats(world);
  assert.equal(itemA.threat, 0.35);
});

test("readiness changes are seen next cycle and wars take effect on the current cycle", () => {
  const world = createSocietyWorld();
  const [a, b] = world.nations;
  const itemA = getMobilization(world, a.id), itemB = getMobilization(world, b.id);
  Object.assign(getRelation(world, a.id, b.id), { tension: 10, opinion: -40 });
  itemA.readiness = 0.49;
  itemA.policy = "total";

  updateThreats(world);
  assert(itemA.readiness >= 0.5);
  assert.equal(itemB.threat, 0);
  updateThreats(world);
  assert.equal(itemB.threat, 0.5);

  declareWar(world.wars, a.id, b.id, world.time.fastTick);
  updateThreats(world);
  assert.equal(itemA.threat, 1);
  assert.equal(itemB.threat, 1);
  assert.equal(itemB.phase, "war");
  world.wars.length = 0;
  updateThreats(world);
  assert.equal(itemB.threat, 0.5);
  assert.equal(itemB.phase, "alert");
});

test("military access and subject status leave the original bilateral threat calculation in force", () => {
  const world = createSocietyWorld();
  const [host, guest] = world.nations;
  const relation = getRelation(world, host.id, guest.id);
  Object.assign(relation, { trust: 75, opinion: 40 });
  assert(grantMilitaryAccess(world, host.id, guest.id));
  Object.assign(relation, { tension: 85, opinion: -40 });
  assert(hasMilitaryAccess(world, guest.id, host.id));
  updateThreats(world);
  assert.equal(getMobilization(world, host.id).threat, 0.6);
  assert.equal(getMobilization(world, guest.id).threat, 0.6);

  guest.subjectGovernment = { overlordId: host.id, establishedAtFastTick: 0 };
  updateThreats(world);
  assert.equal(getMobilization(world, host.id).threat, 0.6);
  assert.equal(getMobilization(world, guest.id).threat, 0.6);
});

test("mobilization skips eliminated governments but reads any remaining bilateral crisis", () => {
  const world = createSocietyWorld();
  const [active, eliminated] = world.nations;
  const previous = { ...getMobilization(world, eliminated.id) };
  eliminated.macroRegionIds = [];
  getRelation(world, active.id, eliminated.id).crisis = {
    aggressorId: eliminated.id, demand: "concessions", openedAtSlowTick: 0, deadlineSlowTick: 30,
  };
  updateThreats(world);
  assert.deepEqual(getMobilization(world, eliminated.id), previous);
  assert.equal(getMobilization(world, active.id).threat, 0.75);
  assert.equal(getMobilizationThreat(world, eliminated.id), 0.75);
});

test("an above-threshold war assessment contributes through its last valid day", () => {
  const world = createSocietyWorld();
  const [a, b] = world.nations;
  world.warIntent.assessmentsByNationId.set(a.id, [{
    aggressorId: a.id, targetNationId: b.id, route: "land", score: 1, opportunity: 1,
    threatResponse: 0, strategicValue: 0, expectedCost: 0, existingCommitment: 0, externalExposure: 0,
    dominantReason: "opportunistic-expansion", rejectedReasons: [], aboveThreshold: true,
    declared: false, evaluatedAtTick: 10,
  }]);
  const item = getMobilization(world, a.id);
  world.time.fastTick = 130;
  updateThreats(world);
  assert.equal(item.threat, 0.55);
  world.time.fastTick = 131;
  updateThreats(world);
  assert.equal(item.threat, 0);
});
