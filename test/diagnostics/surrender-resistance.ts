import { mkdir, writeFile } from "node:fs/promises";
import { WORLD_BALANCE } from "../../src/data/balance";
import { getCapitalDefenseAssessment } from "../../src/sim/capital-defense";
import { getStrategicProgressAssessment } from "../../src/sim/strategic-progress";
import { FAST_TICK_MS, SLOW_TICK_MS } from "../../src/sim/time";
import { stepFastTick, stepSlowTick } from "../../src/sim/update";
import type { WarState } from "../../src/sim/war-state";
import type { WorldState } from "../../src/sim/world-state";
import { createScenarioWorld } from "../scenarios";

const FIRST_SEED = 822_748_319_788;
const DEFAULT_SEED_COUNT = 30;
const SEED_COUNT = Number(process.env.SURRENDER_RESISTANCE_SEED_COUNT ?? DEFAULT_SEED_COUNT);
const FAST_TICKS = 3_200;
const OUTPUT_PATH = "diagnostics/surrender-resistance-report.json";
const BUCKETS = Array.from({ length: 10 }, (_, index) => index);

type TerminationMechanism = "attacker surrendered" | "defender surrendered" | "war ended through nation elimination" | "other";

interface WarInstance {
  warInstanceId: string;
  seed: number;
  warId: string;
  creationTick: number;
  endTick: number | null;
  attacker: string;
  defender: string;
  terminationMechanism: TerminationMechanism | null;
}

interface Observation {
  seed: number;
  observationFastTick: number;
  observationSlowTick: number;
  warInstanceId: string;
  warId: string;
  warCreationTick: number;
  attacker: string;
  defender: string;
  resistanceNationId: string;
  surrenderThreshold: number;
  surrenderScore: number;
  surrenderScoreRatio: number;
  surrenderResistance: number;
  currentResistanceWindowTicks: number;
  warAgeTicks: number;
  strategicProgressScore: number | null;
  attackerCapitalThreat: string | null;
  defenderCapitalThreat: string | null;
  activeLandOffensiveCount: number;
  warEndTick: number | null;
  terminationMechanism: TerminationMechanism | null;
  actualRemainingWarTicks: number | null;
  rightCensored: boolean;
  attributionValid: boolean;
  attributionInvalidReason: string | null;
}

interface AttributionCounters {
  observationsBeforeWarCreation: number;
  observationsAfterWarEnd: number;
  negativeRemainingWarValues: number;
  ambiguousMatches: number;
  unmatchedObservations: number;
  reusedWarIdLifetimeCount: number;
  validObservations: number;
}

interface Distribution {
  count: number;
  mean: number | null;
  median: number | null;
  p10: number | null;
  p25: number | null;
  p75: number | null;
  p90: number | null;
  p95: number | null;
  min: number | null;
  max: number | null;
}

interface BucketCalibration {
  bucket: string;
  lowerInclusive: number;
  upperExclusive: number;
  resolvedObservationCount: number;
  resolvedUniqueWarInstanceCount: number;
  actualRemainingWarTicks: Distribution;
  rightCensoredObservationCount: number;
  rightCensoredUniqueWarInstanceCount: number;
}

interface CandidateMetrics {
  coverage: number;
  evaluatedObservationCount: number;
  meanError: number | null;
  medianError: number | null;
  meanAbsoluteError: number | null;
  rmse: number | null;
  overpredictionRate: number | null;
  severeOverprediction250Rate: number | null;
  severeOverprediction500Rate: number | null;
}

const originalInfo = console.info;
console.info = () => undefined;
const instances: WarInstance[] = [];
const observations: Observation[] = [];
try {
  for (let index = 0; index < SEED_COUNT; index += 1) runSeed(FIRST_SEED + index, instances, observations);
} finally {
  console.info = originalInfo;
}

const instancesById = new Map(instances.map((instance) => [instance.warInstanceId, instance]));
const attributionValidation = resolveObservations(observations, instancesById, instances);
const resolved = observations.filter((item) => item.attributionValid && !item.rightCensored && item.actualRemainingWarTicks !== null);
const censored = observations.filter((item) => item.attributionValid && item.rightCensored);
const observationWeightedCalibration = calibrateObservationWeighted(resolved, censored);
const warWeightedCalibration = calibrateWarWeighted(resolved, censored);
const currentFormulaEvaluation = formulaEvaluation(resolved);
const falseSafetyAnalysis = falseSafety(resolved);
const candidateMappings = evaluateCandidates(resolved);

