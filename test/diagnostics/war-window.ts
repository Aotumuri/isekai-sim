import { mkdir, writeFile } from "node:fs/promises";
import { WORLD_BALANCE } from "../../src/data/balance";
import { getCapitalDefenseAssessment } from "../../src/sim/capital-defense";
import { getStrategicProgressAssessment } from "../../src/sim/strategic-progress";
import { FAST_TICK_MS, SLOW_TICK_MS } from "../../src/sim/time";
import { stepFastTick, stepSlowTick } from "../../src/sim/update";
import type { WarState } from "../../src/sim/war-state";
import type { WorldState } from "../../src/sim/world-state";
import type { NationId } from "../../src/worldgen/nation";
import { createScenarioWorld } from "../scenarios";

const FIRST_SEED = 822_748_319_788;
const SEED_COUNT = Number(process.env.WAR_WINDOW_SEED_COUNT ?? 30);
const FAST_TICKS = 3_200;
const OUTPUT_PATH = "diagnostics/war-window-report.json";
const BUCKETS = Array.from({ length: 10 }, (_, index) => index);
type Threat = "none" | "threatened" | "critical" | null;
type Termination = "attacker-surrender" | "defender-surrender" | "attacker-nation-elimination" | "defender-nation-elimination" | "both-surrendered-or-cleanup" | "war-removed-other";

interface SideSnapshot { score: number; resistance: number; territoryCount: number; capitalThreat: Threat; capitalFallCount: number; strategicProgressScore: number | null; activeLandOffensiveCount: number; }
interface WarInstance { id: string; seed: number; warId: string; creationTick: number; attacker: string; defender: string; endTick: number | null; termination: Termination | null; lastSnapshot: { attacker: SideSnapshot; defender: SideSnapshot } | null; }
interface Observation {
  seed: number; observationFastTick: number; observationSlowTick: number; warInstanceId: string; warId: string; warCreationTick: number; attacker: string; defender: string; warAgeTicks: number;
  surrenderThreshold: number; attackerSurrenderScore: number; attackerSurrenderResistance: number; defenderSurrenderScore: number; defenderSurrenderResistance: number; minSideResistance: number; maxSideResistance: number;
  attackerCapitalThreat: Threat; defenderCapitalThreat: Threat; attackerCapitalFallCount: number; defenderCapitalFallCount: number; attackerTerritoryCount: number; defenderTerritoryCount: number; attackerStrategicProgressScore: number | null; defenderStrategicProgressScore: number | null; attackerActiveLandOffensiveCount: number; defenderActiveLandOffensiveCount: number;
  warEndTick: number | null; terminationMechanism: Termination | null; actualRemainingWarTicks: number | null; rightCensored: boolean; attributionValid: boolean; attributionInvalidReason: string | null;
}
interface Distribution { count: number; mean: number | null; median: number | null; p10: number | null; p25: number | null; p75: number | null; p90: number | null; p95: number | null; min: number | null; max: number | null; }
interface PredictorMetric { observationCount: number; meanPredictionError: number | null; medianPredictionError: number | null; meanAbsoluteError: number | null; overpredictionRate: number | null; overprediction100Rate: number | null; overprediction250Rate: number | null; overprediction500Rate: number | null; }

