import { formatTerritorialClaimObjective } from "../../src/render/territorial-claim-summary";
import { updateSurrender } from "../../src/sim/surrender";
import { addWarContribution } from "../../src/sim/war-state";
import { updateWarCampaigns } from "../../src/sim/war-campaign/update";
import { acceptPeaceOffer, getWarNegotiation, proposePeaceTerms, whitePeaceTerms } from "../../src/sim/war-negotiations";
import { selectPeaceDistricts } from "../../src/sim/peace-borders";
import assert from "node:assert/strict";
import test from "node:test";
import { createFixedSocietyWorld } from "../helpers/fixed-society-world";
import { getTerritorialClaims } from "../../src/sim/territorial-claims";
import { getDiplomacyState, getRelation } from "../../src/sim/diplomacy";
import { betrayTerritorialSettlement, getNationalMilitaryStrength, openDiplomaticCrisis, respondToCrisis, startDiplomaticWar, updateDiplomaticCrises } from "../../src/sim/diplomatic-crises";
import { getOwnerByMesoId } from "../../src/sim/world-cache";
import { updateSupplyAssessment } from "../../src/sim/supply-assessment";
import { updateStrategicThreatObservation } from "../../src/sim/strategic-threat-observation";

function scene() {
  const world = createFixedSocietyWorld(); updateSupplyAssessment(world); updateStrategicThreatObservation(world);
  const candidates = world.strategicThreatObservation.exposures.filter((item) => item.landAdjacent)
    .flatMap(({ observerNationId: a, threatNationId: b }) => {
      const parcels = [...getOwnerByMesoId(world)].filter(([id, owner]) =>
        owner === b && id !== world.nations.find((nation) => nation.id === b)!.capitalMesoId).map(([id]) => id);
      return selectPeaceDistricts(world, b, a, parcels, 1).map((id) => ({ a, b, id }));
    });
  assert.ok(candidates.length);
  const { a, b, id } = candidates[0];
  getTerritorialClaims(world).history.get(id)!.set(a, { heldTicks: 500, attachment: 60 });
  const ratio = getNationalMilitaryStrength(world, b) / Math.max(1, getNationalMilitaryStrength(world, a));
  for (const unit of world.units.filter((item) => item.nationId === a)) unit.manpower *= ratio * 1.2;
  getDiplomacyState(world).influenceByNationId.set(a, 100);
  world.nations.find((nation) => nation.id === b)!.character = { doctrine: "pragmatist", aggression: 0.6, cooperation: 0.5, innovation: 0.5, thrift: 0.5 };
  return { world, a, b, id, relation: getRelation(world, a, b) };
}

test("accepted territorial ultimatums recover only named regions without weapon tribute or war", () => {
  const { world, a, b, id, relation } = scene(), before = new Map(getOwnerByMesoId(world));
  const stock = world.nations.find((nation) => nation.id === b)!.resources.weapons;
  assert(openDiplomaticCrisis(world, a, b, [id])); assert.equal(relation.crisis?.demand, "territory");
  assert(respondToCrisis(world, b, a, "concede"));
  assert.equal(getOwnerByMesoId(world).get(id), a);
  for (const [other, owner] of before) if (other !== id) assert.equal(getOwnerByMesoId(world).get(other), owner);
  assert.equal(world.nations.find((nation) => nation.id === b)!.resources.weapons, stock);
  assert.equal(world.wars.length, 0); assert.equal(startDiplomaticWar(world, a, b), false);
  assert(betrayTerritorialSettlement(world, a, b)); assert.equal(world.wars.length, 1);
  assert.equal(betrayTerritorialSettlement(world, a, b), false);
});

test("invalid territorial demands spend no influence and stale demands cannot seize another owner's land", () => {
  const { world, a, b, id, relation } = scene();
  assert.equal(openDiplomaticCrisis(world, a, b, [id, id]), false);
  assert.equal(getDiplomacyState(world).influenceByNationId.get(a), 100);
  assert(openDiplomaticCrisis(world, a, b, [id]));
  const macro = world.macroRegions.find((item) => item.mesoRegionIds.includes(id))!;
  const c = world.nations.find((nation) => nation.id !== a && nation.id !== b)!.id;
  macro.nationId = c; world.territoryVersion++;
  assert.equal(respondToCrisis(world, b, a, "concede"), false);
  updateDiplomaticCrises(world); assert.equal(relation.crisis, null);
  assert.equal(getOwnerByMesoId(world).get(id), c); assert.equal(world.wars.length, 0);
});

test("rejecting a territorial ultimatum escalates without preemptively changing ownership", () => {
  const { world, a, b, id } = scene(); assert(openDiplomaticCrisis(world, a, b, [id]));
  assert(respondToCrisis(world, b, a, "reject")); updateDiplomaticCrises(world);
  assert.equal(getOwnerByMesoId(world).get(id), b); assert.equal(world.wars.length, 1);
});

test("an old territorial agreement cannot authorize betrayal of an unrelated later truce", () => {
  const { world, a, b, id, relation } = scene();
  assert(openDiplomaticCrisis(world, a, b, [id])); assert(respondToCrisis(world, b, a, "concede"));
  world.time.slowTick += 10;
  relation.treaties = [{ type: "truce", expiresAtSlowTick: world.time.slowTick + 300 }];
  const influence = getDiplomacyState(world).influenceByNationId.get(a);
  assert.equal(betrayTerritorialSettlement(world, a, b), false);
  assert.equal(getDiplomacyState(world).influenceByNationId.get(a), influence);
  assert.equal(world.wars.length, 0);
});

