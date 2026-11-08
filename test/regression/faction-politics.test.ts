import assert from "node:assert/strict";
import test from "node:test";
import { createSeededWorld } from "../helpers/seeded-world";
import { createSimulationSettings } from "../../src/sim/simulation-settings";
import { createFaction, getNationFaction, getFactionState, joinFaction, updateFactions, getFactionAdmissionIssue, factionJoinScore, leaveFaction, type FactionCharter } from "../../src/sim/factions";
import { getDiplomacyState, getRelation } from "../../src/sim/diplomacy";
import { declareWar } from "../../src/sim/war-state";

const charter: FactionCharter = { allowedIdeologyIds: ["capitalism", "communism", "cohesionism", "avian-supremacy"], defensiveObligation: "mandatory", offensiveObligation: "none", considerPersonality: false };
function scene() {
  const world = createSeededWorld({ seed: 101, width: 960, height: 540, quick: true, config: { nationTargetMacroRegionsPerNation: 1 } });
  world.settings = createSimulationSettings();
  for (const nation of world.nations) {
    nation.ideologyId = "capitalism";
    nation.character = { doctrine: "guardian", cooperation: 0.75, aggression: 0.35, innovation: 0.5, thrift: 0.5 };
    getDiplomacyState(world).influenceByNationId.set(nation.id, 100);
    for (const other of world.nations) { const relation = getRelation(world, nation.id, other.id); relation.opinion = 60; relation.trust = 80; }
  }
  assert(world.nations.length >= 8);
  return world;
}

test("AI forms several genuine ideological blocs instead of a universal open charter", () => {
  const world = scene(), ideologies = charter.allowedIdeologyIds;
  world.nations.forEach((nation, index) => { nation.ideologyId = ideologies[index % ideologies.length]; });
  updateFactions(world);
  const factions = world.factions!.factions;
  assert(factions.filter((faction) => faction.memberIds.length >= 2).length >= 2);
  for (const faction of factions) {
    assert.equal(faction.charter.allowedIdeologyIds.length, 1);
    assert.equal(new Set(faction.memberIds.map((id) => world.nations.find((nation) => nation.id === id)!.ideologyId)).size, 1);
  }
  assert(Math.max(...factions.map((faction) => faction.memberIds.length)) < world.nations.length * 0.8);
});

test("AI ranks compatible factions by relationships rather than choosing the first faction", () => {
  const world = scene(), [a, b, candidate] = world.nations;
  const first = createFaction(world, a.id, charter)!, preferred = createFaction(world, b.id, charter)!;
  const colder = getRelation(world, a.id, candidate.id); colder.opinion = 25; colder.trust = 50;
  const friend = getRelation(world, b.id, candidate.id); friend.opinion = 95; friend.trust = 95;
  assert(factionJoinScore(world, candidate.id, preferred) > factionJoinScore(world, candidate.id, first));
  updateFactions(world); assert.equal(getNationFaction(world, candidate.id)?.id, preferred.id);
});

test("an inclusive charter still requires stronger bonds across ideological divisions with every member", () => {
  const world = scene(), [a, b, candidate] = world.nations;
  const faction = createFaction(world, a.id, charter)!; assert(joinFaction(world, b.id, faction.id));
  candidate.ideologyId = "communism";
  getRelation(world, a.id, candidate.id).opinion = 80;
  const other = getRelation(world, b.id, candidate.id); other.opinion = 30;
  assert.match(getFactionAdmissionIssue(world, candidate.id, faction)!, /opinion 45 and trust 65/);
  assert.equal(joinFaction(world, candidate.id, faction.id), false);
  other.opinion = 80; other.trust = 64; assert.equal(joinFaction(world, candidate.id, faction.id), false);
  other.trust = 80; assert(joinFaction(world, candidate.id, faction.id));
});

test("exceptional shared threats can create a cross-ideology coalition and its cohesion can later fail", () => {
  const world = scene(), [a, b, enemy] = world.nations;
  a.ideologyId = "capitalism"; b.ideologyId = "communism";
  for (const nation of world.nations.slice(2)) {
    nation.ideologyId = "avian-supremacy"; nation.character!.doctrine = "isolationist"; nation.character!.cooperation = 0.25;
    for (const other of world.nations) if (other.id !== nation.id) { const relation = getRelation(world, nation.id, other.id); relation.opinion = -50; relation.trust = 20; }
  }
  const relation = getRelation(world, a.id, b.id); relation.opinion = 85; relation.trust = 85;
  declareWar(world.wars, enemy.id, a.id, 0); declareWar(world.wars, enemy.id, b.id, 0);
  updateFactions(world);
  const faction = getNationFaction(world, a.id)!; assert(faction && faction === getNationFaction(world, b.id));
  assert.deepEqual(new Set(faction.charter.allowedIdeologyIds), new Set(["capitalism", "communism"]));
  world.wars = []; relation.opinion = 20; relation.trust = 60;
  for (const time of [30, 60, 90]) { world.time.slowTick = time; updateFactions(world); }
  assert.equal(getNationFaction(world, a.id), faction); // Minimum membership time prevents immediate churn.
  world.time.slowTick = 120; updateFactions(world);
  assert.notEqual(getNationFaction(world, a.id), getNationFaction(world, b.id));
  assert(getFactionState(world).aiDefections > 0);
});

test("hard-earned mixed factions remain possible while their relationships stay strong", () => {
  const world = scene(), [a, b] = world.nations; b.ideologyId = "communism";
  const relation = getRelation(world, a.id, b.id); relation.opinion = 80; relation.trust = 90;
  const faction = createFaction(world, a.id, charter)!; assert(joinFaction(world, b.id, faction.id));
  for (const time of [120, 150, 180, 210]) { world.time.slowTick = time; updateFactions(world); }
  assert.equal(getNationFaction(world, a.id), faction); assert.equal(getNationFaction(world, b.id), faction);
});


test("a legacy open bloc can split along opposed ideologies despite friendly averages", () => {
  const world = scene(), [a, b] = world.nations; b.ideologyId = "communism";
  for (const other of world.nations.slice(2)) other.ideologyId = "cohesionism";
  const faction = createFaction(world, a.id, charter)!;
  for (const other of world.nations.slice(1)) assert(joinFaction(world, other.id, faction.id));
  getRelation(world, a.id, b.id).opinion = 49;
  for (const time of [120, 150, 180]) { world.time.slowTick = time; updateFactions(world); }
  assert.notEqual(getNationFaction(world, a.id), getNationFaction(world, b.id));
  assert(getFactionState(world).aiDefections > 0);
});

test("a departing founder can establish a new faction while its previous namesake remains", () => {
  const world = scene(), [a, b] = world.nations;
  const original = createFaction(world, a.id, charter)!; assert(joinFaction(world, b.id, original.id));
  assert(leaveFaction(world, a.id));
  const successor = createFaction(world, a.id, { ...charter, allowedIdeologyIds: ["capitalism"] });
  assert(successor); assert.notEqual(successor.name, original.name); assert.equal(getNationFaction(world, b.id), original);
});