const originalInfo = console.info;
console.info = () => undefined;
const instances: WarInstance[] = [];
const observations: Observation[] = [];
try { for (let index = 0; index < SEED_COUNT; index += 1) runSeed(FIRST_SEED + index, instances, observations); } finally { console.info = originalInfo; }
const instanceById = new Map(instances.map((item) => [item.id, item]));
const attributionValidation = resolveObservations(observations, instanceById, instances);
const resolved = observations.filter((item) => item.attributionValid && !item.rightCensored && item.actualRemainingWarTicks !== null);
const censored = observations.filter((item) => item.attributionValid && item.rightCensored);
await mkdir("diagnostics", { recursive: true });
await writeFile(OUTPUT_PATH, `${JSON.stringify({
  experiment: { scenario: "active-war", seeds: { first: FIRST_SEED, count: SEED_COUNT }, resolution: { width: 1920, height: 1080 }, speed: 32, fastTicks: FAST_TICKS, sampling: "every slow tick" },
  warTerminationLogic: {
    codePath: "src/sim/surrender.ts:updateSurrender", conclusion: "Active wars are removed when either participant surrenders and territory reassignment changes territory; there is no independent peace timer in the war-state module.",
    mechanisms: [
      { mechanism: "attacker-surrender", drivers: ["attacker surrender score >= threshold", "attacker has no units", "attacker fully occupied"], canEndWhileDefenderResistanceHigh: true, estimatorObservability: "current estimator observes neither attacker surrender score nor attacker resistance" },
      { mechanism: "defender-surrender", drivers: ["defender surrender score >= threshold", "defender has no units", "defender fully occupied"], canEndWhileDefenderResistanceHigh: "possible for non-score drivers or between observations", estimatorObservability: "current estimator observes defender surrender score/resistance only" },
      { mechanism: "attacker-nation-elimination / defender-nation-elimination", drivers: ["surrender territory reassignment leaves no macro regions"], canEndWhileDefenderResistanceHigh: true, estimatorObservability: "not directly observed by current estimator" },
      { mechanism: "war-removed-other", drivers: ["reserved diagnostic classification if a war disappears without observed surrender-side territory loss"], canEndWhileDefenderResistanceHigh: true, estimatorObservability: "not directly observed" },
    ],
  },
  attributionValidation,
  summary: { warInstances: instances.length, resolvedWarInstances: instances.filter((item) => item.endTick !== null).length, censoredWarInstances: instances.filter((item) => item.endTick === null).length, observations: observations.length, resolvedObservations: resolved.length, rightCensoredObservations: censored.length },
  observationWeightedComparison: predictorComparison(resolved),
  warInstanceWeightedComparison: warWeightedComparison(resolved),
  resistanceBuckets: bucketAnalysis(resolved, censored),
  pathologicalHighDefenderResistanceShortLifetime: pathologicalAnalysis(resolved),
  capitalThreatResidualAnalysis: capitalResidualAnalysis(resolved),
  representativeCases: representativeCases(resolved),
  observations,
}, null, 2)}\n`, "utf8");
console.log(`War-window diagnostic complete: ${OUTPUT_PATH}`);

function runSeed(seed: number, allInstances: WarInstance[], allObservations: Observation[]): void {
  const world = createScenarioWorld("active-war", { seed, width: 1920, height: 1080, quick: false, reserveEnabled: true, reorganizationEnabled: true, exploitationEnabled: true, pocketReductionEnabled: true });
  const registry = new Map<string, WarInstance>(); let priorTerritory = territoryCounts(world);
  observeInstances(world, seed, registry, priorTerritory);
  for (let tick = 0; tick < FAST_TICKS; tick += 1) {
    stepFastTick(world, FAST_TICK_MS); observeInstances(world, seed, registry, priorTerritory); priorTerritory = territoryCounts(world);
    const due = Math.floor(world.time.elapsedMs / SLOW_TICK_MS);
    while (world.time.slowTick < due) { stepSlowTick(world, SLOW_TICK_MS); observeInstances(world, seed, registry, priorTerritory); priorTerritory = territoryCounts(world); sample(world, seed, registry, allObservations); }
  }
  allInstances.push(...registry.values());
}

