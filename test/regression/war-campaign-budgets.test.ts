import assert from "node:assert/strict";
import test from "node:test";
import { createScenarioWorld } from "../scenarios";
import { updateLandFronts } from "../../src/sim/land-fronts";
import { updateNationFrontPlans } from "../../src/sim/nation-front-plans";
import { updateNationFrontAllocations } from "../../src/sim/nation-front-allocations";
import { updateWarCampaigns } from "../../src/sim/war-campaign/update";
import { claimCampaignFrontExtraction, remainingAfterExtraction } from "../../src/sim/war-campaign/force-budget";
import { getCampaignRecoveryStock, campaignProductionResources } from "../../src/sim/war-campaign/production-budget";
import { applyCampaignNavalGuidance } from "../../src/sim/war-campaign/naval-guidance";
import { getUnitCombatStrength } from "../../src/sim/unit-strength";
import { updateSupplyAssessment } from "../../src/sim/supply-assessment";
import { enterPlayerNation } from "../../src/sim/player-nation";
import { formatCampaignDebugLines } from "../../src/render/war-campaign-debug-summary";

const options = { seed: 822_748_319_788, width: 640, height: 360, quick: true };

test("successive national withdrawals cannot spend the same front surplus twice", () => {
  assert.equal(remainingAfterExtraction(100, 30, 60), 70);
  assert.equal(remainingAfterExtraction(70, 30, 60), null);
  assert.equal(remainingAfterExtraction(100, -1, 0), null);
  assert.equal(remainingAfterExtraction(Infinity, 10, 0), null);
  const world = createScenarioWorld("active-war", options);
  updateLandFronts(world);
  updateNationFrontPlans(world);
  updateNationFrontAllocations(world);
  world.settings!.warCampaignEnabled = true;
  updateWarCampaigns(world);
  const allocation = world.frontAllocations.allocations.find((item) => item.unitIds.length >= 2)!;
  assert.ok(allocation);
  const units = allocation.unitIds.map((id) => world.units.find((unit) => unit.id === id)!);
  const total = units.reduce((sum, unit) => sum + getUnitCombatStrength(unit), 0);
  const floor = total - getUnitCombatStrength(units[0]);
  assert.equal(claimCampaignFrontExtraction(world, units[0], floor), true);
  assert.equal(claimCampaignFrontExtraction(world, units[1], floor), false);
  world.time.slowTick += 1;
  assert.equal(claimCampaignFrontExtraction(world, units[0], floor), true);
  enterPlayerNation(world, units[1].nationId);
  world.playerNation!.landOrders.set(units[1].id, units[1].regionId);
  assert.equal(claimCampaignFrontExtraction(world, units[1], 0), false);
  world.settings!.warCampaignEnabled = false;
  assert.equal(claimCampaignFrontExtraction(world, units[1], total * 2), true);
});

test("production reserves only feasible committed recovery and does not spend or create resources", () => {
  const world = createScenarioWorld("reorganization-heavy", options);
  world.settings!.warCampaignEnabled = true;
  updateWarCampaigns(world);
  const plan = world.reorganization.plans[0];
  assert.ok(plan);
  const unit = world.units.find((item) => item.id === plan.unitId)!;
  unit.regionId = plan.locationRegionId;
  plan.phase = "reorganizing";
  updateSupplyAssessment(world);
  const stock = getCampaignRecoveryStock(world, unit.nationId);
  assert.ok(stock.manpower > 0 || stock.weapons > 0);
  const resources = world.nations.find((nation) => nation.id === unit.nationId)!.resources;
  const snapshot = { ...resources };
  const available = campaignProductionResources(resources, stock);
  assert.ok(available.manpower <= resources.manpower && available.weapons <= resources.weapons);
  assert.deepEqual(resources, snapshot);
  world.reorganization.plans = [plan];
  for (const component of world.supplyAssessment.assessmentByNationId.get(unit.nationId)!.components) component.supplied = false;
  assert.deepEqual(getCampaignRecoveryStock(world, unit.nationId), { manpower: 0, weapons: 0 });
  plan.phase = "ready";
  // No other plan is ready to consume this tick in the initial scenario.
  world.reorganization.plans = [plan];
  assert.deepEqual(getCampaignRecoveryStock(world, unit.nationId), { manpower: 0, weapons: 0 });
  assert.equal(campaignProductionResources(resources, { manpower: 0, weapons: 0 }), resources);
});

test("campaign decisions appear only in the enabled strategic debug summary", () => {
  const world = createScenarioWorld("active-war", options);
  assert.deepEqual(formatCampaignDebugLines(world), []);
  world.settings!.warCampaignEnabled = true;
  updateWarCampaigns(world);
  const text = formatCampaignDebugLines(world).join("\n");
  assert.match(text, /NATIONAL WAR CAMPAIGNS/);
  assert.match(text, /priority/);
  assert.match(text, /war-membership-changed/);
  assert.match(text, /limited-occupation|preserve-sovereignty/);
});

test("naval strategic preference preserves emergency and logistics priorities", () => {
  const world = createScenarioWorld("active-war", options);
  world.settings!.warCampaignEnabled = true;
  updateWarCampaigns(world);
  const campaign = world.warCampaigns!.byNationId.values().next().value!;
  const target = world.nations.find((nation) => nation.id === campaign.primaryOpponentId)!.capitalMesoId;
  const intents = [
    { type: "SUPPORT", priority: 10, reasonFlags: [], targetCoastId: target },
    { type: "ESCORT", priority: 100, reasonFlags: [], targetCoastId: target },
    { type: "INTERCEPT", priority: 1200, reasonFlags: [], emergency: true, targetCoastId: target },
  ];
  const result = applyCampaignNavalGuidance(world, campaign.nationId, intents);
  assert.equal(result.find((item) => item.type === "ESCORT")!.priority, 100);
  assert.equal(result.find((item) => item.type === "INTERCEPT")!.priority, 1200);
  assert.ok(result.find((item) => item.type === "SUPPORT")!.priority > 10);
  assert.equal(intents[0].priority, 10);
});
