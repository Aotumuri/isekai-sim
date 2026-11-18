import { updateWarCampaigns } from "../../src/sim/war-campaign/update";
import assert from "node:assert/strict";
import test from "node:test";
import { createFixedSocietyWorld } from "../helpers/fixed-society-world";
import { declareWar, findWar } from "../../src/sim/war-state";
import { getWarNegotiation, whitePeaceTerms, proposePeaceTerms, assessPeaceOffer, acceptPeaceOffer, updateWarNegotiations, getWarAdvantage, getPeaceUrgency, getPeaceTermsIssue } from "../../src/sim/war-negotiations";
import { getDomesticUnrest } from "../../src/sim/domestic-unrest";
import { getOwnerByMesoId } from "../../src/sim/world-cache";
import { getUnitCombatStrength } from "../../src/sim/unit-strength";
import { getRelation } from "../../src/sim/diplomacy";
import { transferTerritories } from "../../src/sim/territory-transfer";
function scene() {
  const world = createFixedSocietyWorld(), [a, b, c] = world.nations;
  const strength = (id: typeof a.id) => world.units.filter((unit) => unit.nationId === id).reduce((sum, unit) => sum + getUnitCombatStrength(unit), 0);
  const ratio = strength(a.id) / strength(b.id); for (const unit of world.units) if (unit.nationId === b.id) unit.manpower *= ratio;
  a.resources.weapons = b.resources.weapons = 100;
  a.warCooperation = b.warCooperation = 1;
  const war = declareWar(world.wars, a.id, b.id, 0)!;
  const negotiation = getWarNegotiation(world, war);
  const parcel = (id: typeof a.id) => [...getOwnerByMesoId(world)].find(([region, owner]) => owner === id && region !== world.nations.find((nation) => nation.id === id)!.capitalMesoId && !getPeaceTermsIssue(world, id === a.id ? b.id : a.id, id, { ...whitePeaceTerms(), demandedRegionIds: [region] }))![0];
  return { world, a, b, c, war, negotiation, parcel };
}
test("both sides publish standing opening conditions without instantly ending the war", () => {
  const { world, a, b, negotiation } = scene();
  assert(negotiation.offers.has(a.id)); assert(negotiation.offers.has(b.id));
  for (const [proposer, recipient] of [[a.id, b.id], [b.id, a.id]]) {
    assert.equal(getPeaceTermsIssue(world, proposer, recipient, negotiation.offers.get(proposer)!.terms), null);
  }
  updateWarNegotiations(world); assert(findWar(world.wars, a.id, b.id));
});
test("domestic crisis makes pragmatic governments accept an exit while intransigent governments resist", () => {
  const { world, a, b } = scene();
  world.time.slowTick = 120; world.time.fastTick = 1200;
  b.warCooperation = 0; const unrest = getDomesticUnrest(world, b.id); unrest.pressure = 85; unrest.lowSupportSeconds = 250;
  b.character = { doctrine: "merchant", aggression: 0.25, cooperation: 0.9, innovation: 0.5, thrift: 0.8 };
  const pragmatic = assessPeaceOffer(world, b.id, a.id, whitePeaceTerms()); assert(pragmatic.accepts);
  const urgency = getPeaceUrgency(world, b.id);
  b.character = { doctrine: "expansionist", aggression: 0.9, cooperation: 0.3, innovation: 0.5, thrift: 0.3 };
  assert(!assessPeaceOffer(world, b.id, a.id, whitePeaceTerms()).accepts); assert(getPeaceUrgency(world, b.id) < urgency);
});
test("territory demands and reparations make acceptance harder and a winning country rejects an early unreasonable demand", () => {
  const { world, a, b, parcel } = scene();
  for (const unit of world.units) if (unit.nationId === a.id) unit.manpower *= 4;
  assert(getWarAdvantage(world, a.id, b.id) > 0);
  const white = assessPeaceOffer(world, a.id, b.id, whitePeaceTerms());
  const demand = assessPeaceOffer(world, a.id, b.id, { ...whitePeaceTerms(), demandedRegionIds: [parcel(a.id)], demandedWeapons: 50 });
  assert(demand.score < white.score); assert(!demand.accepts);
});
test("accepted territory exchanges and reparations settle atomically, preserve other wars and relieve domestic danger", () => {
  const { world, a, b, c, parcel } = scene();
  declareWar(world.wars, a.id, c.id, 0);
  const owners = getOwnerByMesoId(world);
  const pair = [...owners].filter(([id, owner]) => owner === b.id && id !== b.capitalMesoId).flatMap(([demanded]) => [...owners].filter(([id, owner]) => owner === a.id && id !== a.capitalMesoId).map(([offered]) => ({ demanded, offered }))).find(({ demanded, offered }) => !getPeaceTermsIssue(world, a.id, b.id, { ...whitePeaceTerms(), demandedRegionIds: [demanded], offeredRegionIds: [offered] }));
  assert(pair, "fixture needs a valid exchange along the border");
  const { demanded, offered } = pair;
  const unrest = getDomesticUnrest(world, b.id); unrest.pressure = 85; unrest.lowSupportSeconds = 250;
  const troop = world.units.find((unit) => unit.nationId === b.id)!; troop.regionId = demanded;
  world.occupation.mesoById.set(demanded, a.id); world.occupation.version++;
  assert(proposePeaceTerms(world, a.id, b.id, { ...whitePeaceTerms(), demandedRegionIds: [demanded], offeredRegionIds: [offered], demandedWeapons: 20, truceSeconds: 600 }));
  assert(acceptPeaceOffer(world, b.id, a.id));
  assert.equal(getOwnerByMesoId(world).get(demanded), a.id); assert.equal(getOwnerByMesoId(world).get(offered), b.id);
  assert.equal(a.resources.weapons, 120); assert.equal(b.resources.weapons, 80);
  assert(!findWar(world.wars, a.id, b.id)); assert(findWar(world.wars, a.id, c.id));
  assert.equal(troop.regionId, b.capitalMesoId); assert(unrest.pressure < 85);
  assert.equal(getRelation(world, a.id, b.id).treaties.find((treaty) => treaty.type === "truce")?.expiresAtSlowTick, 600);
  assert.equal(world.warNegotiations?.settlements.length, 1);
});
test("unaffordable or stale proposals cannot charge resources or transfer any territory", () => {
  const { world, a, b, c, parcel } = scene(); const region = parcel(b.id);
  assert(!proposePeaceTerms(world, a.id, b.id, { ...whitePeaceTerms(), demandedWeapons: 101 }));
  assert(proposePeaceTerms(world, a.id, b.id, { ...whitePeaceTerms(), demandedRegionIds: [region], demandedWeapons: 20 }));
  b.resources.weapons = 0;
  assert(!acceptPeaceOffer(world, b.id, a.id)); assert.equal(getOwnerByMesoId(world).get(region), b.id); assert.equal(a.resources.weapons, 100);
  b.resources.weapons = 100; assert(transferTerritories(world, [{ from: b.id, to: c.id, regionIds: [region] }]));
  assert(!acceptPeaceOffer(world, b.id, a.id)); assert(findWar(world.wars, a.id, b.id)); assert.equal(a.resources.weapons, 100);
});
test("automatic negotiations can conclude peace before the domestic crisis becomes a revolution", () => {
  const { world, a, b, negotiation } = scene();
  b.character = { doctrine: "merchant", aggression: 0.25, cooperation: 0.9, innovation: 0.5, thrift: 0.8 };
  b.warCooperation = 0; const unrest = getDomesticUnrest(world, b.id); unrest.pressure = 85; unrest.lowSupportSeconds = 250;
  negotiation.offers.get(a.id)!.terms = whitePeaceTerms(); negotiation.automatic.set(a.id, false);
  world.time.slowTick = 120; world.time.fastTick = 1200;
  updateWarNegotiations(world);
  assert(!findWar(world.wars, a.id, b.id)); assert(unrest.pressure < 85);
});
test("manual negotiation policy preserves player terms while automatic countries can still accept them", () => {
  const { world, a, b, negotiation, parcel } = scene();
  const terms = { ...whitePeaceTerms(), demandedRegionIds: [parcel(b.id)], demandedWeapons: 90 };
  assert(proposePeaceTerms(world, a.id, b.id, terms));
  negotiation.automatic.set(b.id, false); world.time.slowTick = 60; world.time.fastTick = 600;
  updateWarNegotiations(world);
  assert.deepEqual(negotiation.offers.get(a.id)!.terms, terms); assert(findWar(world.wars, a.id, b.id));
});