function sample(world: WorldState, seed: number, registry: Map<string, WarInstance>, destination: Observation[]): void {
  const threshold = Math.max(0.001, WORLD_BALANCE.war.surrender.threshold);
  const counts = territoryCounts(world);
  for (const war of world.wars) {
    const instance = registry.get(key(seed, war)); if (!instance) continue;
    const attacker = sideSnapshot(world, war.aggressorId, war.defenderId, counts, threshold);
    const defender = sideSnapshot(world, war.defenderId, war.aggressorId, counts, threshold);
    instance.lastSnapshot = { attacker, defender };
    destination.push({ seed, observationFastTick: world.time.fastTick, observationSlowTick: world.time.slowTick, warInstanceId: instance.id, warId: war.id, warCreationTick: instance.creationTick, attacker: war.aggressorId, defender: war.defenderId, warAgeTicks: Math.max(0, world.time.fastTick - instance.creationTick), surrenderThreshold: threshold, attackerSurrenderScore: attacker.score, attackerSurrenderResistance: attacker.resistance, defenderSurrenderScore: defender.score, defenderSurrenderResistance: defender.resistance, minSideResistance: Math.min(attacker.resistance, defender.resistance), maxSideResistance: Math.max(attacker.resistance, defender.resistance), attackerCapitalThreat: attacker.capitalThreat, defenderCapitalThreat: defender.capitalThreat, attackerCapitalFallCount: attacker.capitalFallCount, defenderCapitalFallCount: defender.capitalFallCount, attackerTerritoryCount: attacker.territoryCount, defenderTerritoryCount: defender.territoryCount, attackerStrategicProgressScore: attacker.strategicProgressScore, defenderStrategicProgressScore: defender.strategicProgressScore, attackerActiveLandOffensiveCount: attacker.activeLandOffensiveCount, defenderActiveLandOffensiveCount: defender.activeLandOffensiveCount, warEndTick: null, terminationMechanism: null, actualRemainingWarTicks: null, rightCensored: true, attributionValid: true, attributionInvalidReason: null });
  }
}

function sideSnapshot(world: WorldState, nationId: NationId, enemyId: NationId, counts: Map<string, number>, threshold: number): SideSnapshot {
  const nation = world.nations.find((item) => item.id === nationId);
  return { score: nation?.surrenderScore ?? 0, resistance: clamp(1 - (nation?.surrenderScore ?? 0) / threshold, 0, 1), territoryCount: counts.get(nationId) ?? 0, capitalThreat: getCapitalDefenseAssessment(world, nationId)?.threatLevel ?? null, capitalFallCount: nation?.capitalFallCount ?? 0, strategicProgressScore: getStrategicProgressAssessment(world, nationId, enemyId)?.score ?? null, activeLandOffensiveCount: world.offensiveOperations.operations.filter((operation) => operation.nationId === nationId && operation.enemyNationId === enemyId && operation.outcome === null).length };
}

function observeInstances(world: WorldState, seed: number, registry: Map<string, WarInstance>, prior: Map<string, number>): void {
  const current = new Set<string>(); const territory = territoryCounts(world);
  for (const war of world.wars) { const id = key(seed, war); current.add(id); if (!registry.has(id)) registry.set(id, { id, seed, warId: war.id, creationTick: war.startedAtFastTick, attacker: war.aggressorId, defender: war.defenderId, endTick: null, termination: null, lastSnapshot: null }); }
  for (const instance of registry.values()) {
    if (instance.endTick !== null || current.has(instance.id)) continue;
    const attackerLostTerritory = (prior.get(instance.attacker) ?? 0) > (territory.get(instance.attacker) ?? 0);
    const defenderLostTerritory = (prior.get(instance.defender) ?? 0) > (territory.get(instance.defender) ?? 0);
    instance.endTick = world.time.fastTick;
    const attackerEliminated = attackerLostTerritory && (territory.get(instance.attacker) ?? 0) === 0;
    const defenderEliminated = defenderLostTerritory && (territory.get(instance.defender) ?? 0) === 0;
    instance.termination = attackerLostTerritory && defenderLostTerritory ? "both-surrendered-or-cleanup" : attackerEliminated ? "attacker-nation-elimination" : defenderEliminated ? "defender-nation-elimination" : attackerLostTerritory ? "attacker-surrender" : defenderLostTerritory ? "defender-surrender" : "war-removed-other";
  }
}