test("a claimed district keeps one objective from ultimatum through legal settlement", () => {
  const { world, a, b, id, relation } = scene();
  world.settings!.warCampaignEnabled = true;
  const unclaimed = getTerritorialClaims(world).history.get(id)!;
  const memory = unclaimed.get(a)!;
  unclaimed.delete(a);
  // The positional test fixture has no sufficiently strong claim on this district
  // without its territorial history.
  assert.equal(openDiplomaticCrisis(world, a, b, [id]), false);
  unclaimed.set(a, memory);
  assert(openDiplomaticCrisis(world, a, b, [id]));
  const objective = relation.crisis?.claimObjective;
  assert(objective);
  assert.deepEqual(objective.requestedRegionIds, [id]);
  assert.equal(objective.claims[0]?.heldTicks, 500);
  assert(startDiplomaticWar(world, a, b));
  const war = world.wars[0];
  assert.equal(war.claimObjective, objective);
  assert.deepEqual(war.campaignIntent?.objectiveRegionIds, [id]);
  updateWarCampaigns(world);
  const goal = world.warCampaigns?.byNationId.get(a)?.objectives[0];
  assert.equal(goal?.claimInterestId, objective.interestId);
  assert.deepEqual(goal?.regionIds, [id]);
  assert.deepEqual(getWarNegotiation(world, war).offers.get(a)?.terms.demandedRegionIds, [id]);
  assert(proposePeaceTerms(world, a, b, { ...whitePeaceTerms(), demandedRegionIds: [id] }));
  assert(acceptPeaceOffer(world, b, a));
  assert.equal(getOwnerByMesoId(world).get(id), a);
  assert.deepEqual(world.diplomacy?.claimOutcomeHistory?.map((item) =>
    [item.objective, item.route, item.outcome, item.retainedRegionIds]), [[objective, "peace", "secured", [id]]]);
});

test("occupation alone cannot complete a territorial claim after white peace", () => {
  const { world, a, b, id, relation } = scene();
  world.settings!.warCampaignEnabled = true;
  assert(openDiplomaticCrisis(world, a, b, [id]));
  assert.match(formatTerritorialClaimObjective(world, relation, String)[0], /Diplomatic demand/);
  assert(startDiplomaticWar(world, a, b));
  world.occupation.mesoById.set(id, a);
  world.occupation.version++;
  const during = formatTerritorialClaimObjective(world, relation, String);
  assert.match(during[0], /War aim/);
  assert.match(during[1], /Legally held 0 of 1 · under occupation 1/);
  assert(proposePeaceTerms(world, a, b, whitePeaceTerms()));
  assert(acceptPeaceOffer(world, b, a));
  assert.equal(getOwnerByMesoId(world).get(id), b);
  const [result] = world.diplomacy!.claimOutcomeHistory!;
  assert.equal(result.outcome, "unmet");
  assert.deepEqual(result.retainedRegionIds, []);
  assert.match(formatTerritorialClaimObjective(world, relation, String)[0], /Claim unmet/);
  world.settings!.warCampaignEnabled = false;
  assert.deepEqual(formatTerritorialClaimObjective(world, relation, String), []);
});

test("an amicable concession and an invalidated claim record distinct outcomes", () => {
  const conceded = scene();
  conceded.world.settings!.warCampaignEnabled = true;
  assert(openDiplomaticCrisis(conceded.world, conceded.a, conceded.b, [conceded.id]));
  assert(respondToCrisis(conceded.world, conceded.b, conceded.a, "concede"));
  assert.equal(conceded.world.diplomacy?.claimOutcomeHistory?.[0]?.outcome, "secured");
  assert.equal(conceded.world.diplomacy?.claimOutcomeHistory?.[0]?.route, "diplomacy");

  const invalidated = scene();
  invalidated.world.settings!.warCampaignEnabled = true;
  assert(openDiplomaticCrisis(invalidated.world, invalidated.a, invalidated.b, [invalidated.id]));
  const { world, a, b, id } = invalidated;
  const thirdOwner = world.nations.find((nation) => nation.id !== a && nation.id !== b)!.id;
  world.macroRegions.find((macro) => macro.mesoRegionIds.includes(id))!.nationId = thirdOwner;
  world.territoryVersion++;
  updateDiplomaticCrises(world);
  const [result] = world.diplomacy!.claimOutcomeHistory!;
  assert.equal(result.outcome, "unmet");
  assert.equal(result.reason, "territorial demand no longer valid");
});

test("the claim reports the legal owner after surrender transfers territory", () => {
  const { world, a, b, id } = scene();
  world.settings!.warCampaignEnabled = true;
  assert(openDiplomaticCrisis(world, a, b, [id]));
  assert(startDiplomaticWar(world, a, b));
  addWarContribution(world.wars, a, b, 5_000);
  world.units = world.units.filter((unit) => unit.nationId !== b);
  updateSurrender(world);
  assert.equal(world.wars.length, 0);
  assert.equal(getOwnerByMesoId(world).get(id), a);
  const [result] = world.diplomacy!.claimOutcomeHistory!;
  assert.equal(result.route, "surrender");
  assert.equal(result.outcome, "secured");
});
