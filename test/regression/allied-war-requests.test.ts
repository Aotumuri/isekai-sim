import assert from "node:assert/strict";
import test from "node:test";
import { createSocietyWorld } from "../helpers/society-world";
import { getRelation, getDiplomacyState } from "../../src/sim/diplomacy";
import { requestAlliedWarEntry, respondToAlliedWarRequest, updateAlliedWarRequests, willAcceptAlliedWarRequest } from "../../src/sim/allied-war-requests";
import { declareWar, findWar } from "../../src/sim/war-state";

function scene() {
  const world = createSocietyWorld(), [caller, ally, enemy] = world.nations;
  const relation = getRelation(world, caller.id, ally.id); relation.opinion = 80; relation.trust = 80;
  relation.treaties.push({ type: "alliance", expiresAtSlowTick: 1000 });
  declareWar(world.wars, enemy.id, caller.id, 0);
  getDiplomacyState(world).influenceByNationId.set(caller.id, 100);
  return { world, caller: caller.id, ally: ally.id, enemy: enemy.id, relation };
}

test("trusted allies can explicitly join a named war and the request cannot be replayed", () => {
  const { world, caller, ally, enemy } = scene(); const request = requestAlliedWarEntry(world, caller, ally, enemy)!;
  assert(request); assert.equal(request.defensive, true); assert.equal(findWar(world.wars, ally, enemy), null);
  assert.equal(respondToAlliedWarRequest(world, caller, request.id, true), false);
  assert(respondToAlliedWarRequest(world, ally, request.id, true)); assert.equal(findWar(world.wars, ally, enemy)?.cause, "allied-request");
  assert.equal(request.status, "accepted"); assert.equal(respondToAlliedWarRequest(world, ally, request.id, true), false);
});

test("trust, treaties, cooldown and the original conflict constrain calls to arms", () => {
  const { world, caller, ally, enemy, relation } = scene(); relation.trust = 59;
  assert.equal(requestAlliedWarEntry(world, caller, ally, enemy), null); relation.trust = 80;
  getRelation(world, ally, enemy).treaties.push({ type: "non-aggression", expiresAtSlowTick: 100 });
  assert.equal(requestAlliedWarEntry(world, caller, ally, enemy), null);
  getRelation(world, ally, enemy).treaties = [];
  const request = requestAlliedWarEntry(world, caller, ally, enemy)!; assert(request);
  assert.equal(requestAlliedWarEntry(world, caller, ally, enemy), null);
  world.wars = []; declareWar(world.wars, enemy, caller, 100);
  assert.equal(respondToAlliedWarRequest(world, ally, request.id, true), false); assert.equal(request.status, "stale");
});

test("AI may decline overextension and requests expire without forcing war", () => {
  const { world, caller, ally, enemy } = scene(); const request = requestAlliedWarEntry(world, caller, ally, enemy)!;
  world.nations.find((nation) => nation.id === ally)!.warCooperation = 0.1;
  assert.equal(willAcceptAlliedWarRequest(world, request), false);
  world.time.slowTick = 10; updateAlliedWarRequests(world);
  assert.equal(request.status, "declined"); assert.equal(findWar(world.wars, ally, enemy), null);
  world.time.slowTick = 130; const next = requestAlliedWarEntry(world, caller, ally, enemy)!; assert(next);
  world.time.slowTick = next.expiresAtSlowTick; updateAlliedWarRequests(world);
  assert.equal(next.status, "expired");
});


test("an ally that already joined through its obligations fulfills the pending request", () => {
  const { world, caller, ally, enemy } = scene(); const request = requestAlliedWarEntry(world, caller, ally, enemy)!;
  declareWar(world.wars, ally, enemy, 1); world.time.slowTick = 2; updateAlliedWarRequests(world);
  assert.equal(request.status, "accepted"); assert.equal(world.wars.length, 2);
});