function resolveObservations(items: Observation[], byId: Map<string, WarInstance>, allInstances: WarInstance[]): object {
  const counters = { observationsBeforeWarCreation: 0, observationsAfterWarEnd: 0, negativeRemainingWarValues: 0, ambiguousMatches: 0, unmatchedObservations: 0, reusedWarIdLifetimeCount: [...groupBy(allInstances, (item) => `${item.seed}:${item.warId}`).values()].filter((group) => group.length > 1).length, validObservations: 0 };
  for (const item of items) {
    const instance = byId.get(item.warInstanceId);
    if (!instance) { item.attributionValid = false; item.attributionInvalidReason = "unmatched-war-instance"; counters.unmatchedObservations += 1; continue; }
    if (item.observationFastTick < instance.creationTick) { item.attributionValid = false; item.attributionInvalidReason = "observation-before-war-creation"; counters.observationsBeforeWarCreation += 1; continue; }
    item.warEndTick = instance.endTick; item.terminationMechanism = instance.termination;
    if (instance.endTick === null) { counters.validObservations += 1; continue; }
    const remaining = instance.endTick - item.observationFastTick;
    if (remaining < 0) { item.attributionValid = false; item.attributionInvalidReason = "negative-remaining-war-duration"; counters.negativeRemainingWarValues += 1; continue; }
    item.actualRemainingWarTicks = remaining; item.rightCensored = false; counters.validObservations += 1;
  }
  return counters;
}

