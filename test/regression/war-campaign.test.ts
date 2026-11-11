import assert from "node:assert/strict";
import test from "node:test";
import { createScenarioWorld } from "../scenarios";
import { updateLandFronts } from "../../src/sim/land-fronts";
import { getCampaignObjectives } from "../../src/sim/campaign-objectives";
import { updateWarCampaigns } from "../../src/sim/war-campaign/update";
import { evaluateCampaignPolicy, type CampaignConstraints } from "../../src/sim/war-campaign/policy";
import { getWarCampaign, formatWarCampaignSummary } from "../../src/sim/war-campaign/state";
import { updateNationFrontPlans } from "../../src/sim/nation-front-plans";
import { applyCampaignFrontGuidance } from "../../src/sim/war-campaign/front-guidance";
import { campaignPeaceValue } from "../../src/sim/war-campaign/peace-guidance";
import { whitePeaceTerms } from "../../src/sim/war-negotiations";
import { getOpposingFrontSide } from "../../src/sim/land-fronts";

function campaignWorld() {
  const world = createScenarioWorld("active-war", {
    seed: 822_748_319_788, width: 640, height: 360, quick: true,
  });
  world.settings!.warCampaignEnabled = true;
  updateLandFronts(world);
  return world;
}

const affordable: CampaignConstraints = {
  strengthRatio: 1.5, casualtyFraction: 0, costTolerance: 1,
  foodSeconds: Infinity, replacementConstrained: false,
  capitalCritical: false, objectivesSecured: false, aggression: 0.6,
};

test("campaign policy is deterministic and emergency defense precedes peace pressure", () => {
  assert.deepEqual(evaluateCampaignPolicy(affordable), evaluateCampaignPolicy(affordable));
  assert.equal(evaluateCampaignPolicy(affordable).mode, "limited-offensive");
  assert.equal(evaluateCampaignPolicy({ ...affordable, capitalCritical: true, foodSeconds: 0 }).mode, "defend");
  assert.equal(evaluateCampaignPolicy({ ...affordable, casualtyFraction: 2 }).mode, "seek-peace");
  assert.equal(evaluateCampaignPolicy({ ...affordable, objectivesSecured: true }).mode, "consolidate");
  assert.equal(evaluateCampaignPolicy({ ...affordable, replacementConstrained: true }).mode, "defend");
});

test("campaigns snapshot goals, span opponents, and retain decisions under small changes", () => {
  const world = campaignWorld();
  updateWarCampaigns(world);
  const before = formatWarCampaignSummary(world);
  const revision = world.warCampaigns!.version;
  for (let tick = 1; tick <= 40; tick += 1) {
    world.time.fastTick = tick;
    updateWarCampaigns(world);
  }
  assert.equal(formatWarCampaignSummary(world), before);
  assert.equal(world.warCampaigns!.version, revision);
  for (const campaign of world.warCampaigns!.byNationId.values()) {
    const wars = world.wars.filter((war) => [war.nationAId, war.nationBId].includes(campaign.nationId));
    assert.equal(campaign.objectives.length, wars.length);
    assert.ok(campaign.objectives.some((goal) => goal.opponentId === campaign.primaryOpponentId));
    for (const goal of campaign.objectives) {
      assert.deepEqual(getCampaignObjectives(world, campaign.nationId, goal.opponentId), goal.regionIds);
      assert.ok(goal.regionIds.every((id) => world.mesoRegions.some((region) => region.id === id)));
    }
  }
});

test("campaign state clears after peace, extinction, and feature disable", () => {
  const world = campaignWorld();
  updateWarCampaigns(world);
  assert.ok(world.warCampaigns!.byNationId.size > 0);
  const nationId = world.wars[0].nationAId;
  world.nations.find((nation) => nation.id === nationId)!.macroRegionIds = [];
  updateWarCampaigns(world);
  assert.equal(getWarCampaign(world, nationId), undefined);
  world.wars = [];
  updateWarCampaigns(world);
  assert.equal(world.warCampaigns!.byNationId.size, 0);
  world.settings!.warCampaignEnabled = false;
  updateWarCampaigns(world);
  assert.equal(world.warCampaigns, undefined);
});

