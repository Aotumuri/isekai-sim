export const BENCHMARK_SCENARIOS = [
  "base-world",
  "active-war",
  "many-units",
  "civil-war",
  "late-game",
  "retreat-heavy",
  "capital-threat",
  "strategic-reserve",
  "reorganization-heavy",
  "long-frontline",
  "gap-exploitation",
  "stalemate-breaker",
  "collapse-advance",
] as const;

export type BenchmarkScenarioName = (typeof BENCHMARK_SCENARIOS)[number];
export type BenchmarkMode = "throughput" | "frame-loop";

export interface BenchmarkOptions {
  scenario: BenchmarkScenarioName;
  seed: number;
  ticks: number;
  width: number;
  height: number;
  speed: number;
  mode: BenchmarkMode;
  frameDeltaMs: number;
  quick: boolean;
  reserveEnabled: boolean;
  reorganizationEnabled: boolean;
  exploitationEnabled: boolean;
}

export interface MetricSummary {
  count: number;
  totalMs: number;
  averageMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  retainedSamples: number;
}

export interface WorldSummary {
  nations: number;
  activeNations: number;
  extinctNations: number;
  units: number;
  landUnits: number;
  wars: number;
  battles: number;
  occupations: number;
  landFronts: number;
  operationalSectors: number;
  nationFrontPlans: number;
  frontAllocatedUnits: number;
  frontUnassignedUnits: number;
  frontlineSegments: number;
  frontlineCoveredSegments: number;
  frontlineWeakSegments: number;
  frontlineGapSegments: number;
  frontlineCoveragePercent: number;
  frontlineAverageGapLength: number;
  frontlineMaximumGapLength: number;
  frontlineUniqueDefenderPositions: number;
  frontlineDefenderCount: number;
  frontlineDefenderStrength: number;
  frontlineMinimumRequiredStrength: number;
  frontlineOffensiveSurplusStrength: number;
  frontlineAssignmentSwitches: number;
  frontlineBreakthroughs: number;
  stalemateDetections: number;
  stalemateAverageDuration: number;
  stalemateMaximumDuration: number;
  stalemateAveragePressure: number;
  stalemateMaximumPressure: number;
  schwerpunktSelections: number;
  schwerpunktChanges: number;
  activeSchwerpunkts: number;
  artificialInactivitySamples: number;
  healthyWaitingSamples: number;
  expectedWaitingSamples: number;
  naturalStalemateSamples: number;
  unknownInactivitySamples: number;
  artificialInactivityPostureBlocks: number;
  artificialInactivityAllocationBlocks: number;
  artificialInactivityTargetBlocks: number;
  targetFailureNoEnemyInfluence: number;
  targetFailureNoFrontlinePosition: number;
  targetFailureOutsideSector: number;
  targetFailureAlreadyOccupied: number;
  targetFailureOwnershipMismatch: number;
  targetFailureUnreachable: number;
  targetFailureGeometryChanged: number;
  targetFailureDepthRadius: number;
  targetFailureNoCandidate: number;
  targetFailureOther: number;
  targetFailureOtherRecoveryCooldown: number;
  targetFailureOtherValidCandidatePending: number;
  targetFailureOtherUnknown: number;
  collapseOpportunities: number;
  collapseAdvancesCreated: number;
  collapseUnitsCommitted: number;
  collapseStrengthCommitted: number;
  collapseTargetsOccupied: number;
  collapseCitiesOccupied: number;
  collapseCapitalsOccupied: number;
  collapseAverageDepth: number;
  collapseAverageDuration: number;
  collapseFrontReformationStops: number;
  collapseArtificialInactivityResolved: number;
  collapseArtificialInactivityRemaining: number;
  majorOffensivesLaunched: number;
  majorOffensiveSuccesses: number;
  majorOffensiveFailures: number;
  majorOffensiveAverageStrength: number;
  majorOffensiveSurplusUtilizationPercent: number;
  majorOffensiveAverageLocalRatio: number;
  activeOffensiveOperations: number;
  exploitingOffensiveOperations: number;
  recoveringOffensiveOperations: number;
  operationAssignedUnits: number;
  operationsCreated: number;
  operationsCompleted: number;
  operationsFailed: number;
  operationsCancelled: number;
  operationSuccessRatePercent: number;
  operationMaxTargetConcentration: number;
  operationAverageCapturedRegions: number;
  operationAverageAttackDuration: number;
  coordinatedOperationsCreated: number;
  operationAveragePlannedApproaches: number;
  operationAverageAchievedApproaches: number;
  operationAverageSynchronizationWait: number;
  operationSingleApproachFallbacks: number;
  exploitationStarts: number;
  exploitationSuccesses: number;
  exploitationSuccessRatePercent: number;
  exploitationAverageDepth: number;
  exploitationAverageForceUnits: number;
  exploitationAverageForceStrength: number;
  exploitationAverageDuration: number;
  exploitationStopsCovered: number;
  exploitationStopsLocalDisadvantage: number;
  exploitationStopsReserve: number;
  exploitationStopsRetreat: number;
  exploitationStopsCapital: number;
  exploitationStopsFrontDisappeared: number;
  exploitationStopsTimeout: number;
  exploitationStopsOther: number;
  exploitationCandidatesGap: number;
  exploitationCandidatesWeak: number;
  exploitationCandidatesCovered: number;
  exploitationSelectedGap: number;
  exploitationSelectedWeak: number;
  exploitationSelectedCovered: number;
  exploitationRejectedLocalStrength: number;
  exploitationRejectedUnreachable: number;
  exploitationRejectedReserve: number;
  activeRetreatPlans: number;
  retreatCommittedUnits: number;
  retreatsCreated: number;
  retreatsCompleted: number;
  retreatsCancelled: number;
  retreatSuccessRatePercent: number;
  retreatArrivedUnits: number;
  retreatStrengthLossRatePercent: number;
  retreatRegroupedToFront: number;
  retreatReturnedToDefense: number;
  retreatUnitTargetSwitches: number;
  activeCapitalEmergencies: number;
  criticalCapitalEmergencies: number;
  capitalEmergencyCount: number;
  capitalEmergencyDurationTicks: number;
  capitalDefenseUnits: number;
  capitalFrontDesiredStrength: number;
  capitalFriendlyStrength: number;
  capitalEnemyStrength: number;
  capitalNearestFrontDistance: number;
  capitalReallocatedUnits: number;
  capitalFallbackSelections: number;
  capitalOperationCancellations: number;
  capitalFalls: number;
  firstCapitalFallTick: number;
  capitalUnguardedTicks: number;
  reserveNations: number;
  reserveUnits: number;
  reserveStrength: number;
  desiredReserveStrength: number;
  readyReserves: number;
  deployingReserves: number;
  returningReserves: number;
  reserveFormations: number;
  reserveMembershipChanges: number;
  reserveDeployments: number;
  reserveGapOrBreakthroughDeployments: number;
  reserveDeployedUnits: number;
  reserveAverageUnits: number;
  reserveAverageStrength: number;
  reserveArrivalLatency: number;
  capitalReserveArrivalLatency: number;
  reserveFrontDeficitImprovement: number;
  reserveRetreatFallbackArrivals: number;
  reserveReturnsStarted: number;
  reserveReturnsCompleted: number;
  activeReorganizationPlans: number;
  movingReorganizationPlans: number;
  reorganizingUnits: number;
  reorganizationPlansCreated: number;
  reorganizationPlansCompleted: number;
  reorganizationPlansCancelled: number;
  reorganizationInterruptions: number;
  reorganizationOrganizationRecovered: number;
  reorganizationManpowerReinforced: number;
  reorganizationEquipmentReinforced: number;
  reorganizationManpowerConsumed: number;
  reorganizationEquipmentConsumed: number;
  averageReorganizationDuration: number;
  reorganizationReturnedToFront: number;
  reorganizationReturnedToReserve: number;
  retreatSurvivorsReinserted: number;
  reserveSurvivorsReinserted: number;
  emergencyEarlyDeployments: number;
  reorganizationResourceShortages: number;
  unitsWaitingForManpower: number;
  unitsWaitingForEquipment: number;
  observedUnitDestructions: number;
  averageDestroyedUnitLifetime: number;
  newUnitsProduced: number;
  observedNationEliminations: number;
  firstNationEliminationTick: number;
  microRegions: number;
  mesoRegions: number;
  macroRegions: number;
  territoryVersion: number;
  occupationVersion: number;
  buildingVersion: number;
}

export interface BenchmarkResult {
  schemaVersion: 1;
  generatedAt: string;
  scenario: BenchmarkScenarioName;
  seed: number;
  mode: BenchmarkMode;
  requestedTicks: number;
  processedFastTicks: number;
  processedSlowTicks: number;
  speed: number;
  frameDeltaMs: number;
  reserveEnabled: boolean;
  reorganizationEnabled: boolean;
  exploitationEnabled: boolean;
  virtualElapsedMs: number;
  wallClockMs: number;
  effectiveSimulationSpeed: number;
  throughputTicksPerSecond: number;
  startWorld: WorldSummary;
  endWorld: WorldSummary;
  metrics: Record<string, MetricSummary>;
  counters: Record<string, number>;
}