await mkdir("diagnostics", { recursive: true });
await writeFile(OUTPUT_PATH, `${JSON.stringify({
  experiment: {
    scenario: "active-war", seeds: { first: FIRST_SEED, count: SEED_COUNT }, resolution: { width: 1_920, height: 1_080 },
    speed: 32, fastTicks: FAST_TICKS, sampling: { interval: "every slow tick", target: "defender surrender resistance", resistanceFormula: "clamp(1 - surrenderScore / surrenderThreshold, 0, 1)" },
  },
  attributionValidation,
  summary: {
    warInstances: instances.length, resolvedWarInstances: instances.filter((item) => item.endTick !== null).length,
    censoredWarInstances: instances.filter((item) => item.endTick === null).length, observations: observations.length,
    resolvedObservations: resolved.length, rightCensoredObservations: censored.length,
  },
  observationWeightedCalibration,
  warWeightedCalibration: { representativeWithinWarValue: "median actual remaining ticks among that war instance's observations in the bucket", buckets: warWeightedCalibration },
  currentFormulaEvaluation,
  falseSafetyAnalysis,
  candidateMappings,
  representativeCases: representativeCases(resolved),
  observations,
}, null, 2)}\n`, "utf8");
console.log(`Surrender-resistance diagnostic complete: ${OUTPUT_PATH}`);

function runSeed(seed: number, destinationInstances: WarInstance[], destinationObservations: Observation[]): void {
  const world = createScenarioWorld("active-war", { seed, width: 1_920, height: 1_080, quick: false, reserveEnabled: true, reorganizationEnabled: true, exploitationEnabled: true, pocketReductionEnabled: true });
  const registry = new Map<string, WarInstance>();
  let priorTerritory = territoryCounts(world);
  observeInstances(world, seed, registry, priorTerritory);
  for (let tick = 0; tick < FAST_TICKS; tick += 1) {
    stepFastTick(world, FAST_TICK_MS);
    observeInstances(world, seed, registry, priorTerritory);
    priorTerritory = territoryCounts(world);
    const dueSlowTicks = Math.floor(world.time.elapsedMs / SLOW_TICK_MS);
    while (world.time.slowTick < dueSlowTicks) {
      stepSlowTick(world, SLOW_TICK_MS);
      observeInstances(world, seed, registry, priorTerritory);
      priorTerritory = territoryCounts(world);
      sampleActiveWars(world, seed, registry, destinationObservations);
    }
  }
  destinationInstances.push(...registry.values());
}

function sampleActiveWars(world: WorldState, seed: number, registry: Map<string, WarInstance>, destination: Observation[]): void {
  const threshold = Math.max(0.001, WORLD_BALANCE.war.surrender.threshold);
  for (const war of world.wars) {
    const instance = registry.get(instanceKey(seed, war));
    if (!instance) continue;
    const defender = world.nations.find((nation) => nation.id === war.defenderId);
    const score = defender?.surrenderScore ?? 0;
    const resistance = clamp(1 - score / threshold, 0, 1);
    const progress = getStrategicProgressAssessment(world, war.aggressorId, war.defenderId);
    const activeLandOffensiveCount = world.offensiveOperations.operations.filter((operation) => operation.nationId === war.aggressorId && operation.enemyNationId === war.defenderId && operation.outcome === null).length;
    destination.push({
      seed, observationFastTick: world.time.fastTick, observationSlowTick: world.time.slowTick,
      warInstanceId: instance.warInstanceId, warId: war.id, warCreationTick: instance.creationTick, attacker: war.aggressorId, defender: war.defenderId,
      resistanceNationId: war.defenderId, surrenderThreshold: threshold, surrenderScore: score, surrenderScoreRatio: score / threshold,
      surrenderResistance: resistance, currentResistanceWindowTicks: Math.round(120 + resistance * 1080), warAgeTicks: Math.max(0, world.time.fastTick - instance.creationTick),
      strategicProgressScore: progress?.score ?? null, attackerCapitalThreat: getCapitalDefenseAssessment(world, war.aggressorId)?.threatLevel ?? null,
      defenderCapitalThreat: getCapitalDefenseAssessment(world, war.defenderId)?.threatLevel ?? null, activeLandOffensiveCount,
      warEndTick: null, terminationMechanism: null, actualRemainingWarTicks: null, rightCensored: true, attributionValid: true, attributionInvalidReason: null,
    });
  }
}

