import { mkdir, writeFile } from "node:fs/promises";
import {
  setAmphibiousDiagnosticObserver,
  type AmphibiousCapabilityDemand,
  type AmphibiousOperation,
  type AmphibiousOperationConnectionDiagnostic,
  type AmphibiousLaunchFeasibilityDiagnostic,
} from "../../src/sim/amphibious";
import { isEffectivelyControlledPort } from "../../src/sim/maritime-supply";
import { FAST_TICK_MS, SLOW_TICK_MS } from "../../src/sim/time";
import { stepFastTick, stepSlowTick } from "../../src/sim/update";
import { getMesoById, getNeighborsById, getOwnerByMesoId } from "../../src/sim/world-cache";
import type { WorldState } from "../../src/sim/world-state";
import type { WarState } from "../../src/sim/war-state";
import { createScenarioWorld } from "../scenarios";

const SCENARIO = "active-war";
const FIRST_SEED = 822_748_319_788;
const LAST_SEED = 822_748_319_817;
const FAST_TICKS = 3_200;
const OUTPUT_PATH = "diagnostics/fleet-ready-report.json";

type FinalOutcome =
  | "launched" | "expired" | "cancelled" | "war ended" | "opportunity disappeared"
  | "departure port lost" | "destination invalid" | "merged" | "superseded"
  | "route invalid" | "transport lost" | "escort lost" | "never launched" | "other";

const PREDICTION_QUALITY_THRESHOLDS = {
  highlyPessimistic: "windowRatio < 0.5", moderatelyPessimistic: "0.5 <= windowRatio < 0.8",
  accurate: "0.8 <= windowRatio <= 1.25", moderatelyOptimistic: "1.25 < windowRatio <= 1.5", highlyOptimistic: "windowRatio > 1.5",
} as const;

interface ReadinessLoss {
  transportRemoved: boolean;
  escortRemoved: boolean;
  landForceRemoved: boolean;
  routeInvalid: boolean;
  portChanged: boolean;
  leaseRevoked: boolean;
  other: boolean;
}

interface DemandRecord {
  demandId: string;
  seed: number;
  warId: string;
  attacker: string;
  defender: string;
  creationTick: number;
  fleetTargetTick: number | null;
  fleetReadyTick: number | null;
  launchTick: number | null;
  landingTick: number | null;
  beachheadTick: number | null;
  terminationTick: number | null;
  requiredTransports: number;
  requiredEscorts: number;
  assignedTransports: number;
  assignedEscorts: number;
  landingStrength: number;
  departurePort: string;
  destinationPort: string;
  finalOutcome: FinalOutcome;
  finalOutcomeReason: string | null;
  readinessEverLostAgain: boolean;
  readinessLost: ReadinessLoss | null;
  lifecycle: DemandLifecycleEvent[];
  postFleetReady: PostFleetReadyLifecycle | null;
  operationConnection: OperationConnectionDiagnostic;
}

interface MutableDemandRecord extends DemandRecord {
  sawReady: boolean;
  previous: DemandSnapshot;
}

interface DemandSnapshot {
  state: AmphibiousCapabilityDemand["state"];
  launchReady: boolean;
  readyAtTick: number | null;
  departurePort: string;
  destinationPort: string;
  route: string[];
  transportIds: string[];
  escortIds: string[];
  landingUnitIds: string[];
  completeFleetLease: boolean;
}

interface DemandLifecycleEvent {
  tick: number;
  state: AmphibiousCapabilityDemand["state"];
  waitingReason: string | null;
}

type PostFleetReadyState = "WaitingOperation" | "WaitingLaunch" | "Launching" | "Transporting" | "Landed" | "Cancelled" | "Expired" | "NeverLaunched";

interface PostFleetReadyTransition { tick: number; state: PostFleetReadyState }

interface PostFleetReadyDuration {
  state: PostFleetReadyState;
  enteredAtTick: number;
  leftAtTick: number;
  durationTicks: number;
}

interface PostFleetReadyLifecycle {
  transitions: PostFleetReadyTransition[];
  stateDurations: PostFleetReadyDuration[];
  finalState: PostFleetReadyState;
  endedFromState: PostFleetReadyState | null;
}

interface OperationConnectionDiagnostic {
  gateEvents: AmphibiousOperationConnectionDiagnostic[];
  failedGateCounts: Record<string, number>;
  representativeFailures: Record<string, AmphibiousOperationConnectionDiagnostic[]>;
}

interface WarRecord {
  warId: string;
  attacker: string;
  defender: string;
  demands: DemandRecord[];
}

type WarTerminationMechanism = "attacker surrendered" | "defender surrendered" | "war ended through nation elimination" | "other";

interface WarOutcome {
  warEndTick: number;
  terminationMechanism: WarTerminationMechanism;
}

interface RunRecord { seed: number; wars: WarRecord[]; warOutcomes: Record<string, WarOutcome> }

const runs: RunRecord[] = [];
const originalInfo = console.info;
console.info = () => undefined;
try {
  for (let seed = FIRST_SEED; seed <= LAST_SEED; seed += 1) runs.push(runSeed(seed));
} finally {
  console.info = originalInfo;
}

