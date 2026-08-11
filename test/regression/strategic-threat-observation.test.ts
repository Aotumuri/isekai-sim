import assert from "node:assert/strict";
import test from "node:test";
import { getUnitCombatStrength } from "../../src/sim/unit-strength";
import {
  getStrategicNationObservation,
  updateStrategicThreatObservation,
} from "../../src/sim/strategic-threat-observation";
import { createSeededWorld } from "../helpers/seeded-world";

function createObservationWorld() {
  return createSeededWorld({
    seed: 822_748_319_788,
    width: 640,
    height: 360,
    config: {
      microRegionCount: 1_200,
      nationTargetMacroRegionsPerNation: 2,
      nationMacroRegionSizeRange: { min: 2, max: 5 },
    },
  });
}

test("strategic threat observation is persistent and does not alter AI decisions", () => {
  const world = createObservationWorld();
  const decisionStateBefore = {
    wars: world.wars.length,
    nextDeclarations: world.nations.map((nation) => nation.nextWarDeclarationTick),
    frontPlanVersion: world.frontPlans.version,
    operationVersion: world.offensiveOperations.version,
    supplyVersion: world.supplyAssessment.version,
  };

  for (let index = 0; index < 12; index += 1) {
    world.time.slowTick += 1;
    updateStrategicThreatObservation(world);
  }

  assert.equal(world.strategicThreatObservation.observations.length, world.nations.length);
  assert.equal(world.strategicThreatObservation.evaluationCount, 12);
  assert.equal(
    world.strategicThreatObservation.nationEvaluationCount,
    world.nations.length * 12,
  );
  for (const history of world.strategicThreatObservation.historyByNationId.values()) {
    assert.equal(history.length, 8);
  }
  assert.deepEqual({
    wars: world.wars.length,
    nextDeclarations: world.nations.map((nation) => nation.nextWarDeclarationTick),
    frontPlanVersion: world.frontPlans.version,
    operationVersion: world.offensiveOperations.version,
    supplyVersion: world.supplyAssessment.version,
  }, decisionStateBefore);
});

test("power uses effective unit strength and threat ranks are complete", () => {
  const world = createObservationWorld();
  updateStrategicThreatObservation(world);

  const ranks = world.strategicThreatObservation.observations
    .map((observation) => observation.threatRank)
    .sort((a, b) => a - b);
  assert.deepEqual(ranks, world.nations.map((_, index) => index + 1));
  for (const nation of world.nations) {
    const observation = getStrategicNationObservation(world, nation.id);
    assert.ok(observation);
    const expectedStrength = world.units
      .filter((unit) => unit.nationId === nation.id && unit.manpower > 0 && unit.org > 0)
      .reduce((sum, unit) => sum + getUnitCombatStrength(unit), 0);
    assert.equal(observation.power.effectiveCombatStrength, expectedStrength);
    assert.ok(observation.power.score >= 0 && observation.power.score <= 100);
    assert.ok(observation.threatScore >= 0 && observation.threatScore <= 100);
  }
});
