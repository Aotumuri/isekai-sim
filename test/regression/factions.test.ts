import assert from "node:assert/strict";
import test from "node:test";
import { getDiplomacyState, getRelation } from "../../src/sim/diplomacy";
import { createFaction, getNationFaction, joinFaction, factionWillingness, updateFactionWarCalls, leaveFaction,
  setNationIdeology, type FactionCharter } from "../../src/sim/factions";
import { declareWar, findWar } from "../../src/sim/war-state";
import { createFixedSocietyWorld } from "../helpers/fixed-society-world";

function prepared() {
  const world = createFixedSocietyWorld();
  for (const nation of world.nations) {
    nation.ideologyId = "capitalism";
    getDiplomacyState(world).influenceByNationId.set(nation.id, 100);
    for (const other of world.nations) { const relation = getRelation(world, nation.id, other.id); relation.opinion = 70; relation.trust = 70; }
  }
  const [a, b, c] = world.nations;
  assert(a && b && c);
  const charter: FactionCharter = { allowedIdeologyIds: ["capitalism"], defensiveObligation: "mandatory", offensiveObligation: "none", considerPersonality: false };
  return { world, a, b, c, charter };
}

test("faction membership enforces ideologies, single membership and peaceful internal relations", () => {
  const { world, a, b, charter } = prepared();
  const faction = createFaction(world, a.id, charter)!; assert(faction);
  b.ideologyId = "communism"; assert.equal(joinFaction(world, b.id, faction.id), false);
  b.ideologyId = "capitalism"; assert(joinFaction(world, b.id, faction.id));
  assert.equal(createFaction(world, b.id, charter), null);
  assert.equal(setNationIdeology(world, b.id, "communism"), false);
  assert(leaveFaction(world, b.id)); assert(setNationIdeology(world, b.id, "communism"));
  assert.equal(getNationFaction(world, b.id), undefined);
});

test("mandatory defense joins even an unwilling member and overrides conflicting promises", () => {
  const { world, a, b, c, charter } = prepared();
  const faction = createFaction(world, b.id, charter)!;
  assert(joinFaction(world, c.id, faction.id));
  c.character = { doctrine: "isolationist", aggression: 0.1, cooperation: 0.1, thrift: 0.8, innovation: 0.5 };
  getRelation(world, a.id, c.id).treaties.push({ type: "truce", expiresAtSlowTick: 1000 });
  declareWar(world.wars, a.id, b.id, 0);
  updateFactionWarCalls(world);
  assert.equal(findWar(world.wars, c.id, a.id)?.cause, "faction-obligation");
  assert.equal(getRelation(world, a.id, c.id).treaties.some((treaty) => treaty.type === "truce"), false);
  const count = world.wars.length; updateFactionWarCalls(world); assert.equal(world.wars.length, count);
});

test("offensive mandates apply only to the attacking faction; voluntary members can refuse", () => {
  const { world, a, b, c, charter } = prepared();
  const faction = createFaction(world, a.id, { ...charter, offensiveObligation: "voluntary" })!;
  assert(joinFaction(world, c.id, faction.id));
  c.character = { doctrine: "isolationist", aggression: 0.1, cooperation: 0.1, thrift: 0.8, innovation: 0.5 };
  declareWar(world.wars, a.id, b.id, 0); updateFactionWarCalls(world);
  assert.equal(findWar(world.wars, c.id, b.id), null);
  // Changing a charter in the fixture starts a fresh obligation evaluation.
  faction.charter.offensiveObligation = "mandatory"; world.factions!.handledCalls.clear(); updateFactionWarCalls(world);
  assert(findWar(world.wars, c.id, b.id));
});

test("personality-aware admission can reject a binding charter; disabling it preserves ideology checks", () => {
  const { world, a, b, charter } = prepared();
  b.character = { doctrine: "isolationist", aggression: 0.1, cooperation: 0.1, thrift: 0.8, innovation: 0.5 };
  const faction = createFaction(world, a.id, { ...charter, offensiveObligation: "mandatory", considerPersonality: true })!;
  assert(factionWillingness(world, b.id, faction.charter) < 40);
  assert.equal(joinFaction(world, b.id, faction.id), false);
  faction.charter.considerPersonality = false; assert(joinFaction(world, b.id, faction.id));
});

test("both mandatory factions enter a complete war without recursively attacking their own members", async () => {
  const { createSeededWorld } = await import("../helpers/seeded-world");
  const { createSimulationSettings } = await import("../../src/sim/simulation-settings");
  const world = createSeededWorld({ seed: 101, width: 960, height: 540, quick: true });
  world.settings = createSimulationSettings();
  const [a, b, c, d] = world.nations;
  assert(a && b && c && d);
  for (const nation of [a, b, c, d]) {
    nation.ideologyId = "capitalism"; getDiplomacyState(world).influenceByNationId.set(nation.id, 100);
    for (const other of [a, b, c, d]) { const relation = getRelation(world, nation.id, other.id); relation.opinion = 80; relation.trust = 80; }
  }
  const charter: FactionCharter = { allowedIdeologyIds: ["capitalism"], defensiveObligation: "mandatory", offensiveObligation: "mandatory", considerPersonality: false };
  const first = createFaction(world, a.id, charter)!, second = createFaction(world, b.id, charter)!;
  assert(joinFaction(world, c.id, first.id) && joinFaction(world, d.id, second.id));
  declareWar(world.wars, a.id, b.id, 0); updateFactionWarCalls(world);
  for (const attacker of [a, c]) for (const defender of [b, d]) assert(findWar(world.wars, attacker.id, defender.id));
  assert.equal(findWar(world.wars, a.id, c.id), null); assert.equal(findWar(world.wars, b.id, d.id), null);
});

test("a no-defense charter is not silently overridden by a bilateral alliance inside the faction", async () => {
  const { updateDiplomaticCrises } = await import("../../src/sim/diplomatic-crises");
  const { world, a, b, c, charter } = prepared();
  const faction = createFaction(world, b.id, { ...charter, defensiveObligation: "none" })!;
  assert(joinFaction(world, c.id, faction.id));
  getRelation(world, b.id, c.id).treaties.push({ type: "alliance", expiresAtSlowTick: 100 });
  declareWar(world.wars, a.id, b.id, 0);
  updateDiplomaticCrises(world); updateFactionWarCalls(world);
  assert.equal(findWar(world.wars, c.id, a.id), null);
});