test("identical campaign worlds produce identical plans without consuming randomness", () => {
  const a = campaignWorld(), b = campaignWorld();
  const expectedRandom = a.simRng.fork().nextFloat();
  updateWarCampaigns(a);
  updateWarCampaigns(b);
  assert.deepEqual(a.warCampaigns, b.warCampaigns);
  assert.equal(a.simRng.fork().nextFloat(), expectedRandom);
  const goal = a.warCampaigns!.byNationId.get(a.wars[0].aggressorId)!.objectives[0];
  const snapshot = [...goal.regionIds];
  a.wars[0].ultimatumRegionIds = [a.nations[0].capitalMesoId];
  updateWarCampaigns(a);
  assert.deepEqual(a.warCampaigns!.byNationId.get(a.wars[0].aggressorId)!.objectives[0].regionIds, snapshot);
});

test("campaign front guidance preserves retreat and emergency defense without issuing unit orders", () => {
  const world = campaignWorld();
  updateWarCampaigns(world);
  updateNationFrontPlans(world);
  const orders = world.units.map((unit) => [unit.id, unit.moveTargetId]);
  const plan = world.frontPlans.plans[0];
  assert.ok(plan);
  const campaign = getWarCampaign(world, plan.nationId)!;
  campaign.mode = "defend";
  campaign.constraints.replacementConstrained = true;
  const attack = { ...plan, posture: "attack" as const, reasonFlags: [] };
  assert.equal(applyCampaignFrontGuidance(world, attack).posture, "hold");
  const retreat = { ...attack, posture: "retreat" as const };
  assert.equal(applyCampaignFrontGuidance(world, retreat), retreat);
  const emergency = { ...attack, reasonFlags: ["capital-threatened" as const] };
  assert.equal(applyCampaignFrontGuidance(world, emergency), emergency);
  assert.equal(applyCampaignFrontGuidance(world, attack).desiredStrength, attack.desiredStrength);
  assert.deepEqual(world.units.map((unit) => [unit.id, unit.moveTargetId]), orders);
});

test("a limited goal cannot strand a test war without a legal negotiated exit", () => {
  const world = campaignWorld();
  updateWarCampaigns(world);
  updateNationFrontPlans(world);
  const plan = world.frontPlans.plans[0];
  const campaign = getWarCampaign(world, plan.nationId)!;
  campaign.mode = "consolidate";
  const sector = world.landFronts.operationalSectorsById.get(plan.frontId)!;
  campaign.primaryOpponentId = getOpposingFrontSide(sector, plan.nationId)!.nationId;
  const attack = { ...plan, posture: "attack" as const, reasonFlags: [] };
  assert.equal(applyCampaignFrontGuidance(world, attack).posture, "attack");
  world.wars.forEach((war) => war.isTest = false);
  world.settings!.diplomacyEnabled = true;
  assert.equal(applyCampaignFrontGuidance(world, attack).posture, "hold");
});

test("peace guidance values recognition after settlement rather than temporary occupation", () => {
  const world = campaignWorld();
  updateWarCampaigns(world);
  const war = world.wars[0];
  const campaign = getWarCampaign(world, war.aggressorId)!;
  const goal = campaign.objectives.find((item) => item.opponentId === war.defenderId)!;
  assert.ok(goal.regionIds.length);
  campaign.mode = "consolidate";
  goal.regionIds.forEach((id) => world.occupation.mesoById.set(id, campaign.nationId));
  assert.equal(campaignPeaceValue(world, war.aggressorId, war.defenderId, whitePeaceTerms()), 0);
  const recognition = { ...whitePeaceTerms(), offeredRegionIds: [...goal.regionIds] };
  assert.equal(campaignPeaceValue(world, war.aggressorId, war.defenderId, recognition), 12);
  campaign.mode = "seek-peace";
  assert.equal(campaignPeaceValue(world, war.aggressorId, war.defenderId, recognition), 24);
  world.settings!.warCampaignEnabled = false;
  assert.equal(campaignPeaceValue(world, war.aggressorId, war.defenderId, recognition), 0);
});
