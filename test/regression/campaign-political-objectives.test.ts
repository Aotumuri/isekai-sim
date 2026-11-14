import test from "node:test";
import assert from "node:assert/strict";
import { createScenarioWorld } from "../scenarios";
import { updateWarCampaigns } from "../../src/sim/war-campaign/update";
import { buildPoliticalObjective, isPoliticalGoalSecured } from "../../src/sim/war-campaign/political-objectives";
import { whitePeaceTerms } from "../../src/sim/war-negotiations";
import { forecastCampaignOpportunities, observeCampaignCost } from "../../src/sim/war-campaign/forecast";
import { campaignRecognitionWeapons } from "../../src/sim/war-campaign/peace-recognition";

function seaCampaign() {
  const world = createScenarioWorld("two-island-amphibious", {
    seed: 822748319788, width: 640, height: 360, quick: true,
  });
  world.settings!.warCampaignEnabled = true;
  updateWarCampaigns(world);
  const war = world.wars[0];
  const campaign = world.warCampaigns!.byNationId.get(war.aggressorId)!;
  return { world, war, campaign, goal: campaign.objectives[0] };
}
test("an overseas foothold adopts a distinct political purpose and cannot count temporary control as final success", () => {
  const { world, war, goal } = seaCampaign();
  assert.equal(goal.political!.purpose, "coercive-settlement");
  goal.regionIds.forEach((id) => world.occupation.mesoById.set(id, war.aggressorId));
  assert.equal(isPoliticalGoalSecured(world, war.aggressorId, goal), false);
  world.wars = [];
  updateWarCampaigns(world);
  const result = world.warCampaigns!.goalHistory.find((g) => g.nationId === war.aggressorId)!;
  assert.equal(result.outcome, "unmet");
});
test("a coercive purpose needs an actual matching settlement, not an opening demand or a prior war's payment", () => {
  const { world, war, goal } = seaCampaign();
  world.warNegotiations = { active: new Map(), lastAISlowTick: 0, settlements: [{
    a: war.aggressorId, b: war.defenderId, proposerId: war.aggressorId,
    terms: { ...whitePeaceTerms(), demandedWeapons: goal.political!.weaponTarget }, atSlowTick: 10,
  }] };
  assert.equal(isPoliticalGoalSecured(world, war.aggressorId, goal), true);
  goal.warKey = goal.warKey.replace(/@\d+$/, "@101");
  assert.equal(isPoliticalGoalSecured(world, war.aggressorId, goal), false);
  world.warNegotiations.settlements[0].atSlowTick = 11;
  world.warNegotiations.settlements[0].terms.demandedWeapons = 0;
  assert.equal(isPoliticalGoalSecured(world, war.aggressorId, goal), false);
});
test("forecasting does not initialize negotiations, consume randomness or create resources", () => {
  const { world, war, campaign } = seaCampaign();
  const nation = world.nations.find((n) => n.id === war.aggressorId)!;
  const resources = structuredClone(nation.resources);
  const random = world.simRng.fork().nextFloat();
  const oldNegotiations = world.warNegotiations;
  const forecast = () => forecastCampaignOpportunities(world, nation, [war], campaign.objectives,
    new Map(), observeCampaignCost(world, 0));
  assert.deepEqual(forecast(), forecast());
  assert.equal(world.warNegotiations, oldNegotiations);
  assert.deepEqual(nation.resources, resources);
  assert.equal(world.simRng.fork().nextFloat(), random);
});

test("coercive recognition requests only the adopted affordable goal after military leverage exists", () => {
  const { world, war, goal } = seaCampaign();
  const opponent = world.nations.find((n) => n.id === war.defenderId)!;
  opponent.resources.weapons = goal.political!.weaponTarget + 100;
  assert.equal(campaignRecognitionWeapons(world, war.aggressorId, war.defenderId), 0);
  goal.achieved = true;
  assert.equal(campaignRecognitionWeapons(world, war.aggressorId, war.defenderId), goal.political!.weaponTarget);
  opponent.resources.weapons = 0;
  assert.equal(campaignRecognitionWeapons(world, war.aggressorId, war.defenderId), 0);
});

test("a capital military objective distinguishes decisive victory from a legal territorial concession", () => {
  const { world, war, goal } = seaCampaign();
  const capital = world.nations.find((n) => n.id === war.defenderId)!.capitalMesoId;
  const political = buildPoliticalObjective(world, war.aggressorId, war.defenderId, [capital], true, "declared-territory");
  assert.equal(political.purpose, "decisive-victory");
  const decisive = { ...goal, regionIds: [capital], political };
  assert.equal(isPoliticalGoalSecured(world, war.aggressorId, decisive), false);
  world.occupation.mesoById.set(capital, war.aggressorId);
  assert.equal(isPoliticalGoalSecured(world, war.aggressorId, decisive), false);
  world.warNegotiations = { active: new Map(), lastAISlowTick: 0, settlements: [{
    a: war.aggressorId, b: war.defenderId, proposerId: war.aggressorId,
    atSlowTick: 10, terms: { ...whitePeaceTerms(), demandedWeapons: 15 },
  }] };
  assert.equal(isPoliticalGoalSecured(world, war.aggressorId, decisive), false);
  world.warNegotiations.settlements[0].terms.puppetTarget = true;
  assert.equal(isPoliticalGoalSecured(world, war.aggressorId, decisive), true);
});
