import { mkdir, writeFile } from "node:fs/promises";
import { setAmphibiousDiagnosticObserver, type AmphibiousLaunchFeasibilityDiagnostic } from "../../src/sim/amphibious";
import { FAST_TICK_MS, SLOW_TICK_MS } from "../../src/sim/time";
import { stepFastTick, stepSlowTick } from "../../src/sim/update";
import type { WorldState } from "../../src/sim/world-state";
import type { WarState } from "../../src/sim/war-state";
import { createScenarioWorld } from "../scenarios";

const FIRST_SEED = 822_748_319_788;
const DEFAULT_SEED_COUNT = 30;
const SEED_COUNT = Number(process.env.WAR_ATTRIBUTION_SEED_COUNT ?? DEFAULT_SEED_COUNT);
const FAST_TICKS = 3_200;
const OUTPUT_PATH = "diagnostics/strategic-window-war-attribution-report.json";

type TerminationMechanism = "attacker surrendered" | "defender surrendered" | "war ended through nation elimination" | "other";

interface WarInstance {
  warInstanceId: string;
  seed: number;
  warId: string;
  creationTick: number;
  endTick: number | null;
  attacker: string;
  defender: string;
  nationA: string;
  nationB: string;
  terminationMechanism: TerminationMechanism | null;
}

interface EvaluationAssociation {
  seed: number;
  demandId: string;
  evaluationTick: number;
  accepted: boolean;
  demandWarId: string | null;
  demandNationId: string;
  demandEnemyNationId: string;
  demandAttacker: string | null;
  demandDefender: string | null;
  warInstanceId: string | null;
  matchedWarId: string | null;
  matchedCreationTick: number | null;
  matchedEndTick: number | null;
  matchedAttacker: string | null;
  matchedDefender: string | null;
  associationMethod: "active-war-pair" | "unmatched" | "ambiguous-active-war-pair";
  associationValid: boolean;
  invalidAssociationReason: string | null;
  estimatedCompletionTicks: number;
  predictedWindowTicks: number;
  safetyMarginTicks: number;
  actualRemainingWarTicks: number | null;
  rightCensored: boolean;
  actualCompletionPossible: boolean | null;
  terminationMechanism: TerminationMechanism | null;
  terminationSide: "attacker" | "defender" | "other" | "unknown";
}

interface SanityCounters {
  evaluationBeforeWarCreationCount: number;
  evaluationAfterWarEndCount: number;
  warIdReuseCount: number;
  pairReuseCount: number;
  reversedPairReuseCount: number;
  unmatchedEvaluationCount: number;
  ambiguousWarMatchCount: number;
  negativeRemainingWarCount: number;
}

const originalInfo = console.info;
console.info = () => undefined;
const instances: WarInstance[] = [];
const evaluations: EvaluationAssociation[] = [];
try {
  for (let index = 0; index < SEED_COUNT; index += 1) runSeed(FIRST_SEED + index, instances, evaluations);
} finally {
  console.info = originalInfo;
  setAmphibiousDiagnosticObserver(null);
}

const reuse = reuseDiagnostics(instances);
const resolved = resolveAssociations(evaluations, new Map(instances.map((instance) => [instance.warInstanceId, instance])));
const counters = sanityCounters(resolved, reuse);
const accepted = resolved.filter((evaluation) => evaluation.accepted);
await mkdir("diagnostics", { recursive: true });
await writeFile(OUTPUT_PATH, `${JSON.stringify({
  experiment: { scenario: "active-war", seeds: { first: FIRST_SEED, count: SEED_COUNT }, resolution: { width: 1_920, height: 1_080 }, speed: 32, fastTicks: FAST_TICKS },
  summary: {
    acceptedEvaluations: accepted.length,
    validAssociations: resolved.filter((evaluation) => evaluation.associationValid).length,
    invalidAssociations: resolved.filter((evaluation) => !evaluation.associationValid).length,
    ...counters,
  },
  warInstances: instances,
  representativeInvalidAssociations: resolved.filter((evaluation) => !evaluation.associationValid).slice(0, 10),
  representativeWarIdReuse: reuse.warIdExamples,
  representativePairReuse: reuse.pairExamples,
  correctedAcceptanceGroundTruth: acceptanceGroundTruth(accepted),
  feasibilityEvaluations: resolved,
}, null, 2)}\n`, "utf8");
console.log(`War-attribution diagnostic complete: ${OUTPUT_PATH}`);

