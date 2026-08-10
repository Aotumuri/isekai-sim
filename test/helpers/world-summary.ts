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
  const reserveState = world.strategicReserves;
  const reorganization = world.reorganization;
  const initialUnitCount = world.nations.reduce(
    (total, nation) => total + nation.initialUnitCount,
    0,
  );
  const coverage = world.frontlineCoverage.coverages;
  const frontlineSegments = coverage.reduce((total, item) => total + item.positions.length, 0);
  const gapRuns = coverage.filter((item) => item.maxGapLength > 0);
  const exploitation = world.offensiveOperations;
  const stalemate = world.stalematePressure;
  const strategicProgress = world.strategicProgress;
  const pocketState = world.battlefieldTopology;
  const allPockets = [...pocketState.pockets, ...pocketState.pocketHistory];
  const completedPocketLifetimes = pocketState.pocketHistory.map((pocket) =>
    (pocket.destroyedTick ?? pocket.reopenedTick ?? world.time.fastTick) - pocket.createdTick
  ).sort((a, b) => a - b);
  const reducedPockets = allPockets.filter((pocket) => pocket.firstReductionTick !== null);
  const allOperations = [...world.offensiveOperations.operations, ...world.offensiveOperations.history];
  const successfulClosures = allOperations.filter((operation) =>
    operation.pocketClosureConfirmation?.status === "success"
  );
  const destroyedReducedPockets = pocketState.pocketHistory.filter((pocket) =>
    pocket.status === "destroyed" && pocket.firstReductionTick !== null
  );
  const majorOperations = [...world.offensiveOperations.operations, ...world.offensiveOperations.history]
    .filter((operation) => operation.isMajorOffensive);
  const exploitationOtherStops = Object.entries(exploitation.exploitationStopCounts)
    .filter(([reason]) => ![
      "covered-frontline",
      "local-strength-disadvantage",
      "enemy-reserve-arrival",
      "retreat-started",
      "capital-emergency",
      "front-disappeared",
      "timeout",
    ].includes(reason))
    .reduce((total, [, count]) => total + count, 0);
  return {
    nations: world.nations.length,
    activeNations,
    extinctNations: world.nations.length - activeNations,
    units: world.units.length,
    landUnits: world.units.filter((unit) => unit.domain === "land").length,
    nationalManpowerStock: world.nations.reduce(
      (sum, nation) => sum + nation.resources.manpower,
      0,
    ),
    nationalWeaponsStock: world.nations.reduce(
      (sum, nation) => sum + nation.resources.weapons,
      0,
    ),
    wars: world.wars.length,
    battles: world.battles.length,
    occupations: world.occupation.mesoById.size,
    landFronts: world.landFronts.physicalFronts.length,
    operationalSectors: world.landFronts.operationalSectors.length,
    nationFrontPlans: world.frontPlans.plans.length,
    frontAllocatedUnits: world.frontAllocations.frontIdByUnitId.size,
    frontUnassignedUnits: world.frontAllocations.lastUnassignedUnitCount,
    frontlineSegments,
    frontlineCoveredSegments: coverage.reduce((total, item) => total + item.coveredSegments, 0),
    frontlineWeakSegments: coverage.reduce((total, item) => total + item.weakSegments, 0),
    frontlineGapSegments: coverage.reduce((total, item) => total + item.gapSegments, 0),
    frontlineCoveragePercent: frontlineSegments > 0
      ? coverage.reduce((total, item) => total + item.coverageRatio * item.positions.length, 0) / frontlineSegments * 100
      : 100,
    frontlineAverageGapLength: gapRuns.length > 0
      ? gapRuns.reduce((total, item) => total + item.averageGapLength, 0) / gapRuns.length
      : 0,
    frontlineMaximumGapLength: coverage.reduce((maximum, item) => Math.max(maximum, item.maxGapLength), 0),
    frontlineUniqueDefenderPositions: coverage.reduce((total, item) => total + item.positions.filter((position) => position.defenderUnitIds.length > 0).length, 0),
    frontlineDefenderCount: world.frontlineCoverage.assignmentByUnitId.size,
    frontlineDefenderStrength: coverage.reduce((total, item) => total + item.defenderStrength, 0),
    frontlineMinimumRequiredStrength: coverage.reduce((total, item) => total + item.minimumRequiredStrength, 0),
    frontlineOffensiveSurplusStrength: coverage.reduce((total, item) => total + item.offensiveSurplusStrength, 0),
    frontlineAssignmentSwitches: world.frontlineCoverage.totalAssignmentSwitches,
    frontlineBreakthroughs: world.frontlineCoverage.breakthroughEvents,
    stalemateDetections: stalemate.detections,
    stalemateAverageDuration: stalemate.staticTickSampleCount > 0
      ? stalemate.staticTickSampleTotal / stalemate.staticTickSampleCount : 0,
    stalemateMaximumDuration: stalemate.maxStaticTicks,
    stalemateAveragePressure: stalemate.pressureSampleCount > 0
      ? stalemate.pressureSampleTotal / stalemate.pressureSampleCount : 0,
    stalemateMaximumPressure: stalemate.maxPressure,
    strategicProgressEvents: strategicProgress.progressEventCount,
    strategicProgressPressureResets: strategicProgress.pressureResetCount,
    strategicProgressAverageScore: strategicProgress.scoreSampleCount > 0
      ? strategicProgress.scoreSampleTotal / strategicProgress.scoreSampleCount : 0,
    strategicProgressNetGainEvents:
      strategicProgress.reasonCounts["net-territorial-gain"],
    strategicProgressDisplacementEvents:
      strategicProgress.reasonCounts["sustained-frontline-displacement"],
    strategicProgressBreakthroughEvents:
      strategicProgress.reasonCounts["persistent-breakthrough"],
    strategicProgressCapitalApproachEvents:
      strategicProgress.reasonCounts["capital-approach"],
    strategicProgressFrontCollapseEvents:
      strategicProgress.reasonCounts["operational-front-collapse"],
    strategicProgressOperationEvents:
      strategicProgress.reasonCounts["successful-operation"],
    strategicProgressImportantCaptureEvents:
      strategicProgress.reasonCounts["important-capture"],
    strategicProgressExploitationEvents:
      strategicProgress.reasonCounts["successful-exploitation"],
    schwerpunktSelections: stalemate.selections,
    schwerpunktChanges: stalemate.selectionChanges,
    activeSchwerpunkts: stalemate.assessments.filter((item) => item.schwerpunktSectorId).length,
    schwerpunktAverageConcentrationPercent: stalemate.activeFocusSamples > 0
      ? stalemate.concentrationRatioTotal / stalemate.activeFocusSamples * 100 : 0,
    schwerpunktAverageOffensiveStrength: stalemate.activeFocusSamples > 0
      ? stalemate.allocatedOffensiveStrengthTotal / stalemate.activeFocusSamples : 0,
    schwerpunktAverageReserveContribution: stalemate.activeFocusSamples > 0
      ? stalemate.reserveContributionTotal / stalemate.activeFocusSamples : 0,
    schwerpunktReserveDeployments:
      world.strategicReserves.deploymentCountByReason["schwerpunkt-concentration"],
    reorganizationReturnsToSchwerpunkt:
      world.reorganization.returnedToSchwerpunktCount,
    artificialInactivitySamples: stalemate.artificialInactivitySamples,
    healthyWaitingSamples: stalemate.inactivitySamplesByCategory["healthy-waiting"],
    expectedWaitingSamples: stalemate.inactivitySamplesByCategory["expected-waiting"],
    naturalStalemateSamples: stalemate.inactivitySamplesByCategory["natural-stalemate"],
    unknownInactivitySamples: stalemate.inactivitySamplesByCategory.unknown,
    artificialInactivityPostureBlocks: stalemate.artificialInactivityByBlocker.posture,
    artificialInactivityAllocationBlocks: stalemate.artificialInactivityByBlocker.allocation,
    artificialInactivityTargetBlocks: stalemate.artificialInactivityByBlocker["target-validity"],
    targetFailureNoEnemyInfluence: stalemate.targetValidityFailureCounts["no-enemy-influence-target"],
    targetFailureNoFrontlinePosition: stalemate.targetValidityFailureCounts["no-valid-frontline-position"],
    targetFailureOutsideSector: stalemate.targetValidityFailureCounts["target-outside-current-sector"],
    targetFailureAlreadyOccupied: stalemate.targetValidityFailureCounts["target-already-occupied"],
    targetFailureOwnershipMismatch: stalemate.targetValidityFailureCounts["ownership-mismatch"],
    targetFailureUnreachable: stalemate.targetValidityFailureCounts["unreachable-target"],
    targetFailureGeometryChanged: stalemate.targetValidityFailureCounts["geometry-invalidated"],
    targetFailureDepthRadius: stalemate.targetValidityFailureCounts["depth-radius-restriction"],
    targetFailureNoCandidate: stalemate.targetValidityFailureCounts["no-candidate-after-filtering"],
    targetFailureOther: stalemate.targetValidityFailureCounts.other,
    targetFailureOtherRecoveryCooldown: stalemate.targetValidityOtherCounts.recoveryCooldown,
    targetFailureOtherValidCandidatePending: stalemate.targetValidityOtherCounts.validCandidatePending,
    targetFailureOtherUnknown: stalemate.targetValidityOtherCounts.unknown,
    collapseOpportunities: world.collapseAdvances.opportunitiesDetected,
    collapseAdvancesCreated: world.collapseAdvances.createdCount,
    collapseUnitsCommitted: world.collapseAdvances.unitsCommitted,
    collapseStrengthCommitted: world.collapseAdvances.strengthCommitted,
    collapseTargetsOccupied: world.collapseAdvances.targetsOccupied,
    collapseCitiesOccupied: world.collapseAdvances.citiesOccupied,
    collapseCapitalsOccupied: world.collapseAdvances.capitalsOccupied,
    collapseAverageDepth: world.collapseAdvances.history.length > 0 ? world.collapseAdvances.depthTotal / world.collapseAdvances.history.length : 0,
    collapseAverageDuration: world.collapseAdvances.history.length > 0 ? world.collapseAdvances.durationTotalTicks / world.collapseAdvances.history.length : 0,
    collapseFrontReformationStops: world.collapseAdvances.frontReformationStops,
    collapseArtificialInactivityResolved: world.collapseAdvances.artificialInactivityResolved,
    collapseArtificialInactivityRemaining: world.collapseAdvances.artificialInactivityRemaining,
    battlefieldTopologyRebuilds: world.battlefieldTopology.rebuildCount,
    battlefieldTopologyCacheHits: world.battlefieldTopology.cacheHitCount,
    supplyAssessmentRebuilds: world.supplyAssessment.rebuildCount,
    supplyAssessmentCacheHits: world.supplyAssessment.cacheHitCount,
    supplyAssessmentCacheHitRatePercent:
      world.supplyAssessment.rebuildCount + world.supplyAssessment.cacheHitCount > 0
        ? world.supplyAssessment.cacheHitCount /
          (world.supplyAssessment.rebuildCount + world.supplyAssessment.cacheHitCount) * 100
        : 0,
    suppliedComponents: world.supplyAssessment.assessments.reduce(
      (sum, assessment) => sum + assessment.suppliedComponentCount,
      0,
    ),
    isolatedComponents: world.supplyAssessment.assessments.reduce(
      (sum, assessment) => sum + assessment.isolatedComponentCount,
      0,
    ),
    largestIsolatedStrength: world.supplyAssessment.largestIsolatedStrength,
    longestIsolationDuration: world.supplyAssessment.longestIsolationDuration,
    battlefieldEnemyComponents: world.battlefieldTopology.enemyComponentCount,
    battlefieldArticulationPoints: world.battlefieldTopology.articulationPointCount,
    battlefieldZeroExitComponents: world.battlefieldTopology.zeroExitComponentCount,
    battlefieldOneExitComponents: world.battlefieldTopology.oneExitComponentCount,
    battlefieldCollapseOpportunities: world.battlefieldTopology.collapseOpportunityCount,
    battlefieldCollapseOpportunitiesIgnored: world.battlefieldTopology.ignoredCollapseOpportunityCount,
    battlefieldPocketClosureOpportunities: world.battlefieldTopology.assessments.reduce(
      (sum, assessment) => sum + assessment.pocketClosureOpportunities.length,
      0,
    ),
    pocketClosureOpportunitiesDetected: pocketState.pocketClosureOpportunityCount,
    highValuePocketClosureOpportunities: pocketState.highValuePocketClosureOpportunityCount,
    pocketClosureInvalidations: pocketState.pocketClosureInvalidationCount,
    battlefieldComponentFragmentations: world.battlefieldTopology.componentFragmentationEvents,
    battlefieldWarsEndingAfterCollapse: world.battlefieldTopology.warsEndingAfterCollapse,
    activeMeaningfulPockets: pocketState.pockets.length,
    pocketsCreated: pocketState.pocketsCreatedCount,
    pocketReductionsStarted: allPockets.filter((pocket) => pocket.firstReductionTick !== null).length,
    pocketsDestroyed: pocketState.pocketsDestroyedCount,
    pocketsReopened: pocketState.pocketsReopenedCount,
    pocketAverageLifetime: completedPocketLifetimes.length > 0
      ? completedPocketLifetimes.reduce((sum, value) => sum + value, 0) / completedPocketLifetimes.length : 0,
    pocketMedianLifetime: completedPocketLifetimes.length > 0
      ? completedPocketLifetimes[Math.floor((completedPocketLifetimes.length - 1) / 2)]! : 0,
    pocketLongestLifetime: pocketState.longestPocketLifetime,
    pocketInitialTrappedStrength: allPockets.reduce((sum, pocket) => sum + pocket.initialStrength, 0),
    isolatedStrengthDestroyed: pocketState.isolatedStrengthDestroyed,
    isolatedRegionsCaptured: pocketState.isolatedRegionsCaptured,
    pocketCitiesCaptured: pocketState.pocketCitiesCaptured,
    pocketContainmentStrength: pocketState.pockets.reduce((sum, pocket) => sum + pocket.containmentActual, 0),
    pocketReductionStrength: pocketState.pockets.reduce((sum, pocket) => sum + pocket.reductionStrength, 0),
    pocketReductionOperations: allPockets.reduce((sum, pocket) => sum + pocket.reductionOperationCount, 0),
    pocketAverageRegionsPerOperation: allPockets.reduce((sum, pocket) => sum + pocket.reductionOperationCount, 0) > 0
      ? pocketState.isolatedRegionsCaptured / allPockets.reduce((sum, pocket) => sum + pocket.reductionOperationCount, 0) : 0,
    pocketIdleTicks: allPockets.reduce((sum, pocket) => sum + pocket.idleTicks, 0),
    pocketClosureToReductionLatency: reducedPockets.length > 0
      ? reducedPockets.reduce((sum, pocket) => sum + pocket.firstReductionTick! - pocket.createdTick, 0) / reducedPockets.length : 0,
    pocketReductionToDestructionLatency: destroyedReducedPockets.length > 0
      ? destroyedReducedPockets.reduce((sum, pocket) => sum + pocket.destroyedTick! - pocket.firstReductionTick!, 0) / destroyedReducedPockets.length : 0,
    pocketsSurviving50Ticks: allPockets.filter((pocket) => pocket.strengthAfter50Ticks !== null).length,
    pocketsSurviving100Ticks: allPockets.filter((pocket) => pocket.strengthAfter100Ticks !== null).length,
    pocketsSurviving200Ticks: allPockets.filter((pocket) => pocket.strengthAfter200Ticks !== null).length,
    pocketsSurviving500Ticks: allPockets.filter((pocket) => pocket.strengthAfter500Ticks !== null).length,
    trappedStrengthAfter50Ticks: allPockets.reduce((sum, pocket) => sum + (pocket.strengthAfter50Ticks ?? 0), 0),
    trappedStrengthAfter100Ticks: allPockets.reduce((sum, pocket) => sum + (pocket.strengthAfter100Ticks ?? 0), 0),
    trappedStrengthAfter200Ticks: allPockets.reduce((sum, pocket) => sum + (pocket.strengthAfter200Ticks ?? 0), 0),
    trappedStrengthAfter500Ticks: allPockets.reduce((sum, pocket) => sum + (pocket.strengthAfter500Ticks ?? 0), 0),
    majorOffensivesLaunched: stalemate.majorOffensivesLaunched,
    majorOffensiveSuccesses: stalemate.majorOffensiveSuccesses,
    majorOffensiveFailures: stalemate.majorOffensiveFailures,
    majorOffensiveAverageStrength: majorOperations.length > 0
      ? majorOperations.reduce((sum, operation) => sum + operation.initialAssignedStrength, 0) / majorOperations.length : 0,
    majorOffensiveSurplusUtilizationPercent: majorOperations.length > 0
      ? majorOperations.reduce((sum, operation) => sum + operation.initialAssignedStrength / Math.max(1, operation.offensiveSurplusAvailable), 0) / majorOperations.length * 100 : 0,
    majorOffensiveAverageLocalRatio: majorOperations.length > 0
      ? majorOperations.reduce((sum, operation) => sum + operation.localStrengthRatioAtAttack, 0) / majorOperations.length : 0,
    activeOffensiveOperations: world.offensiveOperations.operations.filter(
      (operation) => operation.phase !== "recovering",
    ).length,
    exploitingOffensiveOperations: world.offensiveOperations.operations.filter(
      (operation) => operation.phase === "exploiting",
    ).length,
    recoveringOffensiveOperations: world.offensiveOperations.operations.filter(
      (operation) => operation.phase === "recovering",
    ).length,
    operationAssignedUnits: world.offensiveOperations.operationIdByUnitId.size,
    operationsCreated: world.offensiveOperations.createdCount,
    pocketClosureOperationsCreated: world.offensiveOperations.pocketClosureCreatedCount,
    pocketClosureSuccesses: world.offensiveOperations.pocketClosureSuccessCount,
    pocketClosureFailures: world.offensiveOperations.pocketClosureFailureCount,
    pocketClosureAverageDuration: successfulClosures.length > 0
      ? successfulClosures.reduce((sum, operation) => sum + operation.pocketClosureConfirmation!.confirmedAtTick - operation.pocketClosureObjective!.detectedAtTick, 0) / successfulClosures.length : 0,
    pocketClosureTrappedRegions: successfulClosures.reduce((sum, operation) => sum + operation.pocketClosureConfirmation!.trappedRegionIds.length, 0),
    pocketClosureTrappedStrength: successfulClosures.reduce((sum, operation) => sum + operation.pocketClosureConfirmation!.trappedStrength, 0),
    pocketClosureTrappedCities: successfulClosures.reduce((sum, operation) => sum + operation.pocketClosureConfirmation!.trappedCities, 0),
    pocketReductionOperationsCreated: world.offensiveOperations.pocketReductionCreatedCount,
    operationsCompleted: world.offensiveOperations.completedCount,
    operationsFailed: world.offensiveOperations.failedCount,
    operationsCancelled: world.offensiveOperations.cancelledCount,
    operationSuccessRatePercent:
      resolvedOperations > 0
        ? (world.offensiveOperations.completedCount / resolvedOperations) * 100
        : 0,
    operationMaxTargetConcentration:
      world.offensiveOperations.maxTargetConcentration,
    operationAverageCapturedRegions: world.offensiveOperations.completedCount > 0
      ? world.offensiveOperations.successfulCapturedRegionCount / world.offensiveOperations.completedCount
      : 0,
    operationAverageAttackDuration: resolvedOperations > 0
      ? world.offensiveOperations.attackingDurationTicks / resolvedOperations
      : 0,
    coordinatedOperationsCreated: world.offensiveOperations.coordinatedCreatedCount,
    operationAveragePlannedApproaches: world.offensiveOperations.createdCount > 0
      ? world.offensiveOperations.plannedApproachCountTotal / world.offensiveOperations.createdCount
      : 0,
    operationAverageAchievedApproaches: world.offensiveOperations.createdCount > 0
      ? world.offensiveOperations.achievedApproachCountTotal / world.offensiveOperations.createdCount
      : 0,
    operationAverageSynchronizationWait: world.offensiveOperations.achievedApproachCountTotal > 0
      ? world.offensiveOperations.synchronizationWaitTicks /
        Math.max(1, world.offensiveOperations.operations.filter((operation) => operation.synchronizationReady).length + world.offensiveOperations.history.filter((operation) => operation.synchronizationReady).length)
      : 0,
    operationSingleApproachFallbacks: world.offensiveOperations.singleApproachFallbackCount,
    operationCandidatesCreated: exploitation.candidatesCreatedCount,
    operationCandidatesAccepted: exploitation.candidatesAcceptedCount,
    operationCandidatesRejected: exploitation.candidatesRejectedCount,
    operationCandidateRejectedOnTime:
      exploitation.candidateRejectionCounts["insufficient-on-time-strength"],
    operationCandidateRejectedUnits:
      exploitation.candidateRejectionCounts["insufficient-units"],
    operationImpossibleAtCreation: exploitation.impossibleAtCreationCount,
    operationImpossibleDuringPreparation:
      exploitation.impossibleDuringPreparationCount,
    operationLeaseOverrides: exploitation.leaseOverrideCount,
    operationAllocationReclaims: exploitation.allocationReclaimCount,
    operationReplacementArrivals: exploitation.replacementArrivalCount,
    operationReplacementImpossible: exploitation.replacementImpossibleCount,
    operationAverageArrivalSlack: exploitation.arrivalSlackCount > 0
      ? exploitation.arrivalSlackTotal / exploitation.arrivalSlackCount
      : 0,
    operationMinimumArrivalSlack: exploitation.minimumArrivalSlack ?? 0,
    operationAverageLeaseLifetime: exploitation.preparationLeaseLifetimeCount > 0
      ? exploitation.preparationLeaseLifetimeTotal /
        exploitation.preparationLeaseLifetimeCount
      : 0,
    operationPreparationSuccessRatePercent:
      exploitation.preparationSucceededCount + exploitation.preparationTimeoutCount +
        exploitation.impossibleDuringPreparationCount > 0
        ? exploitation.preparationSucceededCount /
          (exploitation.preparationSucceededCount + exploitation.preparationTimeoutCount +
            exploitation.impossibleDuringPreparationCount) * 100
        : 0,
    operationPreparationTimeoutRatePercent:
      exploitation.preparationSucceededCount + exploitation.preparationTimeoutCount +
        exploitation.impossibleDuringPreparationCount > 0
        ? exploitation.preparationTimeoutCount /
          (exploitation.preparationSucceededCount + exploitation.preparationTimeoutCount +
            exploitation.impossibleDuringPreparationCount) * 100
        : 0,
    operationAveragePreparationDuration:
      exploitation.preparationSucceededCount + exploitation.preparationTimeoutCount +
        exploitation.impossibleDuringPreparationCount > 0
        ? exploitation.preparingDurationTicks /
          (exploitation.preparationSucceededCount + exploitation.preparationTimeoutCount +
            exploitation.impossibleDuringPreparationCount)
        : 0,
    operationTimeoutMissingStrength:
      exploitation.preparationTimeoutMissingStrength,
    operationTimeoutTravellingStrength:
      exploitation.preparationTimeoutTravellingStrength,
    exploitationStarts: exploitation.exploitationStartedCount,
    exploitationSuccesses: exploitation.exploitationSuccessCount,
    exploitationSuccessRatePercent: exploitation.exploitationStartedCount > 0
      ? exploitation.exploitationSuccessCount / exploitation.exploitationStartedCount * 100
      : 0,
    exploitationAverageDepth: exploitation.exploitationStartedCount > 0
      ? exploitation.exploitationDepthTotal / exploitation.exploitationStartedCount
      : 0,
    exploitationAverageForceUnits: exploitation.exploitationStartedCount > 0
      ? exploitation.exploitationForceUnitTotal / exploitation.exploitationStartedCount
      : 0,
    exploitationAverageForceStrength: exploitation.exploitationStartedCount > 0
      ? exploitation.exploitationForceStrengthTotal / exploitation.exploitationStartedCount
      : 0,
    exploitationAverageDuration: exploitation.exploitationStoppedCount > 0
      ? exploitation.exploitationDurationTicks / exploitation.exploitationStoppedCount
      : 0,
    exploitationStopsCovered: exploitation.exploitationStopCounts["covered-frontline"],
    exploitationStopsLocalDisadvantage: exploitation.exploitationStopCounts["local-strength-disadvantage"],
    exploitationStopsReserve: exploitation.exploitationStopCounts["enemy-reserve-arrival"],
    exploitationStopsRetreat: exploitation.exploitationStopCounts["retreat-started"],
    exploitationStopsCapital: exploitation.exploitationStopCounts["capital-emergency"],
    exploitationStopsFrontDisappeared: exploitation.exploitationStopCounts["front-disappeared"],
    exploitationStopsTimeout: exploitation.exploitationStopCounts.timeout,
    exploitationStopsOther: exploitationOtherStops,
    exploitationCandidatesGap: exploitation.exploitationCandidateEvaluatedCounts.gap,
    exploitationCandidatesWeak: exploitation.exploitationCandidateEvaluatedCounts.weak,
    exploitationCandidatesCovered: exploitation.exploitationCandidateEvaluatedCounts.covered,
    exploitationSelectedGap: exploitation.exploitationSelectedCounts.gap,
    exploitationSelectedWeak: exploitation.exploitationSelectedCounts.weak,
    exploitationSelectedCovered: exploitation.exploitationSelectedCounts.covered,
    exploitationRejectedLocalStrength: exploitation.exploitationRejectionCounts.insufficientLocalStrength,
    exploitationRejectedUnreachable: exploitation.exploitationRejectionCounts.unreachable,
    exploitationRejectedReserve: exploitation.exploitationRejectionCounts.reserveThreat,
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
    firstCapitalFallTick: world.capitalDefense.capitalFallTicks[0] ?? -1,
    capitalUnguardedTicks: world.capitalDefense.unguardedTickCount,
    reserveNations: reserveState.reserves.length,
    reserveUnits: reserveState.reserveNationByUnitId.size,
    reserveStrength: reserveState.reserves.reduce(
      (total, reserve) => total + reserve.totalStrength,
      0,
    ),
    desiredReserveStrength: reserveState.reserves.reduce(
      (total, reserve) => total + reserve.desiredReserveStrength,
      0,
    ),
    readyReserves: reserveState.reserves.filter(
      (reserve) => reserve.status === "ready",
    ).length,
    deployingReserves: reserveState.reserves.filter(
      (reserve) => reserve.status === "deploying",
    ).length,
    returningReserves: reserveState.reserves.filter(
      (reserve) => reserve.status === "returning",
    ).length,
    reserveFormations: reserveState.formationCount,
    reserveMembershipChanges: reserveState.membershipChangeCount,
    reserveDeployments: reserveState.deploymentCount,
    reserveGapOrBreakthroughDeployments: reserveState.deploymentCountByReason["front-collapse"],
    reserveDeployedUnits: reserveState.deployedUnitCount,
    reserveAverageUnits:
      reserveState.sampleCount > 0
        ? reserveState.sampledUnitCount / reserveState.sampleCount
        : 0,
    reserveAverageStrength:
      reserveState.sampleCount > 0
        ? reserveState.sampledStrength / reserveState.sampleCount
        : 0,
    reserveArrivalLatency:
      reserveState.arrivalLatencySampleCount > 0
        ? reserveState.arrivalLatencyTicks / reserveState.arrivalLatencySampleCount
        : 0,
    capitalReserveArrivalLatency:
      reserveState.capitalArrivalLatencySampleCount > 0
        ? reserveState.capitalArrivalLatencyTicks /
          reserveState.capitalArrivalLatencySampleCount
        : 0,
    reserveFrontDeficitImprovement: reserveState.frontDeficitImprovement,
    reserveRetreatFallbackArrivals: reserveState.retreatFallbackArrivalCount,
    reserveReturnsStarted: reserveState.returnStartedCount,
    reserveReturnsCompleted: reserveState.returnCompletedCount,
    activeReorganizationPlans: reorganization.plans.length,
    movingReorganizationPlans: reorganization.plans.filter(
      (plan) => plan.phase === "moving-to-rear",
    ).length,
    reorganizingUnits: reorganization.plans.filter(
      (plan) => plan.phase === "reorganizing",
    ).length,
    reorganizationPlansCreated: reorganization.createdCount,
    reorganizationPlansCompleted: reorganization.completedCount,
    reorganizationPlansCancelled: reorganization.cancelledCount,
    reorganizationInterruptions: reorganization.interruptedCount,
    reorganizationOrganizationRecovered: reorganization.organizationRecovered,
    reorganizationManpowerReinforced: reorganization.manpowerReinforced,
    reorganizationEquipmentReinforced: reorganization.equipmentReinforced,
    reorganizationManpowerConsumed: reorganization.manpowerResourceConsumed,
    reorganizationEquipmentConsumed: reorganization.equipmentStockConsumed,
    suppliedReorganizationEvaluations: reorganization.suppliedEvaluations,
    isolatedReorganizationEvaluations: reorganization.isolatedEvaluations,
    manpowerReinforcementBlockedByIsolation:
      reorganization.manpowerBlockedByIsolationCount,
    equipmentReinforcementBlockedByIsolation:
      reorganization.equipmentBlockedByIsolationCount,
    manpowerReinforcementDeniedByIsolation:
      reorganization.manpowerDeniedByIsolation,
    equipmentReinforcementDeniedByIsolation:
      reorganization.equipmentDeniedByIsolation,
    reorganizationPlansEnteringIsolation: reorganization.plansEnteringIsolation,
    reorganizationPlansReconnecting: reorganization.plansReconnecting,
    isolatedReorganizationDuration: reorganization.isolatedDurationTicks,
    stalledIsolatedReorganizationPlans: reorganization.stalledIsolatedPlans,
    isolatedReorganizationPlansReady: reorganization.isolatedPlansReachingReady,
    suppliedReorganizationPlansReady: reorganization.suppliedPlansReachingReady,
    isolatedReorganizationUnitsInsidePockets:
      reorganization.isolatedReorganizationUnitsInsidePockets,
    reinforcementDeniedInsidePockets:
      reorganization.reinforcementDeniedInsidePockets,
    averageManpowerStockBeforeTransfer: reorganization.resourceTransferSamples > 0
      ? reorganization.manpowerStockBeforeTransfers / reorganization.resourceTransferSamples
      : 0,
    averageManpowerStockAfterTransfer: reorganization.resourceTransferSamples > 0
      ? reorganization.manpowerStockAfterTransfers / reorganization.resourceTransferSamples
      : 0,
    averageWeaponsStockBeforeTransfer: reorganization.resourceTransferSamples > 0
      ? reorganization.weaponsStockBeforeTransfers / reorganization.resourceTransferSamples
      : 0,
    averageWeaponsStockAfterTransfer: reorganization.resourceTransferSamples > 0
      ? reorganization.weaponsStockAfterTransfers / reorganization.resourceTransferSamples
      : 0,
    suppliedOrganizationRecoveryEvaluations:
      reorganization.suppliedOrganizationRecoveryEvaluations,
    isolatedOrganizationRecoveryEvaluations:
      reorganization.isolatedOrganizationRecoveryEvaluations,
    organizationRecoveryBlockedByIsolation:
      reorganization.organizationBlockedByIsolationCount,
    organizationRecoveryDeniedByIsolation:
      reorganization.organizationDeniedByIsolation,
    isolatedPlansStalledByOrganization:
      reorganization.isolatedPlansStalledByOrganization,
    reconnectedPlansResumingOrganization:
      reorganization.reconnectedPlansResumingOrganization,
    averageIsolationToReconnection:
      reorganization.isolationToReconnectionSamples > 0
        ? reorganization.isolationToReconnectionTicks /
          reorganization.isolationToReconnectionSamples
        : 0,
    averageReconnectionToReady: reorganization.reconnectionToReadySamples > 0
      ? reorganization.reconnectionToReadyTicks /
        reorganization.reconnectionToReadySamples
      : 0,
    averageIsolatedReorganizationDuration: reorganization.plansEnteringIsolation > 0
      ? reorganization.isolatedDurationTicks / reorganization.plansEnteringIsolation
      : 0,
    isolatedPocketUnitsEnteringReorganization:
      reorganization.isolatedPocketUnitsEnteringReorganization,
    organizationRecoveryDeniedInsidePockets:
      reorganization.organizationDeniedInsidePockets,
    pocketUnitsReturningToCombat: reorganization.pocketUnitsReturningToCombat,
    averageReorganizationDuration:
      reorganization.completedCount > 0
        ? reorganization.totalDurationTicks / reorganization.completedCount
        : 0,
    reorganizationReturnedToFront: reorganization.returnedToFrontCount,
    reorganizationReturnedToReserve: reorganization.returnedToReserveCount,
    retreatSurvivorsReinserted: reorganization.retreatSurvivorsReturnedCount,
    reserveSurvivorsReinserted: reorganization.reserveSurvivorsReturnedCount,
    emergencyEarlyDeployments: reorganization.emergencyEarlyDeploymentCount,
    reorganizationResourceShortages: reorganization.resourceShortageCount,
    unitsWaitingForManpower: reorganization.unitsWaitingForManpower,
    unitsWaitingForEquipment: reorganization.unitsWaitingForEquipment,
    observedUnitDestructions: reorganization.destroyedUnitCount,
    averageDestroyedUnitLifetime:
      reorganization.destroyedUnitCount > 0
        ? reorganization.destroyedUnitLifetimeTicks /
          reorganization.destroyedUnitCount
        : 0,
    newUnitsProduced: Math.max(0, world.unitIdCounter - initialUnitCount),
    observedNationEliminations: reorganization.nationEliminationCount,
    firstNationEliminationTick:
      reorganization.firstNationEliminationTick ?? -1,
    microRegions: world.microRegions.length,
    mesoRegions: world.mesoRegions.length,
    macroRegions: world.macroRegions.length,
    territoryVersion: world.territoryVersion,
    occupationVersion: world.occupation.version,
    buildingVersion: world.buildingVersion,
  };
}
