import assert from "node:assert/strict";
import test from "node:test";
import { createFixedSocietyWorld } from "../helpers/fixed-society-world";
import { ideologyCompatibility, getIdeologicalAffinity } from "../../src/sim/ideology-relations";
import { BUILTIN_IDEOLOGIES, createIdeology } from "../../src/sim/nation-identity";
import { getRelation, getDiplomacyState, proposeTreaty, updateDiplomaticRelations, hasTreaty } from "../../src/sim/diplomacy";
import { declareWar } from "../../src/sim/war-state";

function scene(opposed = false) {
  const world = createFixedSocietyWorld(), [a, b, c] = world.nations;
  a.ideologyId = "capitalism"; b.ideologyId = opposed ? "communism" : "capitalism";
  for (const nation of [a, b]) nation.character = { doctrine: "merchant", cooperation: 0.9, aggression: 0.25, innovation: 0.5, thrift: 0.8 };
  return { world, a: a.id, b: b.id, c: c.id, relation: getRelation(world, a.id, b.id) };
}
function advance(world: ReturnType<typeof createFixedSocietyWorld>, seconds: number) {
  for (let second = 0; second < seconds; second += 10) { world.time.slowTick += 10; updateDiplomaticRelations(world); }
}

test("ideological affinity is symmetric, deterministic and includes custom ideologies", () => {
  const { world, a, b } = scene(true), second = scene(true).world;
  for (const first of BUILTIN_IDEOLOGIES) for (const other of BUILTIN_IDEOLOGIES) assert.equal(ideologyCompatibility(first.id, other.id), ideologyCompatibility(other.id, first.id));
  assert.equal(getIdeologicalAffinity(world, a, b), -1);
  const custom = createIdeology(world, "Maritime Federalism")!;
  assert.equal(ideologyCompatibility(custom.id, custom.id), 1); assert(ideologyCompatibility(custom.id, "capitalism") < 0);
  assert.equal(world.simRng.nextFloat(), second.simRng.nextFloat());
});

test("cooperative personalities do not automatically erase opposing ideologies", () => {
  const same = scene(), opposed = scene(true);
  assert(same.relation.opinion > opposed.relation.opinion);
  advance(same.world, 1200); advance(opposed.world, 1200);
  assert(same.relation.opinion > opposed.relation.opinion + 40);
  assert(hasTreaty(same.world, same.a, same.b, "alliance"));
  assert.equal(hasTreaty(opposed.world, opposed.a, opposed.b, "alliance"), false);
});

test("opposing ideologies can still negotiate alliances and cooperate against common threats", () => {
  const friendly = scene(true), isolated = scene(true);
  friendly.relation.opinion = isolated.relation.opinion = 80; friendly.relation.trust = isolated.relation.trust = 80;
  getDiplomacyState(friendly.world).influenceByNationId.set(friendly.a, 100);
  assert(proposeTreaty(friendly.world, friendly.a, friendly.b, "alliance"));
  declareWar(friendly.world.wars, friendly.c, friendly.a, 0); declareWar(friendly.world.wars, friendly.c, friendly.b, 0);
  advance(friendly.world, 200); advance(isolated.world, 200);
  assert(friendly.relation.opinion > isolated.relation.opinion); assert(friendly.relation.opinion > 40);
  assert(hasTreaty(friendly.world, friendly.a, friendly.b, "alliance"));
});

test("changing an ideology changes future friction without resetting diplomatic history", () => {
  const { world, a, b, relation } = scene(); relation.opinion = 90; relation.trust = 90;
  world.nations.find((nation) => nation.id === b)!.ideologyId = "communism";
  assert.equal(getRelation(world, a, b), relation); assert.equal(relation.opinion, 90);
  advance(world, 10); assert(relation.opinion < 90 && relation.opinion >= 88);
});
