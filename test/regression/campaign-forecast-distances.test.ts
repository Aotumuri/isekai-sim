import test from "node:test";
import assert from "node:assert/strict";
import { createFixedSocietyWorld, fixedSocietyDistrict as district } from "../helpers/fixed-society-world";
import { beginCampaignDistancePass, getCampaignObjectiveDistances, pruneCampaignDistanceFields } from "../../src/sim/war-campaign/forecast-distances";
import { updateWarCampaigns } from "../../src/sim/war-campaign/update";
import type { CampaignObjective } from "../../src/sim/war-campaign/state";

function fixture() {
  const world = createFixedSocietyWorld(), [a, b, c] = world.nations;
  const goal: CampaignObjective = { warKey: "fixed-goal", opponentId: b.id, kind: "limited-occupation",
    regionIds: [district(5, 2)], achieved: false, openingStrength: 1000, rationale: "declared-territory" };
  return { world, a, b, c, goal };
}

test("objective distances reuse legal paths while occupation changes remain separate observations", () => {
  const { world, a, b, c, goal } = fixture();
  const first = getCampaignObjectiveDistances(world, a.id, goal);
  assert.equal(first.get(district(5, 2)), 0);
  assert.equal(first.get(district(4, 2)), 1);
  assert.equal(first.get(district(6, 2)), 1);
  assert.equal(first.has(district(4, 5)), false);
  assert.equal(first.has(district(0, 0)), false);
  world.occupation.mesoById.set(district(4, 2), c.id); world.occupation.version++;
  assert.equal(getCampaignObjectiveDistances(world, a.id, goal), first);
  assert.equal(getCampaignObjectiveDistances(world, b.id, { ...goal, opponentId: a.id }).get(district(4, 2)), 1);
});

test("changed targets and terrain invalidate paths without waiting for a virtual tick", () => {
  const { world, a, goal } = fixture();
  const first = getCampaignObjectiveDistances(world, a.id, goal);
  goal.regionIds = [district(7, 2)];
  const moved = getCampaignObjectiveDistances(world, a.id, goal);
  assert.notEqual(moved, first);
  assert.equal(moved.get(district(4, 2)), 3);
  goal.regionIds[0] = district(6, 2);
  assert.equal(getCampaignObjectiveDistances(world, a.id, goal).get(district(4, 2)), 2);
  goal.regionIds = [district(5, 2)];
  for (const region of world.mesoRegions) {
    if (region.id === district(5, 2)) region.neighbors = region.neighbors.filter((n) => n.id !== district(4, 2));
    if (region.id === district(4, 2)) region.neighbors = region.neighbors.filter((n) => n.id !== district(5, 2));
  }
  world.mapVersion++;
  const rerouted = getCampaignObjectiveDistances(world, a.id, goal);
  assert.equal(rerouted.get(district(4, 2)), 3);
});

test("a third country's legal corridor blocks a formerly reachable objective", () => {
  const { world, a, b, c, goal } = fixture();
  goal.regionIds = [district(8, 2)];
  const first = getCampaignObjectiveDistances(world, a.id, goal);
  assert.equal(first.get(district(4, 2)), 4);
  const regions = new Map(world.mesoRegions.map((r) => [r.id, r]));
  for (const macro of world.macroRegions) {
    if (macro.nationId === b.id && macro.mesoRegionIds.some((id) => regions.get(id)!.center.x < 280)) macro.nationId = c.id;
  }
  world.territoryVersion++;
  const blocked = getCampaignObjectiveDistances(world, a.id, goal);
  assert.notEqual(blocked, first);
  assert.equal(blocked.has(district(4, 2)), false);
});

test("completed goals are pruned and disabling the campaign releases remaining fields", () => {
  const { world, a, goal } = fixture();
  const secondGoal = { ...goal, warKey: "other-war", regionIds: [district(7, 2)] };
  const first = getCampaignObjectiveDistances(world, a.id, goal);
  const second = getCampaignObjectiveDistances(world, a.id, secondGoal);
  beginCampaignDistancePass(world);
  getCampaignObjectiveDistances(world, a.id, goal);
  pruneCampaignDistanceFields(world);
  assert.equal(getCampaignObjectiveDistances(world, a.id, goal), first);
  assert.notEqual(getCampaignObjectiveDistances(world, a.id, secondGoal), second);
  world.settings!.warCampaignEnabled = false;
  updateWarCampaigns(world);
  assert.notEqual(getCampaignObjectiveDistances(world, a.id, goal), first);
});
