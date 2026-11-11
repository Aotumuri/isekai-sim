import test from "node:test";
import assert from "node:assert/strict";
import { createScenarioWorld } from "../scenarios";
import { getWarNegotiation, whitePeaceTerms } from "../../src/sim/war-negotiations";
import { hasReadyCampaignSettlement } from "../../src/sim/war-campaign/settlement-readiness";

function fixture() {
  const world = createScenarioWorld("matched-war", { seed: 1022748319780, quick: true, width: 640, height: 360 });
  world.settings!.diplomacyEnabled = true;
  const war = world.wars[0]; war.isTest = false;
  world.time.fastTick = 1000; world.time.slowTick = 100;
  for (const nation of world.nations) {
    nation.food = { stock: 0, harvest: 0, demand: 100, rationCoverage: 0, shortageCycles: 10, deaths: 0 };
    nation.warCooperation = 0;
  }
  const negotiation = getWarNegotiation(world, war);
  for (const offer of negotiation.offers.values()) {
    offer.terms = whitePeaceTerms(); offer.revisedAtSlowTick = 90;
  }
  return { world, war, negotiation };
}

test("readiness requires published mature legal terms and both automatic governments", () => {
  const { world, war, negotiation } = fixture();
  assert.equal(hasReadyCampaignSettlement(world, war, undefined), false);
  assert.equal(hasReadyCampaignSettlement(world, war, negotiation), true);
  for (const offer of negotiation.offers.values()) offer.revisedAtSlowTick = 91;
  assert.equal(hasReadyCampaignSettlement(world, war, negotiation), false);
  for (const offer of negotiation.offers.values()) { offer.revisedAtSlowTick = 90; offer.terms.demandedWeapons = 101; }
  assert.equal(hasReadyCampaignSettlement(world, war, negotiation), false);
  for (const offer of negotiation.offers.values()) offer.terms = whitePeaceTerms();
  negotiation.automatic.set(war.aggressorId, false);
  assert.equal(hasReadyCampaignSettlement(world, war, negotiation), false);
});

test("checking available agreements does not publish or revise offers, spend resources or consume randomness", () => {
  const { world, war, negotiation } = fixture();
  const offers = structuredClone([...negotiation.offers]);
  const resources = structuredClone(world.nations.map((n) => n.resources));
  const random = world.simRng.fork().nextFloat();
  hasReadyCampaignSettlement(world, war, negotiation);
  assert.deepEqual([...negotiation.offers], offers);
  assert.deepEqual(world.nations.map((n) => n.resources), resources);
  assert.equal(world.simRng.fork().nextFloat(), random);
});