function observeInstances(world: WorldState, seed: number, registry: Map<string, WarInstance>, priorTerritory: Map<string, number>): void {
  const current = new Set<string>();
  const territory = territoryCounts(world);
  for (const war of world.wars) {
    const key = instanceKey(seed, war);
    current.add(key);
    if (!registry.has(key)) registry.set(key, { warInstanceId: key, seed, warId: war.id, creationTick: war.startedAtFastTick, endTick: null, attacker: war.aggressorId, defender: war.defenderId, terminationMechanism: null });
  }
  for (const instance of registry.values()) {
    if (instance.endTick !== null || current.has(instance.warInstanceId)) continue;
    const attackerGone = (priorTerritory.get(instance.attacker) ?? 0) > 0 && (territory.get(instance.attacker) ?? 0) === 0;
    const defenderGone = (priorTerritory.get(instance.defender) ?? 0) > 0 && (territory.get(instance.defender) ?? 0) === 0;
    instance.endTick = world.time.fastTick;
    instance.terminationMechanism = attackerGone ? "attacker surrendered" : defenderGone ? "defender surrendered" : "other";
  }
}

function resolveObservations(items: Observation[], byId: Map<string, WarInstance>, allInstances: WarInstance[]): AttributionCounters {
  const counters: AttributionCounters = { observationsBeforeWarCreation: 0, observationsAfterWarEnd: 0, negativeRemainingWarValues: 0, ambiguousMatches: 0, unmatchedObservations: 0, reusedWarIdLifetimeCount: reuseCount(allInstances), validObservations: 0 };
  for (const item of items) {
    const instance = byId.get(item.warInstanceId);
    if (!instance) { item.attributionValid = false; item.attributionInvalidReason = "unmatched-war-instance"; counters.unmatchedObservations += 1; continue; }
    if (item.observationFastTick < instance.creationTick) { item.attributionValid = false; item.attributionInvalidReason = "observation-before-war-creation"; counters.observationsBeforeWarCreation += 1; continue; }
    item.warEndTick = instance.endTick; item.terminationMechanism = instance.terminationMechanism;
    if (instance.endTick === null) { counters.validObservations += 1; continue; }
    if (item.observationFastTick > instance.endTick) { item.attributionValid = false; item.attributionInvalidReason = "observation-after-war-end"; counters.observationsAfterWarEnd += 1; continue; }
    const remaining = instance.endTick - item.observationFastTick;
    if (remaining < 0) { item.attributionValid = false; item.attributionInvalidReason = "negative-remaining-war-duration"; counters.negativeRemainingWarValues += 1; continue; }
    item.actualRemainingWarTicks = remaining; item.rightCensored = false; counters.validObservations += 1;
  }
  return counters;
}

function calibrateObservationWeighted(resolved: Observation[], censored: Observation[]): BucketCalibration[] {
  return BUCKETS.map((bucket) => {
    const matching = resolved.filter((item) => bucketFor(item.surrenderResistance) === bucket);
    const censoredMatching = censored.filter((item) => bucketFor(item.surrenderResistance) === bucket);
    return bucketCalibration(bucket, matching.map((item) => item.actualRemainingWarTicks!), matching, censoredMatching);
  });
}

function calibrateWarWeighted(resolved: Observation[], censored: Observation[]): BucketCalibration[] {
  return BUCKETS.map((bucket) => {
    const matching = resolved.filter((item) => bucketFor(item.surrenderResistance) === bucket);
    const perWar = [...groupBy(matching, (item) => item.warInstanceId).values()].map((items) => median(items.map((item) => item.actualRemainingWarTicks!))!);
    const censoredMatching = censored.filter((item) => bucketFor(item.surrenderResistance) === bucket);
    return bucketCalibration(bucket, perWar, matching, censoredMatching, new Set(matching.map((item) => item.warInstanceId)).size);
  });
}

