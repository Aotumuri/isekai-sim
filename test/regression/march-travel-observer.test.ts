import test from "node:test";
import assert from "node:assert/strict";
import { createScenarioWorld } from "../scenarios";
import { updateWarCampaigns } from "../../src/sim/war-campaign/update";
import { updateLandFronts, getFrontSide } from "../../src/sim/land-fronts";
import { createMarchTravelObserver } from "../helpers/march-travel-observer";

function moving() {
  const world = createScenarioWorld("matched-war", { seed: 1022748319780, width: 640, height: 360, quick: true });
  world.settings!.warCampaignEnabled = true;
  updateLandFronts(world); updateWarCampaigns(world);
  const war = world.wars[0], unit = world.units.find((u) => u.domain === "land" && u.nationId === war.aggressorId)!;
  const enemy = world.units.find((u) => u.domain === "land" && u.nationId === war.defenderId)!;
  const front = world.landFronts.operationalSectors.find((f) => getFrontSide(f, unit.nationId))!;
  world.frontAllocations.frontIdByUnitId.set(unit.id, front.id);
  world.capitalDefense.assessmentsByNationId.delete(unit.nationId);
  world.strategicReserves.reserveNationByUnitId.clear(); world.reorganization.planIdByUnitId.clear();
  world.retreatPlans.retreatIdByUnitId.clear(); world.offensiveOperations.operationIdByUnitId.clear();
  const other = world.mesoRegions.find((r) => r.id !== unit.regionId)!;
  const target = world.mesoRegions.find((r) => r.id !== unit.regionId && r.id !== other.id)!.id;
  unit.moveToId = other.id; unit.moveTargetId = other.id; unit.moveProgressMs = 700;
  world.units = [unit];
  return { world, unit, enemy, target };
}

test("travel audit distinguishes discarded progress, retained travel and changing mission exposure", () => {
  const { world, unit, target } = moving(), observer = createMarchTravelObserver();
  observer.observe(world);
  world.time.fastTick = 1; unit.moveTargetId = target; unit.moveProgressMs = 100;
  observer.observe(world);
  assert.equal(observer.result().ordinaryDiscardedProgressMs, 700);
  world.time.fastTick = 2; unit.moveTargetId = unit.moveToId; unit.moveProgressMs = 200;
  observer.observe(world);
  assert.equal(observer.result().ordinarySameEdgeRetargets, 2);
  assert.equal(observer.result().ordinaryResetEvents, 1);
  assert.equal(observer.result().ordinaryTravelMs, 200);
  world.warCampaigns!.byNationId.get(unit.nationId)!.revision++;
  world.time.fastTick = 3; unit.moveTargetId = target; unit.moveProgressMs = 100;
  observer.observe(world);
  assert.equal(observer.result().ordinaryResetEvents, 1);
  assert.equal(observer.result().allUnblockedResetEvents, 2);
  assert.equal(observer.result().allUnblockedDiscardedProgressMs, 900);
  assert.equal(observer.result().sameFrontDiscardedProgressMs, 900);
  assert.equal(observer.result().sameFrontResetEvents, 2);
  assert.equal(observer.result().sameFrontTravelMs, 300);
});

test("an enemy-blocked arrival is not labeled discarded ordinary travel", () => {
  const { world, unit, enemy, target } = moving(), observer = createMarchTravelObserver();
  enemy.regionId = unit.moveToId!; world.units.push(enemy);
  observer.observe(world);
  world.time.fastTick = 1; unit.moveTargetId = target; unit.moveProgressMs = 0;
  observer.observe(world);
  assert.equal(observer.result().ordinaryDiscardedProgressMs, 0);
  assert.equal(observer.result().allUnblockedResetEvents, 0);
  assert.equal(observer.result().sameFrontResetEvents, 0);
});

test("common physical context excludes special-role transitions even on the same edge", () => {
  const { world, unit, target } = moving(), observer = createMarchTravelObserver();
  observer.observe(world);
  world.strategicReserves.reserveNationByUnitId.set(unit.id, unit.nationId);
  world.time.fastTick = 1; unit.moveTargetId = target; unit.moveProgressMs = 100;
  observer.observe(world);
  assert.equal(observer.result().allUnblockedResetEvents, 1);
  assert.equal(observer.result().sameFrontResetEvents, 0);
  assert.equal(observer.result().sameFrontTravelMs, 0);
});