function runSeed(seed: number, destinationInstances: WarInstance[], destinationEvaluations: EvaluationAssociation[]): void {
  const world = createScenarioWorld("active-war", { seed, width: 1_920, height: 1_080, quick: false,
    reserveEnabled: true, reorganizationEnabled: true, exploitationEnabled: true, pocketReductionEnabled: true });
  const registry = new Map<string, WarInstance>();
  let priorTerritoryCounts = territoryCounts(world);
  observeInstances(world, seed, registry, priorTerritoryCounts);
  setAmphibiousDiagnosticObserver({ onOperationConnection(event) {
    if (event.stage !== "operation-creation" || !event.launchFeasibility) return;
    const demand = world.amphibiousOperations.capabilityDemands.find((item) => item.id === event.demandId);
    if (!demand) return;
    const candidates = world.wars.filter((war) => matchesPair(war, demand.nationId, demand.enemyNationId));
    const war = candidates[0] ?? null;
    const instance = war ? registry.get(instanceKey(seed, war)) ?? null : null;
    const ambiguous = candidates.length > 1;
    const association = associationFor(seed, demand.id, event.tick, event.launchFeasibility, demand.nationId, demand.enemyNationId, war, instance, ambiguous);
    destinationEvaluations.push(association);
  } });
  for (let tick = 0; tick < FAST_TICKS; tick += 1) {
    stepFastTick(world, FAST_TICK_MS);
    observeInstances(world, seed, registry, priorTerritoryCounts);
    priorTerritoryCounts = territoryCounts(world);
    const dueSlowTicks = Math.floor(world.time.elapsedMs / SLOW_TICK_MS);
    while (world.time.slowTick < dueSlowTicks) {
      stepSlowTick(world, SLOW_TICK_MS);
      observeInstances(world, seed, registry, priorTerritoryCounts);
      priorTerritoryCounts = territoryCounts(world);
    }
  }
  destinationInstances.push(...registry.values());
}

function associationFor(
  seed: number, demandId: string, evaluationTick: number, feasibility: AmphibiousLaunchFeasibilityDiagnostic,
  nationId: string, enemyNationId: string, war: WarState | null, instance: WarInstance | null, ambiguous: boolean,
): EvaluationAssociation {
  const pairMatches = !!war && matchesPair(war, nationId, enemyNationId);
  const valid = !!instance && pairMatches && instance.creationTick <= evaluationTick &&
    (instance.endTick === null || instance.endTick >= evaluationTick) && !ambiguous;
  const reason = !war ? "no-active-war-for-demand-pair" : ambiguous ? "multiple-active-wars-for-demand-pair"
    : !instance ? "active-war-instance-not-registered" : instance.creationTick > evaluationTick ? "evaluation-before-war-creation"
    : instance.endTick !== null && instance.endTick < evaluationTick ? "evaluation-after-war-end" : !pairMatches ? "demand-pair-mismatch" : null;
  return {
    seed, demandId, evaluationTick, accepted: feasibility.reason === null, demandWarId: war?.id ?? null,
    demandNationId: nationId, demandEnemyNationId: enemyNationId, demandAttacker: war?.aggressorId ?? null, demandDefender: war?.defenderId ?? null,
    warInstanceId: instance?.warInstanceId ?? null, matchedWarId: war?.id ?? null, matchedCreationTick: instance?.creationTick ?? null,
    matchedEndTick: instance?.endTick ?? null, matchedAttacker: instance?.attacker ?? null, matchedDefender: instance?.defender ?? null,
    associationMethod: ambiguous ? "ambiguous-active-war-pair" : war ? "active-war-pair" : "unmatched",
    associationValid: valid, invalidAssociationReason: reason,
    estimatedCompletionTicks: feasibility.estimatedCompletionTicks, predictedWindowTicks: feasibility.opportunityWindowTicks,
    safetyMarginTicks: feasibility.safetyMarginTicks, actualRemainingWarTicks: null, rightCensored: true,
    actualCompletionPossible: null, terminationMechanism: null, terminationSide: "unknown",
  };
}

function observeInstances(world: WorldState, seed: number, registry: Map<string, WarInstance>, priorTerritory: Map<string, number>): void {
  const current = new Set<string>();
  const territory = territoryCounts(world);
  for (const war of world.wars) {
    const key = instanceKey(seed, war);
    current.add(key);
    if (!registry.has(key)) registry.set(key, createInstance(seed, war));
  }
  for (const instance of registry.values()) {
    if (instance.endTick !== null || current.has(instance.warInstanceId)) continue;
    const attackerGone = (priorTerritory.get(instance.attacker) ?? 0) > 0 && (territory.get(instance.attacker) ?? 0) === 0;
    const defenderGone = (priorTerritory.get(instance.defender) ?? 0) > 0 && (territory.get(instance.defender) ?? 0) === 0;
    instance.endTick = world.time.fastTick;
    instance.terminationMechanism = attackerGone ? "attacker surrendered" : defenderGone ? "defender surrendered" : "other";
  }
}

function createInstance(seed: number, war: WarState): WarInstance {
  return { warInstanceId: instanceKey(seed, war), seed, warId: war.id, creationTick: war.startedAtFastTick, endTick: null,
    attacker: war.aggressorId, defender: war.defenderId, nationA: war.nationAId, nationB: war.nationBId, terminationMechanism: null };
}