function bucketCalibration(bucket: number, values: number[], resolved: Observation[], censored: Observation[], uniqueWarCount = new Set(resolved.map((item) => item.warInstanceId)).size): BucketCalibration {
  return { bucket: bucketLabel(bucket), lowerInclusive: bucket / 10, upperExclusive: bucket === 9 ? 1 : (bucket + 1) / 10, resolvedObservationCount: resolved.length, resolvedUniqueWarInstanceCount: uniqueWarCount, actualRemainingWarTicks: distribution(values), rightCensoredObservationCount: censored.length, rightCensoredUniqueWarInstanceCount: new Set(censored.map((item) => item.warInstanceId)).size };
}

function formulaEvaluation(resolved: Observation[]): object {
  return { global: errorSummary(resolved), buckets: BUCKETS.map((bucket) => ({ bucket: bucketLabel(bucket), ...errorSummary(resolved.filter((item) => bucketFor(item.surrenderResistance) === bucket)) })) };
}

function falseSafety(resolved: Observation[]): object {
  return { global: safetySummary(resolved), buckets: BUCKETS.map((bucket) => ({ bucket: bucketLabel(bucket), ...safetySummary(resolved.filter((item) => bucketFor(item.surrenderResistance) === bucket)) })) };
}

function errorSummary(items: Observation[]): object {
  const errors = items.map((item) => item.currentResistanceWindowTicks - item.actualRemainingWarTicks!);
  return { resolvedObservationCount: items.length, meanPredictionError: mean(errors), medianPredictionError: median(errors), p90AbsoluteError: percentile(errors.map(Math.abs), 0.9), overpredictionRate: rate(errors, (value) => value > 0), underpredictionRate: rate(errors, (value) => value < 0) };
}

function safetySummary(items: Observation[]): object {
  const errors = items.map((item) => item.currentResistanceWindowTicks - item.actualRemainingWarTicks!);
  return { resolvedObservationCount: items.length, probabilityActualRemainingBelowPredicted: rate(errors, (value) => value > 0), overestimatedByMoreThan100TicksRate: rate(errors, (value) => value > 100), overestimatedByMoreThan250TicksRate: rate(errors, (value) => value > 250), overestimatedByMoreThan500TicksRate: rate(errors, (value) => value > 500), overestimatedByMoreThan750TicksRate: rate(errors, (value) => value > 750) };
}

function evaluateCandidates(resolved: Observation[]): object {
  const byBucket = BUCKETS.map((bucket) => resolved.filter((item) => bucketFor(item.surrenderResistance) === bucket));
  const fitted = linearFit(resolved);
  const definitions = [
    { name: "A-current", description: "round(120 + resistance * 1080)", predict: (item: Observation) => item.currentResistanceWindowTicks },
    { name: "B-fitted-linear", description: `max(0, round(${fitted.intercept} + resistance * ${fitted.slope}))`, predict: (item: Observation) => Math.max(0, Math.round(fitted.intercept + item.surrenderResistance * fitted.slope)) },
  ...["median", "p25", "p10"].map((quantile) => ({ name: quantile === "median" ? "C-empirical-bucket-median" : quantile === "p25" ? "D-empirical-bucket-p25" : "E-empirical-bucket-p10", description: `resolved observation-weighted bucket ${quantile}; no prediction when the bucket has no resolved observations`, predict: (item: Observation) => {
      const values = byBucket[bucketFor(item.surrenderResistance)].map((entry) => entry.actualRemainingWarTicks!);
      return quantile === "median" ? median(values) : quantile === "p25" ? percentile(values, 0.25) : percentile(values, 0.1);
    } })),
  ];
  const mappings = definitions.map((definition) => ({ name: definition.name, description: definition.description, ...candidateMetrics(resolved, definition.predict) }));
  const safestUsefulMapping = [...mappings].filter((item) => item.coverage > 0).sort((a, b) => (a.severeOverprediction250Rate ?? Infinity) - (b.severeOverprediction250Rate ?? Infinity) || b.coverage - a.coverage)[0] ?? null;
  return { fittingPopulation: "resolved observations only; candidate mappings are offline analysis and do not alter simulation", fittedLinearParameters: fitted, mappings, safestUsefulMapping };
}