function predictorComparison(items: Observation[]): object { return { mapping: "round(120 + resistance * 1080)", predictors: predictorSet(items) }; }
function predictorSet(items: Observation[]): Record<string, PredictorMetric> { return { "A-defenderResistance-current": predictorMetrics(items, (item) => item.defenderSurrenderResistance), "B-attackerResistance": predictorMetrics(items, (item) => item.attackerSurrenderResistance), "C-minSideResistance": predictorMetrics(items, (item) => item.minSideResistance), "D-maxSideResistance": predictorMetrics(items, (item) => item.maxSideResistance) }; }
function predictorMetrics(items: Observation[], value: (item: Observation) => number): PredictorMetric { const errors = items.map((item) => Math.round(120 + value(item) * 1080) - item.actualRemainingWarTicks!); return { observationCount: items.length, meanPredictionError: mean(errors), medianPredictionError: percentile(errors, .5), meanAbsoluteError: mean(errors.map(Math.abs)), overpredictionRate: rate(errors, (x) => x > 0), overprediction100Rate: rate(errors, (x) => x > 100), overprediction250Rate: rate(errors, (x) => x > 250), overprediction500Rate: rate(errors, (x) => x > 500) }; }
function warWeightedComparison(items: Observation[]): object { const byWar = [...groupBy(items, (item) => item.warInstanceId).values()].map((war) => representativeWarObservation(war)); return { representativeWithinWar: "median actual remaining lifetime observation; predictor state from that median-ranked observation", warInstanceCount: byWar.length, mapping: "round(120 + resistance * 1080)", predictors: predictorSet(byWar) }; }
function representativeWarObservation(items: Observation[]): Observation { return [...items].sort((a, b) => a.actualRemainingWarTicks! - b.actualRemainingWarTicks!)[Math.floor(items.length / 2)]; }
function bucketAnalysis(resolved: Observation[], censored: Observation[]): object { return { bucketDefinition: "[0.0, 0.1), ..., [0.9, 1.0] (exact 1.0 included)", byPredictor: Object.fromEntries(["defenderSurrenderResistance", "attackerSurrenderResistance", "minSideResistance", "maxSideResistance"].map((field) => [field, BUCKETS.map((bucket) => { const r = resolved.filter((item) => bucketFor(item[field as keyof Observation] as number) === bucket); const c = censored.filter((item) => bucketFor(item[field as keyof Observation] as number) === bucket); return { bucket: label(bucket), resolvedObservationCount: r.length, resolvedWarInstanceCount: new Set(r.map((item) => item.warInstanceId)).size, actualRemainingWarTicks: distribution(r.map((item) => item.actualRemainingWarTicks!)), currentMappingError: predictorMetrics(r, (item) => item[field as keyof Observation] as number), rightCensoredObservationCount: c.length, rightCensoredWarInstanceCount: new Set(c.map((item) => item.warInstanceId)).size }; })])) }; }
function pathologicalAnalysis(items: Observation[]): object { const cases = items.filter((item) => item.defenderSurrenderResistance >= .9 && item.actualRemainingWarTicks! <= 100); return { definition: "defender resistance >= 0.9 and actual remaining duration <= 100", observationCount: cases.length, uniqueWarInstanceCount: new Set(cases.map((item) => item.warInstanceId)).size, terminationMechanismCounts: countBy(cases, (item) => item.terminationMechanism ?? "unresolved"), terminationMechanismRates: ratesBy(cases, (item) => item.terminationMechanism ?? "unresolved"), capitalThreatAtObservationCounts: countBy(cases, (item) => `${item.attackerCapitalThreat ?? "unknown"}->${item.defenderCapitalThreat ?? "unknown"}`), representativeCases: cases.sort((a, b) => a.actualRemainingWarTicks! - b.actualRemainingWarTicks!).slice(0, 25) }; }
function capitalResidualAnalysis(items: Observation[]): object { const groups = ["attacker-critical", "attacker-threatened", "defender-critical", "defender-threatened", "neither-threatened"]; return Object.fromEntries(groups.map((group) => { const matching = items.filter((item) => group === "attacker-critical" ? item.attackerCapitalThreat === "critical" : group === "attacker-threatened" ? item.attackerCapitalThreat === "threatened" : group === "defender-critical" ? item.defenderCapitalThreat === "critical" : group === "defender-threatened" ? item.defenderCapitalThreat === "threatened" : item.attackerCapitalThreat === "none" && item.defenderCapitalThreat === "none"); return [group, { observationCount: matching.length, actualRemainingWarTicks: distribution(matching.map((item) => item.actualRemainingWarTicks!)), defenderResistancePrediction: predictorMetrics(matching, (item) => item.defenderSurrenderResistance), minSideResistancePrediction: predictorMetrics(matching, (item) => item.minSideResistance) }]; })); }
function representativeCases(items: Observation[]): object { const errors = items.map((item) => ({ ...item, defenderPredictionError: Math.round(120 + item.defenderSurrenderResistance * 1080) - item.actualRemainingWarTicks! })); return { largestDefenderResistanceOverpredictions: [...errors].sort((a, b) => b.defenderPredictionError - a.defenderPredictionError).slice(0, 20), attackerCollapseWithHighDefenderResistance: errors.filter((item) => item.defenderSurrenderResistance >= .9 && item.terminationMechanism === "attacker-surrender").sort((a, b) => a.actualRemainingWarTicks! - b.actualRemainingWarTicks!).slice(0, 20) }; }
function distribution(values: number[]): Distribution { return { count: values.length, mean: mean(values), median: percentile(values,.5), p10: percentile(values,.1), p25: percentile(values,.25), p75: percentile(values,.75), p90: percentile(values,.9), p95: percentile(values,.95), min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null }; }
function key(seed: number, war: WarState): string { return `${seed}:${war.id}:${war.startedAtFastTick}:${war.aggressorId}:${war.defenderId}`; }
function territoryCounts(world: WorldState): Map<string, number> { const result = new Map<string, number>(); for (const macro of world.macroRegions) result.set(macro.nationId, (result.get(macro.nationId) ?? 0) + 1); return result; }
function bucketFor(value: number): number { return Math.min(9, Math.max(0, Math.floor(value * 10))); }
function label(bucket: number): string { return bucket === 9 ? "[0.9, 1.0]" : `[${(bucket / 10).toFixed(1)}, ${((bucket + 1) / 10).toFixed(1)})`; }
function mean(values: number[]): number | null { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null; }
function percentile(values: number[], p: number): number | null { if (!values.length) return null; const sorted = [...values].sort((a,b) => a-b); const at = (sorted.length - 1) * p; const lo = Math.floor(at), hi = Math.ceil(at); return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo); }
function rate(values: number[], predicate: (value: number) => boolean): number | null { return values.length ? values.filter(predicate).length / values.length : null; }
function countBy<T>(items: T[], field: (item: T) => string): Record<string, number> { const result: Record<string, number> = {}; for (const item of items) result[field(item)] = (result[field(item)] ?? 0) + 1; return result; }
function ratesBy<T>(items: T[], field: (item: T) => string): Record<string, number | null> { const counts = countBy(items, field); return Object.fromEntries(Object.entries(counts).map(([key, count]) => [key, items.length ? count / items.length : null])); }
function groupBy<T>(items: T[], field: (item: T) => string): Map<string, T[]> { const result = new Map<string, T[]>(); for (const item of items) { const key = field(item), group = result.get(key) ?? []; group.push(item); result.set(key, group); } return result; }
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