test("a changed offer cannot silently replace the conditions displayed by the acceptance button", () => {
  const { world, a, b, negotiation } = scene();
  assert(proposePeaceTerms(world, a.id, b.id, { ...whitePeaceTerms(), demandedWeapons: 10 }));
  const displayedRevision = negotiation.offers.get(a.id)!.revision;
  assert(proposePeaceTerms(world, a.id, b.id, { ...whitePeaceTerms(), demandedWeapons: 40 }));
  assert(!acceptPeaceOffer(world, b.id, a.id, displayedRevision));
  assert.equal(a.resources.weapons, 100); assert.equal(b.resources.weapons, 100); assert(findWar(world.wars, a.id, b.id));
});

test("campaign settlement concedes weapons before its military goal and preserves manual offers", () => {
  const { world, a, b, negotiation, parcel } = scene();
  const goal = parcel(b.id);
  world.settings!.warCampaignEnabled = true;
  updateWarCampaigns(world);
  const campaign = world.warCampaigns!.byNationId.get(a.id)!;
  campaign.mode = "consolidate";
  campaign.objectives.find((item) => item.opponentId === b.id)!.regionIds = [goal];
  const terms = { ...whitePeaceTerms(), demandedRegionIds: [goal], demandedWeapons: 50 };
  assert.equal(getPeaceTermsIssue(world, a.id, b.id, terms), null);
  negotiation.offers.get(a.id)!.terms = terms;
  negotiation.offers.get(b.id)!.revisedAtSlowTick = 30;
  negotiation.automatic.set(b.id, false);
  world.time.slowTick = 30;
  world.time.fastTick = 300;
  updateWarNegotiations(world);
  const revised = negotiation.offers.get(a.id)!.terms;
  assert.deepEqual(revised.demandedRegionIds, [goal]);
  assert.equal(revised.demandedWeapons, 35);
  assert(proposePeaceTerms(world, a.id, b.id, terms));
  world.time.slowTick = 60;
  world.time.fastTick = 600;
  updateWarNegotiations(world);
  assert.deepEqual(negotiation.offers.get(a.id)!.terms, terms);
  assert.equal(negotiation.offers.get(a.id)!.source, "manual");
});