function candidateMetrics(items: Observation[], predict: (item: Observation) => number | null): CandidateMetrics {
  const predictions = items.map((item) => ({ item, predicted: predict(item) })).filter((item): item is { item: Observation; predicted: number } => item.predicted !== null && Number.isFinite(item.predicted));
  const errors = predictions.map(({ item, predicted }) => predicted - item.actualRemainingWarTicks!);
  return { coverage: items.length ? predictions.length / items.length : 0, evaluatedObservationCount: predictions.length, meanError: mean(errors), medianError: median(errors), meanAbsoluteError: mean(errors.map(Math.abs)), rmse: errors.length ? Math.sqrt(mean(errors.map((value) => value * value))!) : null, overpredictionRate: rate(errors, (value) => value > 0), severeOverprediction250Rate: rate(errors, (value) => value > 250), severeOverprediction500Rate: rate(errors, (value) => value > 500) };
}

function representativeCases(resolved: Observation[]): object {
  const annotated = resolved.map((item) => ({ ...item, predictionError: item.currentResistanceWindowTicks - item.actualRemainingWarTicks! }));
  const byDescending = [...annotated].sort((a, b) => b.predictionError - a.predictionError);
  const byAscending = [...annotated].sort((a, b) => a.predictionError - b.predictionError);
  return { largestOverpredictions: byDescending.slice(0, 10), largestUnderpredictions: byAscending.slice(0, 10), highResistanceShortLived: annotated.filter((item) => item.surrenderResistance >= 0.9).sort((a, b) => a.actualRemainingWarTicks! - b.actualRemainingWarTicks!).slice(0, 10), lowResistanceLongLived: annotated.filter((item) => item.surrenderResistance <= 0.2).sort((a, b) => b.actualRemainingWarTicks! - a.actualRemainingWarTicks!).slice(0, 10) };
}

function linearFit(items: Observation[]): { intercept: number; slope: number } {
  if (!items.length) return { intercept: 0, slope: 0 };
  const xMean = mean(items.map((item) => item.surrenderResistance))!;
  const yMean = mean(items.map((item) => item.actualRemainingWarTicks!))!;
  const denominator = items.reduce((sum, item) => sum + (item.surrenderResistance - xMean) ** 2, 0);
  const slope = denominator ? items.reduce((sum, item) => sum + (item.surrenderResistance - xMean) * (item.actualRemainingWarTicks! - yMean), 0) / denominator : 0;
  return { intercept: round(yMean - slope * xMean), slope: round(slope) };
}

function distribution(values: number[]): Distribution { return { count: values.length, mean: mean(values), median: median(values), p10: percentile(values, 0.1), p25: percentile(values, 0.25), p75: percentile(values, 0.75), p90: percentile(values, 0.9), p95: percentile(values, 0.95), min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null }; }
function mean(values: number[]): number | null { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; }
function median(values: number[]): number | null { return percentile(values, 0.5); }
function percentile(values: number[], quantile: number): number | null { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); const index = (sorted.length - 1) * quantile; const lower = Math.floor(index); const upper = Math.ceil(index); return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower); }
function rate(values: number[], predicate: (value: number) => boolean): number | null { return values.length ? values.filter(predicate).length / values.length : null; }
function round(value: number): number { return Math.round(value * 1_000) / 1_000; }
function bucketFor(resistance: number): number { return Math.min(9, Math.max(0, Math.floor(resistance * 10))); }
function bucketLabel(bucket: number): string { return bucket === 9 ? "[0.9, 1.0]" : `[${(bucket / 10).toFixed(1)}, ${((bucket + 1) / 10).toFixed(1)})`; }
function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> { const result = new Map<string, T[]>(); for (const item of items) { const group = result.get(key(item)) ?? []; group.push(item); result.set(key(item), group); } return result; }
function reuseCount(items: WarInstance[]): number { return [...groupBy(items, (item) => `${item.seed}:${item.warId}`).values()].filter((group) => group.length > 1).length; }
function instanceKey(seed: number, war: WarState): string { return `${seed}:${war.id}:${war.startedAtFastTick}:${war.aggressorId}:${war.defenderId}`; }
function territoryCounts(world: WorldState): Map<string, number> { const counts = new Map<string, number>(); for (const macro of world.macroRegions) counts.set(macro.nationId, (counts.get(macro.nationId) ?? 0) + 1); return counts; }
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
