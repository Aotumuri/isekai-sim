export const BENCHMARK_SCENARIOS = [
  "base-world",
  "active-war",
  "many-units",
  "civil-war",
  "late-game",
  "retreat-heavy",
  "capital-threat",
  "strategic-reserve",
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
  nationFrontPlans: number;
  frontAllocatedUnits: number;
  frontUnassignedUnits: number;
  activeOffensiveOperations: number;
  recoveringOffensiveOperations: number;
  operationAssignedUnits: number;
  operationsCreated: number;
  operationsCompleted: number;
  operationsFailed: number;
  operationsCancelled: number;
  operationSuccessRatePercent: number;
  operationMaxTargetConcentration: number;
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
  reserveDeployedUnits: number;
  reserveAverageUnits: number;
  reserveAverageStrength: number;
  reserveArrivalLatency: number;
  capitalReserveArrivalLatency: number;
  reserveFrontDeficitImprovement: number;
  reserveRetreatFallbackArrivals: number;
  reserveReturnsStarted: number;
  reserveReturnsCompleted: number;
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
  virtualElapsedMs: number;
  wallClockMs: number;
  effectiveSimulationSpeed: number;
  throughputTicksPerSecond: number;
  startWorld: WorldSummary;
  endWorld: WorldSummary;
  metrics: Record<string, MetricSummary>;
  counters: Record<string, number>;
}