test("a secured legal campaign goal enters automatic peace terms even when absent from the opening offer", () => {
  const { world, a, b, negotiation, parcel } = scene();
  const goal = parcel(b.id);
  world.settings!.warCampaignEnabled = true;
  updateWarCampaigns(world);
  const campaign = world.warCampaigns!.byNationId.get(a.id)!;
  campaign.objectives.find((item) => item.opponentId === b.id)!.regionIds = [goal];
  campaign.mode = "consolidate";
  campaign.constraints.foodSeconds = Infinity;
  campaign.constraints.casualtyFraction = 0;
  campaign.constraints.objectivesSecured = true;
  world.occupation.mesoById.set(goal, a.id);
  world.occupation.version++;
  negotiation.offers.get(a.id)!.terms = { ...whitePeaceTerms(), demandedWeapons: 50 };
  negotiation.offers.get(b.id)!.revisedAtSlowTick = 30;
  negotiation.automatic.set(b.id, false);
  world.time.slowTick = 30;
  world.time.fastTick = 300;
  updateWarNegotiations(world);
  const terms = negotiation.offers.get(a.id)!.terms;
  assert.deepEqual(terms.demandedRegionIds, [goal]);
  assert.equal(terms.demandedWeapons, 0);
  assert.equal(getPeaceTermsIssue(world, a.id, b.id, terms), null);
});

test("mutually accepted goal recognition respects maturity and yields to urgent exit", () => {
  for (const urgent of [false, true]) {
    const { world, a, b, war, negotiation, parcel } = scene();
    const goal = parcel(b.id);
    world.settings!.warCampaignEnabled = true;
    updateWarCampaigns(world);
    const campaign = world.warCampaigns!.byNationId.get(a.id)!;
    campaign.objectives.find((item) => item.opponentId === b.id)!.regionIds = [goal];
    campaign.mode = "consolidate";
    Object.assign(campaign.constraints, { foodSeconds: urgent ? 0 : Infinity, casualtyFraction: 0, objectivesSecured: true });
    world.occupation.mesoById.set(goal, a.id); world.occupation.version++;
    for (const nation of [a, b]) {
      nation.warCooperation = 0;
      nation.character = { doctrine: "merchant", aggression: 0.25, cooperation: 0.9, innovation: 0.5, thrift: 0.8 };
      getDomesticUnrest(world, nation.id).pressure = 95;
      negotiation.lastRevisionSlowTick.set(nation.id, 90);
    }
    const recognition = { ...whitePeaceTerms(), demandedRegionIds: [goal], truceSeconds: 600 };
    negotiation.offers.get(a.id)!.terms = recognition;
    negotiation.offers.get(a.id)!.revisedAtSlowTick = 88;
    negotiation.offers.get(b.id)!.terms = { ...whitePeaceTerms(), truceSeconds: 600 };
    negotiation.offers.get(b.id)!.revisedAtSlowTick = 70;
    world.time.slowTick = 90; world.time.fastTick = 900;
    assert(assessPeaceOffer(world, b.id, a.id, recognition).accepts);
    updateWarNegotiations(world);
    if (!urgent) {
      assert(findWar(world.wars, a.id, b.id), "recognition offer must mature before settlement");
      world.time.slowTick = 100; world.time.fastTick = 1000;
      updateWarNegotiations(world);
      assert.equal(getOwnerByMesoId(world).get(goal), a.id);
    } else assert.equal(getOwnerByMesoId(world).get(goal), b.id);
    assert(!world.wars.includes(war));
  }
});
