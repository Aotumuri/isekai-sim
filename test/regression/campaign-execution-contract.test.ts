import test from "node:test";
import assert from "node:assert/strict";
import { createScenarioWorld } from "../scenarios";
import { updateWarCampaigns } from "../../src/sim/war-campaign/update";
import { applyCampaignFrontGuidance } from "../../src/sim/war-campaign/front-guidance";
import { getFrontSide, getOpposingFrontSide, updateLandFronts } from "../../src/sim/land-fronts";
import { getOwnerByMesoId } from "../../src/sim/world-cache";
import type { NationFrontPlan } from "../../src/sim/nation-front-plans";

function fixture() {
  const world = createScenarioWorld("matched-war", { seed: 1022748319780, quick: true, width: 640, height: 360 });
  world.settings!.warCampaignEnabled = true;
  updateLandFronts(world); updateWarCampaigns(world);
  const nationId = world.wars[0].aggressorId;
  const front = world.landFronts.operationalSectors.find((f) => getFrontSide(f, nationId))!;
  const campaign = world.warCampaigns!.byNationId.get(nationId)!;
  campaign.primaryOpponentId = getOpposingFrontSide(front, nationId)!.nationId;
  const plan: NationFrontPlan = { nationId, frontId: front.id, physicalFrontId: front.physicalFrontId,
    posture: "attack", priority: 80, desiredStrength: 1000, reasonFlags: [], evaluatedAtTick: 0 };
  return { world, nationId, front, campaign, plan };
}
test("defense and limited offense produce different permissions for foreign expansion", () => {
  const { world, front, campaign, plan } = fixture();
  getFrontSide(front, plan.nationId)!.strength = 100000;
  getOpposingFrontSide(front, plan.nationId)!.strength = 1;
  campaign.mode = "defend";
  assert.equal(applyCampaignFrontGuidance(world, plan).posture, "hold");
  campaign.mode = "limited-offensive";
  assert.equal(applyCampaignFrontGuidance(world, plan).posture, "attack");
  campaign.mode = "defend";
  assert.equal(applyCampaignFrontGuidance(world, { ...plan, reasonFlags: ["capital-threatened"] }).posture, "attack");
});
test("defense permits a sufficiently supported counterattack to recover occupied homeland", () => {
  const { world, nationId, campaign, plan } = fixture();
  const enemy = campaign.primaryOpponentId!;
  const owners = getOwnerByMesoId(world);
  const border = world.mesoRegions.find((r) => owners.get(r.id) === nationId &&
    r.neighbors.some((n) => owners.get(n.id) === enemy))!;
  world.occupation.mesoById.set(border.id, enemy); world.occupation.version++;
  updateLandFronts(world);
  const front = world.landFronts.operationalSectors.find((f) =>
    getOpposingFrontSide(f, nationId)?.borderRegionIds.includes(border.id))!;
  assert.ok(front);
  getFrontSide(front, nationId)!.strength = 100000;
  getOpposingFrontSide(front, nationId)!.strength = 1;
  campaign.mode = "defend";
  assert.equal(applyCampaignFrontGuidance(world, { ...plan, frontId: front.id,
    physicalFrontId: front.physicalFrontId }).posture, "attack");
});