await mkdir("diagnostics", { recursive: true });
await writeFile(OUTPUT_PATH, `${JSON.stringify({
  experiment: {
    scenario: SCENARIO,
    seeds: { first: FIRST_SEED, last: LAST_SEED, count: LAST_SEED - FIRST_SEED + 1 },
    resolution: { width: 1_920, height: 1_080 },
    speed: 32,
    fastTicks: FAST_TICKS,
  },
  runs,
  operationConnectionSummary: summarizeOperationConnection(runs),
  launchFeasibilitySummary: summarizeLaunchFeasibility(runs),
}, null, 2)}\n`, "utf8");
console.log(`Fleet-ready diagnostic complete: ${OUTPUT_PATH}`);

function runSeed(seed: number): RunRecord {
  const world = createScenarioWorld(SCENARIO, {
    seed, width: 1_920, height: 1_080, quick: false,
    reserveEnabled: true, reorganizationEnabled: true, exploitationEnabled: true,
    pocketReductionEnabled: true,
  });
  const records = new Map<string, MutableDemandRecord>();
  const wars = new Map<string, WarRecord>();
  const knownWars = new Map<string, WarState>();
  const warOutcomes = new Map<string, WarOutcome>();
  let priorNationSnapshots = snapshotNations(world);
  observeWarOutcomes(world, knownWars, warOutcomes, priorNationSnapshots);
  const pendingConnectionEvents = new Map<string, AmphibiousOperationConnectionDiagnostic[]>();
  setAmphibiousDiagnosticObserver({ onOperationConnection(event) {
    const record = records.get(event.demandId);
    if (record) recordOperationConnectionEvent(record.operationConnection, event);
    else {
      const pending = pendingConnectionEvents.get(event.demandId) ?? [];
      pending.push(event);
      pendingConnectionEvents.set(event.demandId, pending);
    }
  } });
  try {
    for (let index = 0; index < FAST_TICKS; index += 1) {
      stepFastTick(world, FAST_TICK_MS);
      observeWarOutcomes(world, knownWars, warOutcomes, priorNationSnapshots);
      priorNationSnapshots = snapshotNations(world);
      observe(world, seed, records, wars, pendingConnectionEvents);
      const dueSlowTicks = Math.floor(world.time.elapsedMs / SLOW_TICK_MS);
      while (world.time.slowTick < dueSlowTicks) {
        stepSlowTick(world, SLOW_TICK_MS);
        observeWarOutcomes(world, knownWars, warOutcomes, priorNationSnapshots);
        priorNationSnapshots = snapshotNations(world);
        observe(world, seed, records, wars, pendingConnectionEvents);
      }
    }
  } finally {
    setAmphibiousDiagnosticObserver(null);
  }
  for (const record of records.values()) finalize(world, record);
  for (const record of records.values()) {
    const war = wars.get(record.warId);
    if (war) war.demands.push(stripMutable(record));
  }
  for (const war of wars.values()) war.demands.sort((a, b) => a.creationTick - b.creationTick || a.demandId.localeCompare(b.demandId));
  return {
    seed, wars: [...wars.values()].sort((a, b) => a.warId.localeCompare(b.warId)),
    warOutcomes: Object.fromEntries(warOutcomes),
  };
}

interface NationSnapshot { macroRegionCount: number }

function snapshotNations(world: WorldState): Map<string, NationSnapshot> {
  return new Map(world.nations.map((nation) => [nation.id, { macroRegionCount: nation.macroRegionIds.length }]));
}

function observeWarOutcomes(
  world: WorldState, knownWars: Map<string, WarState>, outcomes: Map<string, WarOutcome>, priorNations: Map<string, NationSnapshot>,
): void {
  const activeWarIds = new Set<string>(world.wars.map((war) => war.id));
  for (const [warId, war] of knownWars) {
    if (activeWarIds.has(warId) || outcomes.has(warId)) continue;
    const attackerLostAllTerritory = (priorNations.get(war.aggressorId)?.macroRegionCount ?? 0) > 0 &&
      (world.nations.find((nation) => nation.id === war.aggressorId)?.macroRegionIds.length ?? 0) === 0;
    const defenderLostAllTerritory = (priorNations.get(war.defenderId)?.macroRegionCount ?? 0) > 0 &&
      (world.nations.find((nation) => nation.id === war.defenderId)?.macroRegionIds.length ?? 0) === 0;
    outcomes.set(warId, {
      warEndTick: world.time.fastTick,
      terminationMechanism: attackerLostAllTerritory ? "attacker surrendered"
        : defenderLostAllTerritory ? "defender surrendered"
        : "other",
    });
  }
  for (const war of world.wars) knownWars.set(war.id, { ...war, contributionByNationId: new Map(war.contributionByNationId) });
}

