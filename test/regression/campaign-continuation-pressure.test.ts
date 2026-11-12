import test from "node:test";
import assert from "node:assert/strict";
import { createScenarioWorld } from "../scenarios";
import { updateWarCampaigns } from "../../src/sim/war-campaign/update";
import { campaignContinuationPressure, campaignPeaceValue } from "../../src/sim/war-campaign/peace-guidance";
import { whitePeaceTerms } from "../../src/sim/war-negotiations";
import type { CampaignAlternative } from "../../src/sim/war-campaign/alternatives";

test("peace uses incremental continuation value rather than a nominal mode or sunk secured gains", () => {
  const world = createScenarioWorld("matched-war", { seed: 1022748319780, quick: true, width: 640, height: 360 });
  world.settings!.warCampaignEnabled = true;
  updateWarCampaigns(world);
  const war = world.wars[0], nation = war.aggressorId, opponent = war.defenderId;
  const campaign = world.warCampaigns!.byNationId.get(nation)!;
  const option: CampaignAlternative = { mode: "limited-offensive", opponentId: opponent,
    benefit: 0.2, resourceCost: 0, failureRisk: 0, uncertainty: 0, changeCost: 0, score: 0.2, securedValue: 0 };
  campaign.alternatives = [option];
  assert.equal(campaignContinuationPressure(world, nation, opponent), -9);
  const value = campaignPeaceValue(world, nation, opponent, whitePeaceTerms());
  campaign.mode = "seek-peace";
  assert.equal(campaignPeaceValue(world, nation, opponent, whitePeaceTerms()), value);
  assert.equal(campaignContinuationPressure(world, nation, opponent), -9);
  option.score = -2;
  assert.equal(campaignContinuationPressure(world, nation, opponent), 22.5);
  option.opponentContinuationValue = -0.1;
  assert.equal(campaignContinuationPressure(world, nation, opponent), 4.5);
  delete option.opponentContinuationValue;
  option.score = 0.3; option.securedValue = 0.3;
  assert.equal(campaignContinuationPressure(world, nation, opponent), 0);
  campaign.alternatives = [{ ...option, mode: "seek-peace", score: 10 },
    { ...option, mode: "defend", score: -0.1, securedValue: 0 }];
  assert.equal(campaignContinuationPressure(world, nation, opponent), 4.5);
  world.settings!.warCampaignEnabled = false;
  assert.equal(campaignContinuationPressure(world, nation, opponent), undefined);
});
