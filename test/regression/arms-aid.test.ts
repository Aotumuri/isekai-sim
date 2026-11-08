import assert from "node:assert/strict";
import test from "node:test";
import { getArmsAidState, sendArmsAid, updateArmsAid } from "../../src/sim/arms-aid";
import { getDiplomacyState, getRelation, proposeTreaty } from "../../src/sim/diplomacy";
import { findTradeRoute } from "../../src/sim/international-trade";
import { getResearchPortfolio } from "../../src/sim/research";
import { updateSupplyAssessment } from "../../src/sim/supply-assessment";
import { getAdjacentNationPairs } from "../../src/sim/world-cache";
import { declareWar } from "../../src/sim/war-state";
import { createSocietyWorld } from "../helpers/society-world";

function aidWorld() {
  const world = createSocietyWorld(); updateSupplyAssessment(world);
  const [a, b] = getAdjacentNationPairs(world).find(([a, b]) => findTradeRoute(world, a, b))!;
  const donor = world.nations.find((nation) => nation.id === a)!, recipient = world.nations.find((nation) => nation.id === b)!;
  donor.resources.weapons = 100; donor.resources.fuel = 100;
  recipient.resources.weapons = 0;
  const relation = getRelation(world, a, b); relation.opinion = 70; relation.trust = 70;
  return { world, donor, recipient };
}

test("arms aid transports donor designs and equips recipients without granting free national research", () => {
  const { world, donor, recipient } = aidWorld();
  const portfolio = getResearchPortfolio(world, donor.id);
  portfolio.levels.firepower = 5; portfolio.levels.reliability = 5;
  const domestic = getResearchPortfolio(world, recipient.id);
  assert(sendArmsAid(world, donor.id, recipient.id));
  assert.equal(donor.resources.weapons, 80);
  assert.equal(recipient.resources.weapons, 0);
  const state = getArmsAidState(world), shipment = state.shipments[0]!;
  world.time.slowTick = shipment.arrivesAtSlowTick; state.lastAISlowTick = world.time.slowTick;
  updateArmsAid(world);
  assert.equal(shipment.status, "delivered");
  assert.equal(state.weaponsDelivered, 20);
  assert(state.importedRefits > 0);
  assert(world.units.some((unit) => unit.nationId === recipient.id && unit.design?.manufacturerId === donor.id));
  assert.equal(domestic.levels.firepower, 0);
  assert(donor.resources.weapons + recipient.resources.weapons <= 100);
});

test("hostilities return undelivered aid and insufficient donors cannot drain their reserves", () => {
  const { world, donor, recipient } = aidWorld();
  donor.resources.weapons = 40;
  assert.equal(sendArmsAid(world, donor.id, recipient.id), false);
  donor.resources.weapons = 100;
  assert(sendArmsAid(world, donor.id, recipient.id));
  declareWar(world.wars, donor.id, recipient.id, 0);
  updateArmsAid(world);
  assert.equal(getArmsAidState(world).shipments[0]!.status, "returned");
  assert.equal(donor.resources.weapons, 100);
  assert.equal(recipient.resources.weapons, 0);
});


test("allies proactively supply modernization equipment even during peace", () => {
  const { world, donor, recipient } = aidWorld();
  donor.character = { doctrine: "merchant", aggression: 0.25, cooperation: 0.9, innovation: 0.5, thrift: 0.85 };
  const relation = getRelation(world, donor.id, recipient.id); relation.opinion = 80; relation.trust = 80;
  getDiplomacyState(world).influenceByNationId.set(donor.id, 100);
  assert(proposeTreaty(world, donor.id, recipient.id, "alliance"));
  getResearchPortfolio(world, donor.id).levels.firepower = 4;
  updateArmsAid(world);
  assert.equal(getArmsAidState(world).shipments.length, 1);
  assert.equal(getArmsAidState(world).shipments[0]!.recipientId, recipient.id);
});
