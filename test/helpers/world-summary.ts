import { isNationActive } from "../../src/sim/nation-active";
import type { WorldState } from "../../src/sim/world-state";
import type { WorldSummary } from "../benchmark/types";

export function summarizeWorld(world: WorldState): WorldSummary {
  const activeNations = world.nations.filter(isNationActive).length;
  const activeCapitalAssessments = world.capitalDefense.assessments.filter(
    (assessment) => assessment.threatLevel !== "none",
  );
  const capitalDefenseUnitIds = new Set(
    activeCapitalAssessments.flatMap((assessment) => assessment.friendlyUnitIds),
  );
  const capitalFrontIdsByNation = new Map(
    activeCapitalAssessments.map((assessment) => [
      assessment.nationId,
      new Set(assessment.threatenedFrontIds),
    ]),
  );
  const capitalFrontDesiredStrength = world.frontPlans.plans.reduce(
    (total, plan) =>
      capitalFrontIdsByNation.get(plan.nationId)?.has(plan.frontId)
        ? total + plan.desiredStrength
        : total,
    0,
  );
  const capitalFrontDistances = activeCapitalAssessments
    .map((assessment) => assessment.nearestFrontDistance)
    .filter((distance): distance is number => distance !== null);
  const resolvedOperations =
    world.offensiveOperations.completedCount +
    world.offensiveOperations.failedCount;
  return {
    nations: world.nations.length,
    activeNations,
    extinctNations: world.nations.length - activeNations,
    units: world.units.length,
    landUnits: world.units.filter((unit) => unit.domain === "land").length,
    wars: world.wars.length,
    battles: world.battles.length,
    occupations: world.occupation.mesoById.size,
    landFronts: world.landFronts.physicalFronts.length,
    nationFrontPlans: world.frontPlans.plans.length,
    frontAllocatedUnits: world.frontAllocations.frontIdByUnitId.size,
    frontUnassignedUnits: world.frontAllocations.lastUnassignedUnitCount,
    activeOffensiveOperations: world.offensiveOperations.operations.filter(
      (operation) => operation.phase !== "recovering",
    ).length,
    recoveringOffensiveOperations: world.offensiveOperations.operations.filter(
      (operation) => operation.phase === "recovering",
    ).length,
    operationAssignedUnits: world.offensiveOperations.operationIdByUnitId.size,
    operationsCreated: world.offensiveOperations.createdCount,
    operationsCompleted: world.offensiveOperations.completedCount,
    operationsFailed: world.offensiveOperations.failedCount,
    operationsCancelled: world.offensiveOperations.cancelledCount,
    operationSuccessRatePercent:
      resolvedOperations > 0
        ? (world.offensiveOperations.completedCount / resolvedOperations) * 100
        : 0,
    operationMaxTargetConcentration:
      world.offensiveOperations.maxTargetConcentration,
    activeRetreatPlans: world.retreatPlans.plans.length,
    retreatCommittedUnits: world.retreatPlans.retreatIdByUnitId.size,
    retreatsCreated: world.retreatPlans.createdCount,
    retreatsCompleted: world.retreatPlans.completedCount,
    retreatsCancelled: world.retreatPlans.cancelledCount,
    retreatSuccessRatePercent:
      world.retreatPlans.createdCount > 0
        ? (world.retreatPlans.successfulCount / world.retreatPlans.createdCount) * 100
        : 0,
    retreatArrivedUnits: world.retreatPlans.arrivedUnitCount,
    retreatStrengthLossRatePercent:
      world.retreatPlans.initialRetreatingStrength > 0
        ? Math.max(
            0,
            (1 -
              (world.retreatPlans.survivingRetreatingStrength +
                world.retreatPlans.plans.reduce(
                  (total, retreat) =>
                    total + retreat.currentRetreatingStrength,
                  0,
                )) /
                world.retreatPlans.initialRetreatingStrength) *
              100,
          )
        : 0,
    retreatRegroupedToFront: world.retreatPlans.regroupedToDefensiveFrontCount,
    retreatReturnedToDefense: world.retreatPlans.returnedToHoldOrReinforceCount,
    retreatUnitTargetSwitches: world.retreatPlans.unitTargetSwitchCount,
    activeCapitalEmergencies: activeCapitalAssessments.length,
    criticalCapitalEmergencies: activeCapitalAssessments.filter(
      (assessment) => assessment.threatLevel === "critical",
    ).length,
    capitalEmergencyCount: world.capitalDefense.emergencyCount,
    capitalEmergencyDurationTicks: world.capitalDefense.emergencyDurationTicks,
    capitalDefenseUnits: capitalDefenseUnitIds.size,
    capitalFrontDesiredStrength,
    capitalFriendlyStrength: activeCapitalAssessments.reduce(
      (total, assessment) => total + assessment.friendlyStrength,
      0,
    ),
    capitalEnemyStrength: activeCapitalAssessments.reduce(
      (total, assessment) => total + assessment.enemyStrength,
      0,
    ),
    capitalNearestFrontDistance:
      capitalFrontDistances.length > 0
        ? Math.min(...capitalFrontDistances)
        : -1,
    capitalReallocatedUnits: world.capitalDefense.reallocatedUnitCount,
    capitalFallbackSelections: world.capitalDefense.fallbackSelectionCount,
    capitalOperationCancellations:
      world.capitalDefense.operationCancellationCount,
    capitalFalls: world.capitalDefense.capitalFallCount,
    capitalUnguardedTicks: world.capitalDefense.unguardedTickCount,
    microRegions: world.microRegions.length,
    mesoRegions: world.mesoRegions.length,
    macroRegions: world.macroRegions.length,
    territoryVersion: world.territoryVersion,
    occupationVersion: world.occupation.version,
    buildingVersion: world.buildingVersion,
  };
}