function observe(
  world: WorldState, seed: number, records: Map<string, MutableDemandRecord>, wars: Map<string, WarRecord>,
  pendingConnectionEvents: Map<string, AmphibiousOperationConnectionDiagnostic[]>,
): void {
  for (const demand of world.amphibiousOperations.capabilityDemands) {
    const current = snapshot(demand);
    let record = records.get(demand.id);
    if (!record) {
      const war = findDemandWar(world, demand);
      if (!war) continue;
      record = createRecord(world, seed, demand, current, war);
      records.set(demand.id, record);
      for (const event of pendingConnectionEvents.get(demand.id) ?? []) recordOperationConnectionEvent(record.operationConnection, event);
      pendingConnectionEvents.delete(demand.id);
      if (!wars.has(war.id)) wars.set(war.id, { warId: war.id, attacker: war.aggressorId, defender: war.defenderId, demands: [] });
    } else if (record.sawReady && readinessWasLost(record.previous, current)) {
      record.readinessEverLostAgain = true;
      record.readinessLost ??= classifyReadinessLoss(record.previous, current);
    }
    const latestEvent = record.lifecycle.at(-1);
    if (!latestEvent || latestEvent.state !== demand.state || latestEvent.waitingReason !== demand.waitingReason) {
      record.lifecycle.push({ tick: world.time.fastTick, state: demand.state, waitingReason: demand.waitingReason });
    }
    record.sawReady ||= current.readyAtTick !== null || current.state === "ready";
    record.fleetReadyTick ??= current.readyAtTick;
    const operation = demand.operationId ? world.amphibiousOperations.operations.find((item) => item.id === demand.operationId) : undefined;
    observePostFleetReady(record, demand, operation, world.time.fastTick);
    record.requiredTransports = demand.desiredTransportCount;
    record.requiredEscorts = demand.desiredEscortCount;
    record.assignedTransports = demand.assignedTransportIds.length;
    record.assignedEscorts = demand.assignedEscortIds.length;
    record.landingStrength = demand.availableLandingStrength;
    record.departurePort = demand.departurePortId;
    record.destinationPort = demand.destinationPortId;
    observeOperation(record, operation);
    if (record.terminationTick === null && (demand.state === "expired" || demand.state === "cancelled")) {
      record.terminationTick = demand.lastValidatedAtTick;
      const terminal = demandTerminalOutcome(world, demand);
      record.finalOutcome = terminal.outcome;
      record.finalOutcomeReason = terminal.reason;
    }
    record.previous = current;
  }
}

function createRecord(world: WorldState, seed: number, demand: AmphibiousCapabilityDemand, previous: DemandSnapshot, war: WarState): MutableDemandRecord {
  const target = world.amphibiousOperations.fleetReadinessTargets.find((item) =>
    item.nationId === demand.nationId && item.enemyNationId === demand.enemyNationId && item.departurePortId === demand.departurePortId);
  return {
    demandId: demand.id, seed, warId: war.id, attacker: war.aggressorId, defender: war.defenderId,
    creationTick: demand.createdAtTick, fleetTargetTick: target?.lastOpportunityAtTick ?? null,
    fleetReadyTick: demand.readyAtTick, launchTick: null, landingTick: null, beachheadTick: null,
    terminationTick: null, requiredTransports: demand.desiredTransportCount, requiredEscorts: demand.desiredEscortCount,
    assignedTransports: demand.assignedTransportIds.length, assignedEscorts: demand.assignedEscortIds.length,
    landingStrength: demand.availableLandingStrength, departurePort: demand.departurePortId,
    destinationPort: demand.destinationPortId, finalOutcome: "other", finalOutcomeReason: null,
    readinessEverLostAgain: false, readinessLost: null, sawReady: previous.readyAtTick !== null || previous.state === "ready", previous,
    lifecycle: [{ tick: demand.createdAtTick, state: demand.state, waitingReason: demand.waitingReason }],
    operationConnection: { gateEvents: [], failedGateCounts: {}, representativeFailures: {} },
    postFleetReady: demand.readyAtTick === null ? null : {
      transitions: [{ tick: demand.readyAtTick, state: "WaitingOperation" }], stateDurations: [],
      finalState: "WaitingOperation", endedFromState: null,
    },
  };
}

function recordOperationConnectionEvent(
  diagnostic: OperationConnectionDiagnostic, event: AmphibiousOperationConnectionDiagnostic,
): void {
  diagnostic.gateEvents.push(event);
  for (const gate of event.failedGates) {
    diagnostic.failedGateCounts[gate] = (diagnostic.failedGateCounts[gate] ?? 0) + 1;
    const examples = diagnostic.representativeFailures[gate] ?? [];
    if (examples.length < 3) examples.push(event);
    diagnostic.representativeFailures[gate] = examples;
  }
}

function summarizeOperationConnection(runs: readonly RunRecord[]): {
  waitingOperationDemandCount: number;
  failedGateCounts: Record<string, number>;
  representativeExamples: Record<string, Array<{ seed: number; warId: string; demandId: string; event: AmphibiousOperationConnectionDiagnostic }>>;
} {
  const failedGateCounts: Record<string, number> = {};
  const representativeExamples: Record<string, Array<{ seed: number; warId: string; demandId: string; event: AmphibiousOperationConnectionDiagnostic }>> = {};
  let waitingOperationDemandCount = 0;
  for (const run of runs) for (const war of run.wars) for (const demand of war.demands) {
    if (demand.postFleetReady?.transitions[0]?.state !== "WaitingOperation") continue;
    waitingOperationDemandCount += 1;
    for (const event of demand.operationConnection.gateEvents) for (const gate of event.failedGates) {
      failedGateCounts[gate] = (failedGateCounts[gate] ?? 0) + 1;
      const examples = representativeExamples[gate] ?? [];
      if (examples.length < 3) examples.push({ seed: run.seed, warId: war.warId, demandId: demand.demandId, event });
      representativeExamples[gate] = examples;
    }
  }
  return { waitingOperationDemandCount, failedGateCounts, representativeExamples };
}

