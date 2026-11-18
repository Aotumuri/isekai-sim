import test from "node:test";
import assert from "node:assert/strict";
import { createScenarioWorld } from "../scenarios";
import { updateWarCampaigns } from "../../src/sim/war-campaign/update";
import { isPoliticalGoalSecured } from "../../src/sim/war-campaign/political-objectives";
import { campaignPeaceValue } from "../../src/sim/war-campaign/peace-guidance";
import { installSubjectGovernment, releaseSubjectGovernment } from "../../src/sim/subject-governments";
import { acceptPeaceOffer, getPeaceTermsIssue, proposePeaceTerms, whitePeaceTerms } from "../../src/sim/war-negotiations";

function dependentDefender() {
  const world = createScenarioWorld("matched-war", { seed: 822748319788, width: 640, height: 360, quick: true });
  world.settings!.warCampaignEnabled = true;
  world.settings!.diplomacyEnabled = true;
  world.wars.forEach((war) => { war.isTest = false; });
  const war = world.wars[0], defender = world.nations.find((nation) => nation.id === war.defenderId)!;
  const overlord = world.nations.find((nation) => nation.id !== war.aggressorId && nation.id !== defender.id && nation.macroRegionIds.length)!;
  installSubjectGovernment(world, overlord.id, defender.id);
  updateWarCampaigns(world);
  const goal = world.warCampaigns!.byNationId.get(defender.id)!.objectives.find((item) => item.opponentId === war.aggressorId)!;
  return { world, war, defender, overlord, goal };
}

test("a government already dependent at adoption can preserve its state in a third-party war", () => {
  const { world, war, defender, overlord, goal } = dependentDefender();
  assert.equal(goal.political!.purpose, "preserve-government");
  assert.equal(getPeaceTermsIssue(world, war.aggressorId, defender.id, whitePeaceTerms()), null);
  assert.equal(campaignPeaceValue(world, defender.id, war.aggressorId, whitePeaceTerms()), 12);
  assert.ok(proposePeaceTerms(world, war.aggressorId, defender.id, whitePeaceTerms()));
  assert.ok(acceptPeaceOffer(world, defender.id, war.aggressorId));
  assert.equal(defender.subjectGovernment!.overlordId, overlord.id);
  assert.equal(isPoliticalGoalSecured(world, defender.id, goal), true);
  updateWarCampaigns(world);
  assert.equal(world.warCampaigns!.goalHistory.find((item) => item.nationId === defender.id)!.outcome, "secured");
});

test("a dependent defender snapshots its original relationship and cannot count a new master as success", () => {
  const { world, war, defender, overlord, goal } = dependentDefender();
  const opening = structuredClone(goal.political);
  installSubjectGovernment(world, war.aggressorId, defender.id);
  assert.equal(isPoliticalGoalSecured(world, defender.id, goal), false);
  assert.equal(campaignPeaceValue(world, defender.id, war.aggressorId, whitePeaceTerms()), 0);
  assert.deepEqual(goal.political, opening);
  installSubjectGovernment(world, overlord.id, defender.id);
  assert.equal(isPoliticalGoalSecured(world, defender.id, goal), true);
  assert.equal(campaignPeaceValue(world, defender.id, war.aggressorId, { ...whitePeaceTerms(), puppetTarget: true }), 0);
  assert.ok(releaseSubjectGovernment(world, overlord.id, defender.id));
  assert.equal(isPoliticalGoalSecured(world, defender.id, goal), true, "gaining independence still preserves the government");
  defender.macroRegionIds = [];
  assert.equal(isPoliticalGoalSecured(world, defender.id, goal), false);
});
