import test from "node:test";
import assert from "node:assert/strict";
import { createScenarioWorld } from "../scenarios";
import { updateWarCampaigns } from "../../src/sim/war-campaign/update";
import { updateLandFronts, getFrontSide } from "../../src/sim/land-fronts";
import { enterPlayerNation } from "../../src/sim/player-nation";
import { captureCampaignMarchLegs, discardChangedMarchMissions, retainedRetargetProgress } from "../../src/sim/nation/movement-continuity";
import { repositionUnits } from "../../src/sim/nation/reposition-units";

function march() {
  const world = createScenarioWorld("matched-war", { seed: 1022748319780, width: 640, height: 360, quick: true });
  world.settings!.warCampaignEnabled = true;
  updateLandFronts(world); updateWarCampaigns(world);
  const nation = world.wars[0].aggressorId;
  const unit = world.units.find((u) => u.domain === "land" && u.nationId === nation)!;
  const front = world.landFronts.operationalSectors.find((f) => getFrontSide(f, nation))!;
  world.frontAllocations.frontIdByUnitId.set(unit.id, front.id);
  const campaign = world.warCampaigns!.byNationId.get(nation)!;
  campaign.constraints.capitalCritical = false;
  world.strategicReserves.reserveNationByUnitId.delete(unit.id);
  world.reorganization.planIdByUnitId.delete(unit.id);
  world.retreatPlans.retreatIdByUnitId.delete(unit.id);
  world.offensiveOperations.operationIdByUnitId.delete(unit.id);
  unit.moveFromId = unit.regionId;
  unit.moveToId = world.mesoRegions.find((r) => r.id === unit.regionId)!.neighbors[0].id;
  unit.moveTargetId = unit.moveToId;
  unit.moveProgressMs = 700;
  const capture = (reassign = true) => captureCampaignMarchLegs(world, [unit], reassign);
  assert.equal(capture(false), undefined, "a new mission has no previously validated march");
  assert.ok(capture()?.has(unit.id));
  return { world, unit, front, campaign, capture };
}

test("only a retarget on the same validated first edge retains elapsed travel", () => {
  const { world, unit, capture } = march();
  const before = capture()!.get(unit.id)!;
  const target = world.mesoRegions.find((r) => r.id !== unit.regionId && r.id !== unit.moveTargetId)!.id;
  const next = { ...unit, moveTargetId: target, moveProgressMs: 100 };
  assert.equal(retainedRetargetProgress(next, before, 100), 800);
  assert.equal(retainedRetargetProgress({ ...next, moveToId: target }, before, 100), 100);
  assert.equal(retainedRetargetProgress({ ...next, moveTargetId: before.moveTargetId }, before, 100), 100);
  assert.equal(retainedRetargetProgress({ ...next, moveTargetId: null }, before, 100), 100);
  assert.equal(retainedRetargetProgress({ ...next, moveFromId: target }, before, 100), 100);
  assert.equal(retainedRetargetProgress({ ...next, moveProgressMs: 900 }, before, 100), 900);
});

test("special mission ownership invalidates captured progress and cannot resurrect it on return", () => {
  for (const role of ["reserve", "retreat", "reorganization", "operation", "amphibious", "capability"] as const) {
    const { world, unit, capture } = march();
    const map = role === "reserve" ? world.strategicReserves.reserveNationByUnitId
      : role === "retreat" ? world.retreatPlans.retreatIdByUnitId
      : role === "reorganization" ? world.reorganization.planIdByUnitId
      : role === "operation" ? world.offensiveOperations.operationIdByUnitId
      : role === "amphibious" ? world.amphibiousOperations.operationByUnitId : world.amphibiousOperations.capabilityDemandByUnitId;
    const legs = capture();
    map.set(unit.id, "special-mission" as never);
    discardChangedMarchMissions(world, [unit], legs);
    assert.equal(legs!.size, 0, role);
    assert.equal(capture(false), undefined, role);
    map.delete(unit.id);
    assert.equal(capture(), undefined, `${role} return starts a new ordinary mission`);
  }
});

test("direct commands and capital emergencies keep their normal reset semantics", () => {
  const { world, unit, campaign, capture } = march();
  const legs = capture();
  enterPlayerNation(world, unit.nationId);
  world.playerNation!.landOrders.set(unit.id, unit.moveTargetId!);
  discardChangedMarchMissions(world, [unit], legs);
  assert.equal(legs!.size, 0);
  assert.equal(capture(false), undefined);
  world.playerNation!.landOrders.clear();
  world.playerNation!.commandMode = "assisted";
  assert.equal(capture(), undefined);
  assert.ok(capture());
  campaign.constraints.capitalCritical = true;
  assert.equal(capture(), undefined);
  campaign.constraints.capitalCritical = false;
  assert.equal(capture(), undefined);
});

test("new plans, vanished fronts, disablement and empty worlds clear prior mission eligibility", () => {
  const { world, unit, front, campaign, capture } = march();
  campaign.revision++;
  assert.equal(capture(), undefined);
  assert.ok(capture());
  world.landFronts.operationalSectorsById.delete(front.id);
  assert.equal(capture(false), undefined);
  world.landFronts.operationalSectorsById.set(front.id, front);
  assert.equal(capture(), undefined);
  assert.ok(capture());
  world.settings!.warCampaignEnabled = false;
  assert.equal(capture(), undefined);
  world.settings!.warCampaignEnabled = true;
  assert.equal(capture(), undefined);
  assert.ok(capture());
  const units = world.units;
  world.units = [];
  repositionUnits(world, 100);
  world.units = units;
  assert.equal(capture(), undefined);
});