interface FeasibilityRejectionSample {
  seed: number;
  warId: string;
  demandId: string;
  tick: number;
  feasibility: AmphibiousLaunchFeasibilityDiagnostic;
}

interface WarLifetimeValidationRecord extends FeasibilityRejectionSample {
  attacker: string;
  defender: string;
  predictedWindowTicks: number;
  estimatedCompletionTicks: number;
  safetyMarginTicks: number;
  routeSegmentCount: number;
  estimatedVoyageTicks: number;
  enemySurrenderScore: number | null;
  warAgeTicks: number | null;
  strategicProgressScore: number | null;
  activeLandOffensiveCount: number | null;
  enemyCapitalThreat: string | null;
  ownCapitalThreat: string | null;
  reasonFlags: string[];
  warEndTick: number | null;
  actualRemainingWarTicks: number | null;
  rightCensored: boolean;
  terminationMechanism: WarTerminationMechanism | null;
  windowErrorTicks: number | null;
  absoluteWindowErrorTicks: number | null;
  windowRatio: number | null;
  actualCompletionFeasible: boolean | null;
  predictedCompletionFeasible: boolean;
  predictionQuality: "highly pessimistic" | "moderately pessimistic" | "accurate" | "moderately optimistic" | "highly optimistic" | null;
  capContributionStage: string;
}

function summarizeLaunchFeasibility(runs: readonly RunRecord[]): {
  rejectionCount: number;
  demandCount: number;
  distributions: Record<string, NumericDistribution>;
  reasonFlagCounts: Record<string, number>;
  repeatPatterns: FeasibilityRepeatPatterns;
  representativeExamples: FeasibilityRejectionSample[];
  actualWarLifetimeValidation: ReturnType<typeof summarizeActualWarLifetime>;
} {
  const samples: FeasibilityRejectionSample[] = [];
  const lifetimeRecords: WarLifetimeValidationRecord[] = [];
  for (const run of runs) for (const war of run.wars) for (const demand of war.demands) {
    for (const event of demand.operationConnection.gateEvents) {
      const feasibility = event.launchFeasibility;
      if (feasibility?.reason !== "insufficient-strategic-window") continue;
      const sample = { seed: run.seed, warId: war.warId, demandId: demand.demandId, tick: event.tick, feasibility };
      samples.push(sample);
      lifetimeRecords.push(createWarLifetimeValidationRecord(sample, demand, run.warOutcomes[war.warId]));
    }
  }
  const reasonFlagCounts: Record<string, number> = {};
  for (const sample of samples) for (const flag of sample.feasibility.reasonFlags) {
    reasonFlagCounts[flag] = (reasonFlagCounts[flag] ?? 0) + 1;
  }
  return {
    rejectionCount: samples.length,
    demandCount: new Set(samples.map((sample) => `${sample.seed}:${sample.demandId}`)).size,
    distributions: {
      estimatedAssemblyTicks: distribution(samples.map((sample) => sample.feasibility.estimatedAssemblyTicks)),
      estimatedTransportDelayTicks: distribution(samples.map((sample) => sample.feasibility.estimatedTransportDelayTicks)),
      estimatedEscortDelayTicks: distribution(samples.map((sample) => sample.feasibility.estimatedEscortDelayTicks)),
      estimatedEmbarkationTicks: distribution(samples.map((sample) => sample.feasibility.estimatedEmbarkationTicks)),
      estimatedVoyageTicks: distribution(samples.map((sample) => sample.feasibility.estimatedVoyageTicks)),
      estimatedLandingTicks: distribution(samples.map((sample) => sample.feasibility.estimatedLandingTicks)),
      estimatedLaunchTicks: distribution(samples.map((sample) => sample.feasibility.estimatedLaunchTicks)),
      estimatedCompletionTicks: distribution(samples.map((sample) => sample.feasibility.estimatedCompletionTicks)),
      convoyMoveTicks: distribution(samples.map((sample) => sample.feasibility.convoyMoveTicks)),
      routeSegmentCount: distribution(samples.map((sample) => sample.feasibility.routeSegmentCount)),
      opportunityWindowTicks: distribution(samples.map((sample) => sample.feasibility.opportunityWindowTicks)),
      safetyMarginTicks: distribution(samples.map((sample) => sample.feasibility.safetyMarginTicks)),
      resistanceWindowTicks: distribution(samples.map((sample) => sample.feasibility.opportunityWindow.resistanceWindowTicks)),
      ageWindowTicks: distribution(samples.map((sample) => sample.feasibility.opportunityWindow.ageWindowTicks)),
      afterAgeCapTicks: distribution(samples.map((sample) => sample.feasibility.opportunityWindow.afterAgeCapTicks)),
      afterStrategicProgressTicks: distribution(samples.map((sample) => sample.feasibility.opportunityWindow.afterStrategicProgressTicks)),
      afterActiveLandOffensiveTicks: distribution(samples.map((sample) => sample.feasibility.opportunityWindow.afterActiveLandOffensiveTicks)),
    },
    reasonFlagCounts,
    repeatPatterns: summarizeFeasibilityRepeats(samples),
    representativeExamples: samples.slice(0, 3),
    actualWarLifetimeValidation: summarizeActualWarLifetime(lifetimeRecords),
  };
}

