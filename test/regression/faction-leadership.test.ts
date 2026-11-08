import assert from "node:assert/strict";
import test from "node:test";
import { createSocietyWorld } from "../helpers/society-world";
import { getDiplomacyState, getRelation, getInfluence } from "../../src/sim/diplomacy";
import { createFaction, joinFaction, leaveFaction, transferFactionLeadership, expelFactionMember, ensureFactionLeadership, getFactionSuccessors } from "../../src/sim/factions";
import { declareWar } from "../../src/sim/war-state";
function scene() {
  const world = createSocietyWorld(), [a, b, c] = world.nations;
  for (const nation of [a, b, c]) { nation.ideologyId = "capitalism"; getDiplomacyState(world).influenceByNationId.set(nation.id, 100); }
  for (const first of [a, b, c]) for (const second of [a, b, c]) { const r = getRelation(world, first.id, second.id); r.opinion = r.trust = 80; }
  const faction = createFaction(world, a.id, { allowedIdeologyIds: ["capitalism"], defensiveObligation: "mandatory", offensiveObligation: "none", considerPersonality: false })!;
  assert(joinFaction(world, b.id, faction.id)); assert(joinFaction(world, c.id, faction.id));
  return { world, a, b, c, faction };
}
test("founders lead and only the current leader may hand over to a trusted member", () => {
  const { world, a, b, c, faction } = scene(); assert.equal(faction.leaderId, a.id);
  const before = getInfluence(world, b.id); assert(!transferFactionLeadership(world, b.id, c.id)); assert.equal(getInfluence(world, b.id), before);
  getRelation(world, a.id, b.id).trust = 54; assert(!transferFactionLeadership(world, a.id, b.id));
  getRelation(world, a.id, b.id).trust = 80; assert(transferFactionLeadership(world, a.id, b.id));
  assert.equal(faction.leaderId, b.id); assert.equal(faction.founderId, a.id);
  assert(!transferFactionLeadership(world, a.id, c.id));
});
test("a departing or defeated leader is replaced deterministically by a viable member", () => {
  const { world, a, faction } = scene();
  const expected = getFactionSuccessors(world, faction).filter((id) => id !== a.id)[0];
  assert(leaveFaction(world, a.id)); assert.equal(faction.leaderId, expected);
  world.nations.find((nation) => nation.id === expected)!.macroRegionIds = [];
  ensureFactionLeadership(world, faction); assert.notEqual(faction.leaderId, expected);
  const count = world.events?.length; ensureFactionLeadership(world, faction); assert.equal(world.events?.length, count);
});
test("only the leader can expel and wartime members cannot be abandoned", () => {
  const { world, a, b, c, faction } = scene();
  assert(!expelFactionMember(world, b.id, c.id)); assert(!expelFactionMember(world, a.id, a.id));
  declareWar(world.wars, b.id, c.id, 0);
  assert(!expelFactionMember(world, a.id, c.id)); world.wars = [];
  assert(expelFactionMember(world, a.id, c.id)); assert(!faction.memberIds.includes(c.id)); assert.equal(faction.leaderId, a.id);
});

test("a faction dissolves immediately when no recognized government can lead it", async () => {
  const { updateFactionGovernments } = await import("../../src/sim/factions");
  const { world, faction } = scene();
  for (const nation of world.nations) nation.macroRegionIds = [];
  updateFactionGovernments(world);
  assert(!world.factions!.factions.includes(faction)); assert.equal(world.factions!.factionByNationId.size, 0);
});
