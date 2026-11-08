import assert from "node:assert/strict";
import test from "node:test";
import { breakTreaty, getDiplomacyState, getInfluence, getRelation, hasTreaty,
  improveRelations, isDiplomaticallyProtected, proposeTreaty, updateDiplomaticRelations } from "../../src/sim/diplomacy";
import { declareWar } from "../../src/sim/war-state";
import { createSocietyWorld } from "../helpers/society-world";

function friendlyWorld() {
  const world = createSocietyWorld();
  const [a, b] = world.nations.slice(0, 2).map((nation) => nation.id);
  const relation = getRelation(world, a!, b!);
  relation.opinion = 80; relation.trust = 80;
  getDiplomacyState(world).influenceByNationId.set(a!, 100);
  return { world, a: a!, b: b!, relation };
}

test("treaties require consent and influence and expire at their deadline", () => {
  const { world, a, b, relation } = friendlyWorld();
  relation.opinion = -20;
  assert.equal(proposeTreaty(world, a, b, "alliance"), false);
  assert.equal(getInfluence(world, a), 100);
  relation.opinion = 80;
  assert(proposeTreaty(world, a, b, "alliance"));
  assert.equal(getInfluence(world, a), 80);
  assert(isDiplomaticallyProtected(world, a, b));
  assert.equal(proposeTreaty(world, b, a, "alliance"), false);
  world.time.slowTick = relation.treaties[0]!.expiresAtSlowTick;
  assert.equal(hasTreaty(world, b, a, "alliance"), false);
});

test("breaking a treaty damages trust and creates a diplomatic cooling period", () => {
  const { world, a, b, relation } = friendlyWorld();
  assert(proposeTreaty(world, a, b, "trade"));
  const trust = relation.trust;
  assert(breakTreaty(world, a, b, "trade"));
  assert(relation.trust < trust);
  assert(relation.grievance > 0);
  assert(relation.cooldownUntilSlowTick > world.time.slowTick);
  assert.equal(hasTreaty(world, a, b, "trade"), false);
});

test("diplomatic missions cannot improve wartime relations or spend nonexistent influence", () => {
  const { world, a, b, relation } = friendlyWorld();
  relation.opinion = 0;
  assert(improveRelations(world, a, b));
  assert.equal(relation.opinion, 10);
  getDiplomacyState(world).influenceByNationId.set(a, 0);
  assert.equal(improveRelations(world, a, b), false);
  declareWar(world.wars, a, b, 0);
  assert.equal(proposeTreaty(world, a, b, "non-aggression"), false);
});

test("relation evaluation is bounded, idempotent within an interval and removes extinct partners", () => {
  const { world, a, b } = friendlyWorld();
  updateDiplomaticRelations(world);
  const count = getDiplomacyState(world).treatiesSigned;
  updateDiplomaticRelations(world);
  assert.equal(getDiplomacyState(world).treatiesSigned, count);
  world.nations.find((nation) => nation.id === b)!.macroRegionIds = [];
  world.time.slowTick += 10;
  updateDiplomaticRelations(world);
  assert.equal([...getDiplomacyState(world).relations.values()].some((relation) =>
    relation.nationAId === b || relation.nationBId === b), false);
  assert.equal(world.nations.find((nation) => nation.id === a)!.macroRegionIds.length > 0, true);
});