function createWarLifetimeValidationRecord(
  sample: FeasibilityRejectionSample, demand: DemandRecord, outcome: WarOutcome | undefined,
): WarLifetimeValidationRecord {
  const feasibility = sample.feasibility;
  const actualRemainingWarTicks = outcome ? Math.max(0, outcome.warEndTick - sample.tick) : null;
  const resolved = actualRemainingWarTicks !== null;
  const windowErrorTicks = resolved ? feasibility.opportunityWindowTicks - actualRemainingWarTicks : null;
  const windowRatio = resolved && actualRemainingWarTicks > 0 ? feasibility.opportunityWindowTicks / actualRemainingWarTicks : null;
  return {
    ...sample, attacker: demand.attacker, defender: demand.defender, predictedWindowTicks: feasibility.opportunityWindowTicks,
    estimatedCompletionTicks: feasibility.estimatedCompletionTicks, safetyMarginTicks: feasibility.safetyMarginTicks,
    routeSegmentCount: feasibility.routeSegmentCount, estimatedVoyageTicks: feasibility.estimatedVoyageTicks,
    enemySurrenderScore: feasibility.opportunityWindow.enemySurrenderScore,
    warAgeTicks: feasibility.opportunityWindow.warAgeTicks, strategicProgressScore: feasibility.opportunityWindow.strategicProgressScore,
    activeLandOffensiveCount: feasibility.opportunityWindow.activeLandOffensiveCount,
    enemyCapitalThreat: feasibility.opportunityWindow.enemyCapitalThreat, ownCapitalThreat: feasibility.opportunityWindow.ownCapitalThreat,
    reasonFlags: [...feasibility.reasonFlags], warEndTick: outcome?.warEndTick ?? null, actualRemainingWarTicks,
    rightCensored: !resolved, terminationMechanism: outcome?.terminationMechanism ?? null,
    windowErrorTicks, absoluteWindowErrorTicks: windowErrorTicks === null ? null : Math.abs(windowErrorTicks), windowRatio,
    actualCompletionFeasible: resolved ? actualRemainingWarTicks >= feasibility.estimatedCompletionTicks : null,
    predictedCompletionFeasible: feasibility.opportunityWindowTicks >= feasibility.estimatedCompletionTicks,
    predictionQuality: windowRatio === null ? null : classifyPredictionQuality(windowRatio),
    capContributionStage: capContributionStage(feasibility),
  };
}

function classifyPredictionQuality(ratio: number): NonNullable<WarLifetimeValidationRecord["predictionQuality"]> {
  if (ratio < 0.5) return "highly pessimistic";
  if (ratio < 0.8) return "moderately pessimistic";
  if (ratio <= 1.25) return "accurate";
  if (ratio <= 1.5) return "moderately optimistic";
  return "highly optimistic";
}

function capContributionStage(feasibility: AmphibiousLaunchFeasibilityDiagnostic): string {
  const window = feasibility.opportunityWindow;
  const required = feasibility.estimatedCompletionTicks;
  const stages: Array<[string, number | null, number | null]> = [
    ["age-cap", window.resistanceWindowTicks, window.afterAgeCapTicks],
    ["strategic-progress", window.afterAgeCapTicks, window.afterStrategicProgressTicks],
    ["active-land-offensive", window.afterStrategicProgressTicks, window.afterActiveLandOffensiveTicks],
    [`enemy-capital-${window.enemyCapitalThreat ?? "none"}-cap`, window.afterActiveLandOffensiveTicks, window.afterEnemyCapitalCapTicks],
    [`own-capital-${window.ownCapitalThreat ?? "none"}-cap`, window.afterEnemyCapitalCapTicks, window.afterOwnCapitalCapTicks],
  ];
  for (const [stage, before, after] of stages) if (before !== null && after !== null && before >= required && after < required) return stage;
  return "no-single-stage-crossing";
}

