import test from "node:test";
import assert from "node:assert/strict";
import { createScenarioWorld } from "../scenarios";
import { updateLandFronts } from "../../src/sim/land-fronts";
import { updateWarCampaigns } from "../../src/sim/war-campaign/update";
import { updateNationFrontPlans, type NationFrontPlan } from "../../src/sim/nation-front-plans";
import { campaignConcentrationDirective, campaignPreservesFrontDemand } from "../../src/sim/war-campaign/concentration-guidance";
import { getStalemateAssessment, recordMajorOffensiveOutcome, updateStalematePressure } from "../../src/sim/stalemate-pressure";
import type { CapitalDefenseAssessment } from "../../src/sim/capital-defense";
import { WORLD_BALANCE } from "../../src/data/balance";

function fixture() {
  const world = createScenarioWorld("matched-war", { seed: 1022748319780, quick: true, width: 640, height: 360 });
  world.settings!.warCampaignEnabled = true;
  updateLandFronts(world); updateWarCampaigns(world);
  const nation = world.wars[0].aggressorId, opponent = world.wars[0].defenderId;
  const campaign = world.warCampaigns!.byNationId.get(nation)!;
  campaign.mode = "limited-offensive"; campaign.militaryMode = "limited-offensive";
  campaign.primaryOpponentId = opponent;
  updateNationFrontPlans(world);
  return { world, nation, opponent, campaign };
}

test("national investment requests existing concentration before stalemate and withdraws it on defense", () => {
  const { world, nation, opponent, campaign } = fixture();
  updateStalematePressure(world);
  const focus = getStalemateAssessment(world, nation, opponent)!;
  assert.ok(focus.schwerpunktSectorId);
  assert.equal(focus.campaignRequested, true);
  assert.ok(focus.reasonFlags.includes("campaign-concentration"));
  campaign.mode = "defend"; campaign.militaryMode = "defend";
  updateStalematePressure(world);
  assert.equal(getStalemateAssessment(world, nation, opponent)!.schwerpunktSectorId, null);
});

test("campaign concentration respects operation cooldowns and capital emergencies", () => {
  const { world, nation, opponent } = fixture();
  updateStalematePressure(world);
  recordMajorOffensiveOutcome(world, nation, opponent, false);
  updateStalematePressure(world);
  const cooling = getStalemateAssessment(world, nation, opponent)!;
  assert.equal(cooling.schwerpunktSectorId, null);
  world.time.fastTick = cooling.cooldownUntilTick;
  updateStalematePressure(world);
  assert.ok(getStalemateAssessment(world, nation, opponent)!.schwerpunktSectorId);
  world.capitalDefense.assessmentsByNationId.set(nation, { threatLevel: "critical" } as CapitalDefenseAssessment);
  updateStalematePressure(world);
  assert.equal(getStalemateAssessment(world, nation, opponent)!.schwerpunktSectorId, null);
});

test("natural stalemate can sustain a focus after national discretionary investment ends", () => {
  const { world, nation, opponent, campaign } = fixture();
  updateStalematePressure(world);
  const focus = getStalemateAssessment(world, nation, opponent)!;
  const selected = focus.schwerpunktSectorId;
  focus.pressure = WORLD_BALANCE.war.landFront.stalemate.maximumPressure;
  campaign.mode = "defend"; campaign.militaryMode = "defend";
  updateStalematePressure(world);
  const next = getStalemateAssessment(world, nation, opponent)!;
  assert.equal(next.schwerpunktSectorId, selected);
  assert.equal(next.campaignRequested, false);
});

test("other theaters keep local defense but cannot request competing discretionary concentration", () => {
  const { world, nation, opponent, campaign } = fixture();
  const other = world.nations.find((n) => n.id !== nation && n.id !== opponent)!.id;
  assert.equal(campaignConcentrationDirective(world, nation, opponent), "request");
  assert.equal(campaignConcentrationDirective(world, nation, other), "withhold");
  campaign.militaryMode = "defend";
  assert.equal(campaignConcentrationDirective(world, nation, opponent), "legacy");
  world.settings!.warCampaignEnabled = false;
  assert.equal(campaignConcentrationDirective(world, nation, opponent), "legacy");
});

test("secondary concentration preserves capital, supply and bridgehead demands", () => {
  const { world, nation } = fixture();
  const plan = { nationId: nation, reasonFlags: [] } as unknown as NationFrontPlan;
  assert.equal(campaignPreservesFrontDemand(world, plan), false);
  for (const flag of ["capital-threatened", "major-force-supply-risk", "supply-corridor", "bridgehead-campaign"] as const) {
    plan.reasonFlags = [flag];
    assert.equal(campaignPreservesFrontDemand(world, plan), true);
  }
});