function instanceKey(seed: number, war: WarState): string { return `${seed}:${war.id}:${war.startedAtFastTick}:${war.aggressorId}:${war.defenderId}`; }
function matchesPair(war: WarState, a: string, b: string): boolean { return war.nationAId === a && war.nationBId === b || war.nationAId === b && war.nationBId === a; }

function territoryCounts(world: WorldState): Map<string, number> {
  const counts = new Map<string, number>();
  for (const macro of world.macroRegions) counts.set(macro.nationId, (counts.get(macro.nationId) ?? 0) + 1);
  return counts;
}

function resolveAssociations(evaluations: EvaluationAssociation[], instancesById: Map<string, WarInstance>): EvaluationAssociation[] {
  for (const evaluation of evaluations) {
    const instance = evaluation.warInstanceId ? instancesById.get(evaluation.warInstanceId) : undefined;
    if (!instance) continue;
    evaluation.matchedEndTick = instance.endTick;
    evaluation.terminationMechanism = instance.terminationMechanism;
    evaluation.terminationSide = instance.terminationMechanism === "attacker surrendered" ? "attacker"
      : instance.terminationMechanism === "defender surrendered" ? "defender" : instance.endTick === null ? "unknown" : "other";
    if (!evaluation.associationValid || instance.endTick === null) continue;
    const remaining = instance.endTick - evaluation.evaluationTick;
    if (remaining < 0) {
      evaluation.associationValid = false;
      evaluation.invalidAssociationReason = "negative-remaining-war-duration";
      continue;
    }
    evaluation.actualRemainingWarTicks = remaining;
    evaluation.rightCensored = false;
    evaluation.actualCompletionPossible = remaining >= evaluation.estimatedCompletionTicks;
  }
  return evaluations;
}

function reuseDiagnostics(instances: readonly WarInstance[]): { warIdCount: number; pairCount: number; reversedPairCount: number; warIdExamples: WarInstance[][]; pairExamples: WarInstance[][] } {
  const byWarId = groupBy(instances, (instance) => `${instance.seed}:${instance.warId}`);
  const byPair = groupBy(instances, (instance) => `${instance.seed}:${[instance.nationA, instance.nationB].sort().join("|")}`);
  const duplicateWarIds = [...byWarId.values()].filter((group) => group.length > 1);
  const duplicatePairs = [...byPair.values()].filter((group) => group.length > 1);
  const reversed = duplicatePairs.filter((group) => new Set(group.map((item) => `${item.attacker}->${item.defender}`)).size > 1);
  return { warIdCount: duplicateWarIds.length, pairCount: duplicatePairs.length, reversedPairCount: reversed.length,
    warIdExamples: duplicateWarIds.slice(0, 10), pairExamples: duplicatePairs.slice(0, 10) };
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const item of items) { const groupKey = key(item); const group = result.get(groupKey) ?? []; group.push(item); result.set(groupKey, group); }
  return result;
}

function sanityCounters(evaluations: readonly EvaluationAssociation[], reuse: ReturnType<typeof reuseDiagnostics>): SanityCounters {
  return {
    evaluationBeforeWarCreationCount: evaluations.filter((item) => item.invalidAssociationReason === "evaluation-before-war-creation").length,
    evaluationAfterWarEndCount: evaluations.filter((item) => item.invalidAssociationReason === "evaluation-after-war-end").length,
    warIdReuseCount: reuse.warIdCount, pairReuseCount: reuse.pairCount, reversedPairReuseCount: reuse.reversedPairCount,
    unmatchedEvaluationCount: evaluations.filter((item) => item.associationMethod === "unmatched").length,
    ambiguousWarMatchCount: evaluations.filter((item) => item.associationMethod === "ambiguous-active-war-pair").length,
    negativeRemainingWarCount: evaluations.filter((item) => item.invalidAssociationReason === "negative-remaining-war-duration").length,
  };
}

function acceptanceGroundTruth(evaluations: readonly EvaluationAssociation[]): object {
  const resolved = evaluations.filter((item) => item.associationValid && !item.rightCensored);
  const possible = resolved.filter((item) => item.actualCompletionPossible).length;
  const impossible = resolved.filter((item) => item.actualCompletionPossible === false).length;
  return {
    resolvedAcceptedEvaluations: resolved.length,
    rightCensoredAcceptedEvaluations: evaluations.filter((item) => item.associationValid && item.rightCensored).length,
    actualCompletionPossibleCount: possible, actualCompletionImpossibleCount: impossible,
    falseAcceptanceRate: resolved.length ? impossible / resolved.length : null,
    terminationSide: countBy(resolved, (item) => item.terminationSide),
  };
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const item of items) { const value = key(item); result[value] = (result[value] ?? 0) + 1; }
  return result;
}
