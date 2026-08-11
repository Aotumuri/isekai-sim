import assert from "node:assert/strict";
import test from "node:test";
import { updateSupplyAssessment } from "../../src/sim/supply-assessment";
import { updateStrategicThreatObservation } from "../../src/sim/strategic-threat-observation";
import {
  assessWarIntent,
  generateWarDeclarationCandidates,
} from "../../src/sim/war-declaration";
import { createSeededWorld } from "../helpers/seeded-world";
import type { NationId } from "../../src/worldgen/nation";

function createIntentWorld() {
  const world = createSeededWorld({ seed: 101, width: 640, height: 360, config: {
    microRegionCount: 1_200, nationTargetMacroRegionsPerNation: 2,
    nationMacroRegionSizeRange: { min: 2, max: 5 },
  } });
  updateSupplyAssessment(world);
  updateStrategicThreatObservation(world);
  return world;
}

test("war intent keeps threat response distinct from opportunity", () => {
  const world = createIntentWorld();
  const exposure = world.strategicThreatObservation.exposures.find((item) => item.landAdjacent);
  assert.ok(exposure);
  const attacker = world.strategicThreatObservation.observationByNationId
    .get(exposure.observerNationId)!;
  const target = world.strategicThreatObservation.observationByNationId
    .get(exposure.threatNationId)!;
  attacker.power.landStrength = 10_000;
  attacker.power.score = 45;
  target.power.landStrength = 1_000;
  target.power.score = 20;
  target.threatScore = 10;
  target.momentum.score = 0;
  target.intent.score = 0;
  const weak = assessWarIntent(world, { aggressorId: attacker.nationId,
    targetNationId: target.nationId, route: "land" });
  target.power.landStrength = 30_000;
  target.power.score = 100;
  target.threatScore = 100;
  target.momentum.score = 80;
  target.intent.score = 80;
  const hegemon = assessWarIntent(world, { aggressorId: attacker.nationId,
    targetNationId: target.nationId, route: "land" });
  assert(hegemon.threatResponse > weak.threatResponse);
  assert(hegemon.opportunity < weak.opportunity);
  assert(hegemon.rejectedReasons.includes("insufficient-strength"));
});

test("a dominant relevant third party suppresses a weaker non-threat target", () => {
  const world = createIntentWorld();
  const [attackerId, targetId, thirdId] = world.nations.slice(0, 3).map((nation) => nation.id);
  assert.ok(attackerId && targetId && thirdId);
  const targetExposure = { observerNationId: attackerId, threatNationId: targetId,
    score: 40, landAdjacent: true, atWar: false, sharedSeaComponent: false,
    capitalProximity: null, supplyExposure: 0 };
  const thirdExposure = { ...targetExposure, threatNationId: thirdId, score: 100 };
  world.strategicThreatObservation.exposures.push(targetExposure, thirdExposure);
  const attacker = world.strategicThreatObservation.observationByNationId.get(attackerId)!;
  const target = world.strategicThreatObservation.observationByNationId.get(targetId)!;
  const third = world.strategicThreatObservation.observationByNationId.get(thirdId)!;
  attacker.power.landStrength = 20_000;
  attacker.power.score = 30;
  target.power.landStrength = 2_000;
  target.power.score = 15;
  target.threatScore = 5;
  third.power.score = 100;
  third.threatScore = 100;
  const intent = assessWarIntent(world, { aggressorId: attackerId,
    targetNationId: targetId, route: "land" });
  assert(intent.externalExposure >= 18);
  assert(intent.rejectedReasons.includes("external-threat"));
});

test("maritime intent uses cached reachability and pays a real overseas premium", () => {
  const world = createIntentWorld();
  const [aggressorId, targetNationId] = world.nations.slice(0, 2).map((nation) => nation.id);
  assert.ok(aggressorId && targetNationId);
  world.strategicThreatObservation.exposures.push({ observerNationId: aggressorId,
    threatNationId: targetNationId, score: 15, landAdjacent: false, atWar: false,
    sharedSeaComponent: true, capitalProximity: null, supplyExposure: 0 });
  const generated = generateWarDeclarationCandidates(world, new Set<NationId>([aggressorId]));
  assert(generated.some((item) => item.targetNationId === targetNationId &&
    item.route === "maritime"));
  const candidate = { aggressorId, targetNationId };
  const maritime = assessWarIntent(world, { ...candidate, route: "maritime" });
  const hypotheticalLand = assessWarIntent(world, { ...candidate, route: "land" });
  assert(maritime.expectedCost > hypotheticalLand.expectedCost);
});
