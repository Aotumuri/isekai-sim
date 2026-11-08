import assert from "node:assert/strict";
import test from "node:test";
import { createSocietyWorld } from "../helpers/society-world";
import { proposeTerritorialExchange, respondToTerritorialOffer, updateTerritorialDeals, willAcceptTerritorialOffer } from "../../src/sim/territorial-deals";
import { getDiplomacyState, getRelation } from "../../src/sim/diplomacy";
import { getOwnerByMesoId } from "../../src/sim/world-cache";
import { transferTerritories } from "../../src/sim/territory-transfer";

function scene() {
  const world = createSocietyWorld(), [a, b] = world.nations;
  const find = (id: typeof a.id) => [...getOwnerByMesoId(world)].filter(([region, owner]) => owner === id && region !== world.nations.find((nation) => nation.id === id)!.capitalMesoId).map(([region]) => region);
  getDiplomacyState(world).influenceByNationId.set(a.id, 100);
  return { world, a: a.id, b: b.id, offered: find(a.id), requested: find(b.id) };
}

test("exchanges wait for the recipient and atomically settle only the offered parcels", () => {
  const { world, a, b, offered, requested } = scene(), before = new Map(getOwnerByMesoId(world));
  const offer = proposeTerritorialExchange(world, a, b, [offered[0]], [requested[0]])!;
  assert(offer); assert.deepEqual(getOwnerByMesoId(world), before);
  assert.equal(respondToTerritorialOffer(world, a, offer.id, true), false);
  assert(respondToTerritorialOffer(world, b, offer.id, true));
  assert.equal(offer.status, "accepted"); assert.equal(getOwnerByMesoId(world).get(offered[0]), b);
  assert.equal(getOwnerByMesoId(world).get(requested[0]), a);
  assert.equal(respondToTerritorialOffer(world, b, offer.id, true), false);
});

test("stale and expired offers cannot transfer parcels or consume extra influence", () => {
  const { world, a, b, offered, requested } = scene();
  const offer = proposeTerritorialExchange(world, a, b, [offered[0]], [requested[0]])!;
  assert.equal(proposeTerritorialExchange(world, a, b, [offered[1]], []), null);
  assert.equal(getDiplomacyState(world).influenceByNationId.get(a), 92);
  assert(transferTerritories(world, [{ from: b, to: a, regionIds: [requested[0]] }]));
  assert.equal(respondToTerritorialOffer(world, b, offer.id, true), false); assert.equal(offer.status, "stale");
  const expiring = proposeTerritorialExchange(world, a, b, [offered[0]], [])!;
  world.time.slowTick = expiring.expiresAtSlowTick; updateTerritorialDeals(world);
  assert.equal(expiring.status, "expired"); assert.equal(getOwnerByMesoId(world).get(offered[0]), a);
});

test("AI values resources, attachment and capitals; gifts can be accepted and empty demands rejected", () => {
  const { world, a, b, offered, requested } = scene();
  const relation = getRelation(world, a, b); relation.opinion = 60; relation.trust = 70;
  const gift = proposeTerritorialExchange(world, a, b, [offered[0]], [])!;
  assert(willAcceptTerritorialOffer(world, gift));
  assert.equal(willAcceptTerritorialOffer(world, { ...gift, offered: [], requested: [requested[0]] }), false);
  const capital = world.nations.find((nation) => nation.id === b)!.capitalMesoId;
  assert.equal(willAcceptTerritorialOffer(world, { ...gift, requested: [capital] }), false);
  world.time.slowTick += 10; updateTerritorialDeals(world);
  assert.equal(gift.status, "accepted"); assert.equal(getOwnerByMesoId(world).get(offered[0]), b);
});
