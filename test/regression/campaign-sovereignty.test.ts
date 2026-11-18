import test from "node:test";
import assert from "node:assert/strict";
import { createScenarioWorld } from "../scenarios";
import { updateWarCampaigns } from "../../src/sim/war-campaign/update";
import { isPoliticalGoalSecured } from "../../src/sim/war-campaign/political-objectives";
import { campaignPeaceValue } from "../../src/sim/war-campaign/peace-guidance";
import { assessPeaceOffer, getPeaceTermsIssue, whitePeaceTerms } from "../../src/sim/war-negotiations";
import { transferTerritories } from "../../src/sim/territory-transfer";

function defense() {
  const world = createScenarioWorld("matched-war", { seed: 822748319788, width: 640, height: 360, quick: true });
  world.settings!.warCampaignEnabled = true;
  world.settings!.diplomacyEnabled = true;
  world.wars.forEach((war) => { war.isTest = false; });
  updateWarCampaigns(world);
  const war = world.wars[0], nation = world.nations.find((n) => n.id === war.defenderId)!;
  const goal = world.warCampaigns!.byNationId.get(nation.id)!.objectives[0];
  const district = goal.regionIds.find((id) => id !== nation.capitalMesoId &&
    !getPeaceTermsIssue(world, war.aggressorId, nation.id, { ...whitePeaceTerms(), demandedRegionIds: [id] }));
  assert.ok(district, "fixture requires a legal peripheral cession");
  const terms = { ...whitePeaceTerms(), demandedRegionIds: [district] };
  return { world, war, nation, goal, district, terms };
}

test("peripheral cession preserves political independence while retaining its territorial cost", () => {
  const { world, war, nation, goal, district, terms } = defense();
  const before = [...goal.regionIds];
  assert.equal(campaignPeaceValue(world, nation.id, war.aggressorId, terms), 12);
  const white = assessPeaceOffer(world, nation.id, war.aggressorId, whitePeaceTerms());
  const cession = assessPeaceOffer(world, nation.id, war.aggressorId, terms);
  assert.ok(Number.isFinite(cession.score));
  assert.ok(cession.score < white.score, "political recognition must not erase territorial cost");
  assert.ok(transferTerritories(world, [{ from: nation.id, to: war.aggressorId, regionIds: [district] }]));
  assert.equal(isPoliticalGoalSecured(world, nation.id, goal), true);
  assert.deepEqual(goal.regionIds, before, "military homeland objective remains unchanged");
  world.wars = [];
  updateWarCampaigns(world);
  assert.equal(world.warCampaigns!.goalHistory.find((g) => g.nationId === nation.id)!.outcome, "secured");
});

test("puppet, partition and actual dependence cannot earn a sovereignty reward", () => {
  const { world, war, nation, goal, terms } = defense();
  assert.equal(campaignPeaceValue(world, nation.id, war.aggressorId, { ...terms, puppetTarget: true }), 0);
  assert.equal(campaignPeaceValue(world, nation.id, war.aggressorId,
    { ...terms, partition: { capitalId: terms.demandedRegionIds[0], districtIds: [terms.demandedRegionIds[0]] } }), 0);
  assert.equal(campaignPeaceValue(world, nation.id, war.aggressorId, { ...terms, localSubject: true }), 12);
  nation.subjectGovernment = { overlordId: war.aggressorId, establishedAtFastTick: 0 };
  assert.equal(isPoliticalGoalSecured(world, nation.id, goal), false);
  assert.equal(campaignPeaceValue(world, nation.id, war.aggressorId, whitePeaceTerms()), 0);
});

test("occupation is distinct from legal sovereignty, but extinction and losing the capital are not rewarded", () => {
  const { world, war, nation, goal } = defense();
  world.occupation.mesoById.set(nation.capitalMesoId, war.aggressorId);
  assert.equal(isPoliticalGoalSecured(world, nation.id, goal), true);
  assert.equal(campaignPeaceValue(world, nation.id, war.aggressorId,
    { ...whitePeaceTerms(), demandedRegionIds: [nation.capitalMesoId] }), 0);
  nation.macroRegionIds = [];
  assert.equal(isPoliticalGoalSecured(world, nation.id, goal), false);
});