function summarizeActualWarLifetime(records: readonly WarLifetimeValidationRecord[]): {
  resolvedEvaluationCount: number;
  rightCensoredEvaluationCount: number;
  resolvedDemandCount: number;
  rightCensoredDemandCount: number;
  forecastDistributions: { evaluationLevel: Record<string, NumericDistribution>; uniqueDemandLevel: Record<string, NumericDistribution> };
  correctRejectionCount: number;
  falseRejectionCount: number;
  correctRejectionRate: number | null;
  falseRejectionRate: number | null;
  predictionQualityThresholds: typeof PREDICTION_QUALITY_THRESHOLDS;
  predictionQualityCounts: Record<string, number>;
  capitalThreatGroups: Record<string, ThreatGroupSummary>;
  capContributionCounts: Record<string, number>;
  representativeFalseRejections: WarLifetimeValidationRecord[];
  representativeCorrectRejections: WarLifetimeValidationRecord[];
  evaluationRecords: readonly WarLifetimeValidationRecord[];
} {
  const resolved = records.filter((record) => !record.rightCensored);
  const firstByDemand = new Map<string, WarLifetimeValidationRecord>();
  for (const record of records) {
    const key = `${record.seed}:${record.demandId}`;
    const existing = firstByDemand.get(key);
    if (!existing || record.tick < existing.tick) firstByDemand.set(key, record);
  }
  const unique = [...firstByDemand.values()];
  const resolvedUnique = unique.filter((record) => !record.rightCensored);
  const correct = resolved.filter((record) => record.actualCompletionFeasible === false);
  const falseRejections = resolved.filter((record) => record.actualCompletionFeasible === true);
  const predictionQualityCounts: Record<string, number> = {};
  const capContributionCounts: Record<string, number> = {};
  for (const record of resolved) {
    if (record.predictionQuality) predictionQualityCounts[record.predictionQuality] = (predictionQualityCounts[record.predictionQuality] ?? 0) + 1;
    capContributionCounts[record.capContributionStage] = (capContributionCounts[record.capContributionStage] ?? 0) + 1;
  }
  return {
    resolvedEvaluationCount: resolved.length, rightCensoredEvaluationCount: records.length - resolved.length,
    resolvedDemandCount: resolvedUnique.length, rightCensoredDemandCount: unique.length - resolvedUnique.length,
    forecastDistributions: { evaluationLevel: forecastDistributions(resolved), uniqueDemandLevel: forecastDistributions(resolvedUnique) },
    correctRejectionCount: correct.length, falseRejectionCount: falseRejections.length,
    correctRejectionRate: resolved.length ? correct.length / resolved.length : null,
    falseRejectionRate: resolved.length ? falseRejections.length / resolved.length : null,
    predictionQualityThresholds: PREDICTION_QUALITY_THRESHOLDS, predictionQualityCounts,
    capitalThreatGroups: summarizeThreatGroups(resolved), capContributionCounts,
    representativeFalseRejections: falseRejections.slice(0, 3), representativeCorrectRejections: correct.slice(0, 3),
    evaluationRecords: records,
  };
}

function forecastDistributions(records: readonly WarLifetimeValidationRecord[]): Record<string, NumericDistribution> {
  return {
    predictedWindowTicks: distribution(records.map((record) => record.predictedWindowTicks)),
    actualRemainingWarTicks: distribution(records.map((record) => record.actualRemainingWarTicks)),
    windowErrorTicks: distribution(records.map((record) => record.windowErrorTicks)),
    absoluteWindowErrorTicks: distribution(records.map((record) => record.absoluteWindowErrorTicks)),
    windowRatio: distribution(records.map((record) => record.windowRatio)),
    estimatedCompletionTicks: distribution(records.map((record) => record.estimatedCompletionTicks)),
    safetyMarginTicks: distribution(records.map((record) => record.safetyMarginTicks)),
  };
}

interface ThreatGroupSummary { count: number; correctRejectionCount: number; falseRejectionCount: number; correctRejectionRate: number | null }

function summarizeThreatGroups(records: readonly WarLifetimeValidationRecord[]): Record<string, ThreatGroupSummary> {
  const groups = new Map<string, WarLifetimeValidationRecord[]>();
  for (const record of records) {
    const enemy = record.enemyCapitalThreat ?? "none";
    const own = record.ownCapitalThreat ?? "none";
    const labels = [`enemy:${enemy}`, `own:${own}`, `enemy:${enemy}|own:${own}`];
    if (enemy === "none" && own === "none") labels.push("no-capital-threat");
    if (enemy !== "none" && own === "none") labels.push(`enemy-${enemy}-only`);
    if (enemy === "none" && own !== "none") labels.push(`own-${own}-only`);
    if (enemy !== "none" && own !== "none") labels.push("both-sides-threatened-or-critical");
    for (const label of labels) groups.set(label, [...(groups.get(label) ?? []), record]);
  }
  return Object.fromEntries([...groups].map(([label, grouped]) => {
    const correct = grouped.filter((record) => record.actualCompletionFeasible === false).length;
    const falseRejections = grouped.filter((record) => record.actualCompletionFeasible === true).length;
    return [label, { count: grouped.length, correctRejectionCount: correct, falseRejectionCount: falseRejections,
      correctRejectionRate: grouped.length ? correct / grouped.length : null }];
  }));
}

interface NumericDistribution { count: number; mean: number | null; median: number | null; p90: number | null; p95: number | null; min: number | null; max: number | null }

