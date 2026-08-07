import { isNationActive } from "../../src/sim/nation-active";
import type { WorldState } from "../../src/sim/world-state";
import type { WorldSummary } from "../benchmark/types";

export function summarizeWorld(world: WorldState): WorldSummary {
  const activeNations = world.nations.filter(isNationActive).length;
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
    microRegions: world.microRegions.length,
    mesoRegions: world.mesoRegions.length,
    macroRegions: world.macroRegions.length,
    territoryVersion: world.territoryVersion,
    occupationVersion: world.occupation.version,
    buildingVersion: world.buildingVersion,
  };
}
