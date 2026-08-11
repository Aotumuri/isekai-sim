import assert from "node:assert/strict";
import test from "node:test";
import {
  updateCommonThreatCoalitions,
} from "../../src/sim/common-threat-coalitions";
import { updateSupplyAssessment } from "../../src/sim/supply-assessment";
import { updateStrategicThreatObservation } from "../../src/sim/strategic-threat-observation";
import { assessWarIntent } from "../../src/sim/war-declaration";
import { createSeededWorld } from "../helpers/seeded-world";

function createCoalitionWorld() {
  const world = createSeededWorld({ seed: 919, width: 640, height: 360, config: {
    microRegionCount: 1_200, nationTargetMacroRegionsPerNation: 2,
    nationMacroRegionSizeRange: { min: 2, max: 5 },
  } });
  updateSupplyAssessment(world);
  updateStrategicThreatObservation(world);
  assert(world.nations.length >= 3);
  for (const observation of world.strategicThreatObservation.observations) {
    observation.threatScore = 0;
    observation.power.score = 30;
  }
  const [a, b, threat] = world.nations.slice(0, 3).map((nation) => nation.id);
  const threatObservation = world.strategicThreatObservation.observationByNationId.get(threat)!;
  threatObservation.threatScore = 80;
  threatObservation.power.score = 80;
  world.strategicThreatObservation.exposures = [a, b].map((observerNationId) => ({
    observerNationId, threatNationId: threat, score: 50, landAdjacent: true,
    atWar: false, sharedSeaComponent: false, capitalProximity: null, supplyExposure: 0,
  }));
  return { world, a, b, threat };
}

test("shared local threat forms a deterministic temporary coalition", () => {
  const { world, a, b, threat } = createCoalitionWorld();
  world.time.slowTick = 4;
  updateCommonThreatCoalitions(world);
  assert.equal(world.commonThreatCoalitions.coalitions.length, 1);
  const coalition = world.commonThreatCoalitions.coalitions[0];
  assert.deepEqual(coalition.memberNationIds, [a, b].sort());
  assert.equal(coalition.targetNationId, threat);
  assert.equal(coalition.formationReason, "shared-land-threat");
  assert.equal(world.commonThreatCoalitions.coalitionsFormed, 1);
  assert.equal(world.commonThreatCoalitions.coalitionByMemberNationId.size, 2);
});

test("coalition suppresses member conflict and raises intent against its target", () => {
  const { world, a, b, threat } = createCoalitionWorld();
  updateCommonThreatCoalitions(world);
  const withoutCoalition = world.commonThreatCoalitions.coalitionByMemberNationId;
  world.commonThreatCoalitions.coalitionByMemberNationId = new Map();
  const baseline = assessWarIntent(world, { aggressorId: a, targetNationId: threat, route: "land" });
  world.commonThreatCoalitions.coalitionByMemberNationId = withoutCoalition;
  const focused = assessWarIntent(world, { aggressorId: a, targetNationId: threat, route: "land" });
  const memberAttack = assessWarIntent(world, { aggressorId: a, targetNationId: b, route: "land" });
  assert.equal(focused.threatResponse, baseline.threatResponse + 10);
  assert(memberAttack.rejectedReasons.includes("common-threat-coalition"));
  assert.equal(memberAttack.aboveThreshold, false);
});

test("lost exposure dissolves only after hysteresis and records duration", () => {
  const { world } = createCoalitionWorld();
  world.time.slowTick = 1;
  updateCommonThreatCoalitions(world);
  world.strategicThreatObservation.exposures = [];
  for (const tick of [2, 3]) {
    world.time.slowTick = tick;
    updateCommonThreatCoalitions(world);
    assert.equal(world.commonThreatCoalitions.coalitions.length, 1);
    assert.equal(world.commonThreatCoalitions.coalitions[0].pendingDissolutionReason,
      "exposure-disappeared");
  }
  world.time.slowTick = 4;
  updateCommonThreatCoalitions(world);
  assert.equal(world.commonThreatCoalitions.coalitions.length, 0);
  assert.equal(world.commonThreatCoalitions.coalitionsDissolved, 1);
  assert.equal(world.commonThreatCoalitions.totalCoalitionDuration, 3);
  assert.equal(world.commonThreatCoalitions.lastDissolutions[0].reason,
    "exposure-disappeared");
});