function distribution(values: readonly (number | null)[]): NumericDistribution {
  const sorted = values.filter((value): value is number => value !== null && Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return { count: 0, mean: null, median: null, p90: null, p95: null, min: null, max: null };
  const percentile = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
  return {
    count: sorted.length, mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    median: percentile(0.5), p90: percentile(0.9), p95: percentile(0.95), min: sorted[0]!, max: sorted.at(-1)!,
  };
}

interface FeasibilityRepeatPatterns {
  demandsWithRejections: number;
  demandsWithSuccessiveRejections: number;
  successiveRejectionPairs: number;
  sameReasonAndTimeEstimatePairs: number;
  sameFullDecisionPairs: number;
  representativeRepeatedDemands: Array<{ seed: number; warId: string; demandId: string; rejectionCount: number; sameReasonAndTimeEstimatePairs: number; sameFullDecisionPairs: number }>;
}

function summarizeFeasibilityRepeats(samples: readonly FeasibilityRejectionSample[]): FeasibilityRepeatPatterns {
  const byDemand = new Map<string, FeasibilityRejectionSample[]>();
  for (const sample of samples) {
    const key = `${sample.seed}:${sample.warId}:${sample.demandId}`;
    const list = byDemand.get(key) ?? [];
    list.push(sample);
    byDemand.set(key, list);
  }
  let demandsWithSuccessiveRejections = 0;
  let successiveRejectionPairs = 0;
  let sameReasonAndTimeEstimatePairs = 0;
  let sameFullDecisionPairs = 0;
  const repeated: FeasibilityRepeatPatterns["representativeRepeatedDemands"] = [];
  for (const samplesForDemand of byDemand.values()) {
    samplesForDemand.sort((a, b) => a.tick - b.tick);
    let sameTimePairs = 0;
    let sameFullPairs = 0;
    for (let index = 1; index < samplesForDemand.length; index += 1) {
      successiveRejectionPairs += 1;
      const prior = samplesForDemand[index - 1]!.feasibility;
      const current = samplesForDemand[index]!.feasibility;
      const sameTime = prior.reason === current.reason && prior.estimatedCompletionTicks === current.estimatedCompletionTicks &&
        prior.estimatedLaunchTicks === current.estimatedLaunchTicks && prior.estimatedVoyageTicks === current.estimatedVoyageTicks;
      if (sameTime) { sameReasonAndTimeEstimatePairs += 1; sameTimePairs += 1; }
      if (sameTime && prior.opportunityWindowTicks === current.opportunityWindowTicks && prior.safetyMarginTicks === current.safetyMarginTicks &&
        prior.reasonFlags.join("|") === current.reasonFlags.join("|")) { sameFullDecisionPairs += 1; sameFullPairs += 1; }
    }
    if (samplesForDemand.length > 1) demandsWithSuccessiveRejections += 1;
    if (sameTimePairs > 0 || sameFullPairs > 0) {
      const first = samplesForDemand[0]!;
      if (repeated.length < 10) repeated.push({ seed: first.seed, warId: first.warId, demandId: first.demandId,
        rejectionCount: samplesForDemand.length, sameReasonAndTimeEstimatePairs: sameTimePairs, sameFullDecisionPairs: sameFullPairs });
    }
  }
  return { demandsWithRejections: byDemand.size, demandsWithSuccessiveRejections, successiveRejectionPairs,
    sameReasonAndTimeEstimatePairs, sameFullDecisionPairs, representativeRepeatedDemands: repeated };
}

function observeOperation(record: MutableDemandRecord, operation: AmphibiousOperation | undefined): void {
  if (!operation) return;
  record.fleetReadyTick ??= operation.fleetReadyAtTick;
  record.launchTick ??= operation.launchedAtTick;
  if (operation.phase === "landed") record.landingTick ??= operation.completedAtTick;
  record.beachheadTick ??= operation.beachheadEvaluatedAtTick;
  if (operation.launchedAtTick !== null) {
    record.terminationTick ??= operation.launchedAtTick;
    record.finalOutcome = "launched";
    record.finalOutcomeReason = null;
  } else if (operation.phase === "cancelled") {
    record.terminationTick ??= operation.completedAtTick;
    const terminal = operationTerminalOutcome(operation);
    record.finalOutcome = terminal.outcome;
    record.finalOutcomeReason = terminal.reason;
  }
}

function finalize(world: WorldState, record: MutableDemandRecord): void {
  if (record.terminationTick === null) {
    record.terminationTick = world.time.fastTick;
    record.finalOutcome = "never launched";
    record.finalOutcomeReason = "experiment ended before the demand reached a terminal state";
    closePostFleetReadyLifecycle(record, world.time.fastTick, "NeverLaunched");
    return;
  }
  const currentState = record.postFleetReady?.transitions.at(-1)?.state;
  if (currentState) closePostFleetReadyLifecycle(record, world.time.fastTick, currentState);
}

function observePostFleetReady(
  record: MutableDemandRecord, demand: AmphibiousCapabilityDemand, operation: AmphibiousOperation | undefined, tick: number,
): void {
  if (record.postFleetReady === null && demand.readyAtTick !== null) {
    record.postFleetReady = {
      transitions: [{ tick: demand.readyAtTick, state: "WaitingOperation" }], stateDurations: [],
      finalState: "WaitingOperation", endedFromState: null,
    };
  }
  const lifecycle = record.postFleetReady;
  if (!lifecycle) return;
  if (operation?.launchedAtTick === tick) appendPostFleetReadyState(lifecycle, tick, "Launching");
  const state = operation ? operationState(operation) : demand.state === "expired" ? "Expired"
    : demand.state === "cancelled" ? "Cancelled" : "WaitingOperation";
  appendPostFleetReadyState(lifecycle, tick, state);
  if (state === "Cancelled" || state === "Expired" || state === "Landed") {
    closePostFleetReadyLifecycle(record, tick, state);
  }
}

function operationState(operation: AmphibiousOperation): PostFleetReadyState {
  if (operation.phase === "cancelled") return "Cancelled";
  if (operation.phase === "landed") return "Landed";
  if (operation.phase === "transporting") return "Transporting";
  return "WaitingLaunch";
}

function appendPostFleetReadyState(lifecycle: PostFleetReadyLifecycle, tick: number, state: PostFleetReadyState): void {
  if (lifecycle.stateDurations.length > 0) return;
  const previous = lifecycle.transitions.at(-1);
  if (!previous || previous.state === state) return;
  lifecycle.transitions.push({ tick, state });
}

function closePostFleetReadyLifecycle(record: MutableDemandRecord, tick: number, finalState: PostFleetReadyState): void {
  const lifecycle = record.postFleetReady;
  if (!lifecycle || lifecycle.stateDurations.length > 0) return;
  appendPostFleetReadyState(lifecycle, tick, finalState);
  lifecycle.finalState = finalState;
  lifecycle.endedFromState = lifecycle.transitions.length > 1 ? lifecycle.transitions.at(-2)!.state : null;
  lifecycle.stateDurations = lifecycle.transitions.map((transition, index) => {
    const leftAtTick = lifecycle.transitions[index + 1]?.tick ?? tick;
    return { state: transition.state, enteredAtTick: transition.tick, leftAtTick,
      durationTicks: Math.max(0, leftAtTick - transition.tick) };
  });
}

function snapshot(demand: AmphibiousCapabilityDemand): DemandSnapshot {
  return {
    state: demand.state, launchReady: demand.launchReady, readyAtTick: demand.readyAtTick,
    departurePort: demand.departurePortId, destinationPort: demand.destinationPortId, route: [...demand.routeRegionIds],
    transportIds: [...demand.assignedTransportIds], escortIds: [...demand.assignedEscortIds],
    landingUnitIds: [...demand.assignedLandingUnitIds],
    completeFleetLease: demand.assignedTransportIds.length === demand.desiredTransportCount && demand.assignedEscortIds.length === demand.desiredEscortCount,
  };
}

function readinessWasLost(before: DemandSnapshot, after: DemandSnapshot): boolean {
  return before.readyAtTick !== null && after.readyAtTick === null ||
    before.launchReady && !after.launchReady || before.state === "ready" && after.state !== "ready";
}

function classifyReadinessLoss(before: DemandSnapshot, after: DemandSnapshot): ReadinessLoss {
  const transportRemoved = removed(before.transportIds, after.transportIds);
  const escortRemoved = removed(before.escortIds, after.escortIds);
  const landForceRemoved = removed(before.landingUnitIds, after.landingUnitIds);
  const routeInvalid = !same(before.route, after.route);
  const portChanged = before.departurePort !== after.departurePort || before.destinationPort !== after.destinationPort;
  const leaseRevoked = before.completeFleetLease && !after.completeFleetLease;
  return { transportRemoved, escortRemoved, landForceRemoved, routeInvalid, portChanged, leaseRevoked,
    other: !transportRemoved && !escortRemoved && !landForceRemoved && !routeInvalid && !portChanged && !leaseRevoked };
}

function demandTerminalOutcome(world: WorldState, demand: AmphibiousCapabilityDemand): { outcome: FinalOutcome; reason: string | null } {
  if (!findDemandWar(world, demand)) return { outcome: "war ended", reason: demand.waitingReason };
  if (!isEffectivelyControlledPort(world, demand.nationId, demand.departurePortId)) return { outcome: "departure port lost", reason: demand.waitingReason };
  const meso = getMesoById(world).get(demand.destinationPortId);
  if (meso?.building !== "port" || getOwnerByMesoId(world).get(demand.destinationPortId) !== demand.enemyNationId)
    return { outcome: "destination invalid", reason: demand.waitingReason };
  if (!routeIsValid(world, demand)) return { outcome: "route invalid", reason: demand.waitingReason };
  return { outcome: demand.state === "expired" ? "opportunity disappeared" : "cancelled", reason: demand.waitingReason };
}

function operationTerminalOutcome(operation: AmphibiousOperation): { outcome: FinalOutcome; reason: string | null } {
  const reason = operation.cancellationReason;
  const outcomes: Partial<Record<NonNullable<typeof reason>, FinalOutcome>> = {
    "transport-lost": "transport lost", "escort-lost": "escort lost", "convoy-lost": "transport lost",
    "departure-port-lost": "departure port lost", "target-invalid": "destination invalid",
    "route-invalid": "route invalid", "war-ended": "war ended", "preparation-timeout": "expired",
  };
  return { outcome: reason ? outcomes[reason] ?? "cancelled" : "other", reason };
}

function findDemandWar(world: WorldState, demand: AmphibiousCapabilityDemand): WarState | undefined {
  return world.wars.find((war) => (war.nationAId === demand.nationId && war.nationBId === demand.enemyNationId) ||
    (war.nationBId === demand.nationId && war.nationAId === demand.enemyNationId));
}

function routeIsValid(world: WorldState, demand: AmphibiousCapabilityDemand): boolean {
  const route = demand.routeRegionIds;
  if (route.length < 2 || route[0] !== demand.departurePortId || route.at(-1) !== demand.destinationPortId) return false;
  const neighbors = getNeighborsById(world);
  return route.slice(1).every((regionId, index) => (neighbors.get(route[index]!) ?? []).includes(regionId));
}

function removed(before: readonly string[], after: readonly string[]): boolean { return before.some((id) => !after.includes(id)); }
function same(a: readonly string[], b: readonly string[]): boolean { return a.length === b.length && a.every((value, index) => value === b[index]); }
function stripMutable({ sawReady: _sawReady, previous: _previous, ...record }: MutableDemandRecord): DemandRecord { return record; }
