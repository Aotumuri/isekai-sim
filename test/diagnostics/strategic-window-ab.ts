import { mkdir, writeFile } from "node:fs/promises";
import {
  setAmphibiousDiagnosticObserver,
  setAmphibiousStrategicWindowDiagnosticPolicy,
  type AmphibiousLaunchFeasibilityDiagnostic,
  type AmphibiousOperation,
  type AmphibiousStrategicWindowDiagnosticPolicy,
} from "../../src/sim/amphibious";
import { FAST_TICK_MS, SLOW_TICK_MS } from "../../src/sim/time";
import { stepFastTick, stepSlowTick } from "../../src/sim/update";
import type { WorldState } from "../../src/sim/world-state";
import type { WarState } from "../../src/sim/war-state";
import { createScenarioWorld } from "../scenarios";

const FIRST_SEED = 822_748_319_788;
const DEFAULT_SEED_COUNT = 30;
const SEED_COUNT = Number(process.env.STRATEGIC_WINDOW_AB_SEED_COUNT ?? DEFAULT_SEED_COUNT);
const FAST_TICKS = 3_200;
const OUTPUT_PATH = "diagnostics/strategic-window-ab-report.json";
const VARIANTS: AmphibiousStrategicWindowDiagnosticPolicy[] = ["baseline-360", "relaxed-540", "soft-0.75"];

type TerminationMechanism = "attacker surrendered" | "defender surrendered" | "war ended through nation elimination" | "other";

interface WarOutcome { endTick: number; terminationMechanism: TerminationMechanism }

interface Evaluation {
  seed: number;
  demandId: string;
  warId: string;
  attacker: string;
  defender: string;
  evaluationTick: number;
  accepted: boolean;
  feasibility: AmphibiousLaunchFeasibilityDiagnostic;
  warEndTick: number | null;
  actualRemainingWarTicks: number | null;
  rightCensored: boolean;
  actualCompletionPossible: boolean | null;
}

interface OperationResult {
  seed: number;
  demandId: string;
  warId: string;
  operationId: string;
  createdTick: number;
  estimatedCompletionTicks: number;
  actualRemainingWarTicks: number | null;
  theoreticalCompletionPossible: boolean | null;
  launchedAtTick: number | null;
  landedAtTick: number | null;
  beachheadOutcome: AmphibiousOperation["beachheadOutcome"];
  beachheadTick: number | null;
  cancellationReason: string | null;
}

interface VariantResult {
  policy: AmphibiousStrategicWindowDiagnosticPolicy;
  evaluations: Evaluation[];
  operations: OperationResult[];
  metrics: VariantMetrics;
}

interface Distribution { count: number; mean: number | null; median: number | null; p90: number | null; p95: number | null; min: number | null; max: number | null }

interface VariantMetrics {
  evaluationLevel: DecisionMetrics;
  uniqueDemandLevel: DecisionMetrics;
  enemyCapitalThreatened: ThreatenedMetrics;
  downstream: DownstreamMetrics;
  admittedOperationTiming: Record<string, Distribution>;
}

interface DecisionMetrics {
  totalFeasibilityEvaluations: number;
  acceptedEvaluations: number;
  rejectedEvaluations: number;
  resolvedEvaluationCount: number;
  rightCensoredEvaluationCount: number;
  correctRejections: number;
  falseRejections: number;
  correctRejectionRate: number | null;
  falseRejectionRate: number | null;
  confusionMatrix: { acceptActualPossible: number; acceptActualImpossible: number; rejectActualPossible: number; rejectActualImpossible: number };
}

interface ThreatenedMetrics {
  evaluationCount: number;
  rejectionCount: number;
  resolvedRejectionCount: number;
  correctRejectionCount: number;
  falseRejectionCount: number;
  falseRejectionRate: number | null;
}

interface DownstreamMetrics {
  operationCreationCount: number;
  uniqueDemandsWithOperation: number;
  launchCount: number;
  landingCount: number;
  beachheadCount: number;
  successfulBeachheadCount: number;
  operationsTerminatedBecauseWarEnded: number;
  operationsTerminatedBeforeLanding: number;
}

const originalInfo = console.info;
console.info = () => undefined;
const variants: Record<string, VariantResult> = {};
try {
  for (const policy of VARIANTS) variants[policy] = runVariant(policy);
} finally {
  console.info = originalInfo;
  setAmphibiousDiagnosticObserver(null);
  setAmphibiousStrategicWindowDiagnosticPolicy(null);
}

const comparison = compareVariants(variants);
await mkdir("diagnostics", { recursive: true });
await writeFile(OUTPUT_PATH, `${JSON.stringify({
  experiment: {
    scenario: "active-war", seeds: { first: FIRST_SEED, count: SEED_COUNT },
    resolution: { width: 1_920, height: 1_080 }, speed: 32, fastTicks: FAST_TICKS,
    policies: {
      "baseline-360": "enemy-capital-threatened hard cap 360 ticks",
      "relaxed-540": "enemy-capital-threatened hard cap 540 ticks",
      "soft-0.75": "enemy-capital-threatened multiplies the pre-cap window by 0.75",
    },
  },
  variants,
  comparison,
  representativeCases: comparison.representativeCases,
}, null, 2)}\n`, "utf8");
console.log(`Strategic-window A/B diagnostic complete: ${OUTPUT_PATH}`);

function runVariant(policy: AmphibiousStrategicWindowDiagnosticPolicy): VariantResult {
  const evaluations: Evaluation[] = [];
  const operations: OperationResult[] = [];
  for (let index = 0; index < SEED_COUNT; index += 1) {
    const seed = FIRST_SEED + index;
    const world = createScenarioWorld("active-war", {
      seed, width: 1_920, height: 1_080, quick: false,
      reserveEnabled: true, reorganizationEnabled: true, exploitationEnabled: true, pocketReductionEnabled: true,
    });
    const knownWars = new Map<string, WarState>();
    const outcomes = new Map<string, WarOutcome>();
    let priorNationCounts = nationCounts(world);
    trackWarOutcomes(world, knownWars, outcomes, priorNationCounts);
    setAmphibiousStrategicWindowDiagnosticPolicy(policy);
    setAmphibiousDiagnosticObserver({ onOperationConnection(event) {
      if (event.stage !== "operation-creation" || !event.launchFeasibility) return;
      const demand = world.amphibiousOperations.capabilityDemands.find((item) => item.id === event.demandId);
      if (!demand) return;
      const war = world.wars.find((item) => (item.nationAId === demand.nationId && item.nationBId === demand.enemyNationId) ||
        (item.nationBId === demand.nationId && item.nationAId === demand.enemyNationId));
      if (!war) return;
      evaluations.push({
        seed, demandId: demand.id, warId: war.id, attacker: war.aggressorId, defender: war.defenderId,
        evaluationTick: event.tick, accepted: event.launchFeasibility.reason === null, feasibility: event.launchFeasibility,
        warEndTick: null, actualRemainingWarTicks: null, rightCensored: true, actualCompletionPossible: null,
      });
    } });
    for (let tick = 0; tick < FAST_TICKS; tick += 1) {
      stepFastTick(world, FAST_TICK_MS);
      trackWarOutcomes(world, knownWars, outcomes, priorNationCounts);
      priorNationCounts = nationCounts(world);
      const dueSlowTicks = Math.floor(world.time.elapsedMs / SLOW_TICK_MS);
      while (world.time.slowTick < dueSlowTicks) {
        stepSlowTick(world, SLOW_TICK_MS);
        trackWarOutcomes(world, knownWars, outcomes, priorNationCounts);
        priorNationCounts = nationCounts(world);
      }
    }
    resolveEvaluations(evaluations, seed, outcomes);
    collectOperations(world, seed, outcomes, evaluations, operations);
  }
  return { policy, evaluations, operations, metrics: variantMetrics(evaluations, operations) };
}

function nationCounts(world: WorldState): Map<string, number> {
  return new Map(world.nations.map((nation) => [nation.id, nation.macroRegionIds.length]));
}

function trackWarOutcomes(
  world: WorldState, knownWars: Map<string, WarState>, outcomes: Map<string, WarOutcome>, priorNationCounts: Map<string, number>,
): void {
  const active = new Set<string>(world.wars.map((war) => war.id));
  for (const [id, war] of knownWars) {
    if (active.has(id) || outcomes.has(id)) continue;
    const now = nationCounts(world);
    const attackerGone = (priorNationCounts.get(war.aggressorId) ?? 0) > 0 && (now.get(war.aggressorId) ?? 0) === 0;
    const defenderGone = (priorNationCounts.get(war.defenderId) ?? 0) > 0 && (now.get(war.defenderId) ?? 0) === 0;
    outcomes.set(id, { endTick: world.time.fastTick, terminationMechanism: attackerGone ? "attacker surrendered"
      : defenderGone ? "defender surrendered" : "other" });
  }
  for (const war of world.wars) knownWars.set(war.id, { ...war, contributionByNationId: new Map(war.contributionByNationId) });
}

function resolveEvaluations(evaluations: Evaluation[], seed: number, outcomes: Map<string, WarOutcome>): void {
  for (const evaluation of evaluations) {
    if (evaluation.seed !== seed || !evaluation.rightCensored) continue;
    const outcome = outcomes.get(evaluation.warId);
    if (!outcome) continue;
    evaluation.warEndTick = outcome.endTick;
    evaluation.actualRemainingWarTicks = Math.max(0, outcome.endTick - evaluation.evaluationTick);
    evaluation.rightCensored = false;
    evaluation.actualCompletionPossible = evaluation.actualRemainingWarTicks >= evaluation.feasibility.estimatedCompletionTicks;
  }
}

function collectOperations(
  world: WorldState, seed: number, outcomes: Map<string, WarOutcome>, evaluations: readonly Evaluation[], destination: OperationResult[],
): void {
  const demands = new Map(world.amphibiousOperations.capabilityDemands.map((demand) => [demand.id, demand]));
  for (const operation of world.amphibiousOperations.operations) {
    const demand = demands.get(operation.capabilityDemandId);
    if (!demand) continue;
    const war = evaluations.find((evaluation) => evaluation.seed === seed && evaluation.demandId === demand.id)?.warId ??
      world.wars.find((item) => (item.nationAId === operation.nationId && item.nationBId === operation.enemyNationId) ||
        (item.nationBId === operation.nationId && item.nationAId === operation.enemyNationId))?.id ?? "unknown";
    const outcome = outcomes.get(war);
    const remaining = outcome ? Math.max(0, outcome.endTick - operation.preparationLeaseStartedAtTick) : null;
    destination.push({
      seed, demandId: demand.id, warId: war, operationId: operation.id, createdTick: operation.preparationLeaseStartedAtTick,
      estimatedCompletionTicks: operation.launchFeasibility.estimatedCompletionTicks, actualRemainingWarTicks: remaining,
      theoreticalCompletionPossible: remaining === null ? null : remaining >= operation.launchFeasibility.estimatedCompletionTicks,
      launchedAtTick: operation.launchedAtTick, landedAtTick: operation.phase === "landed" ? operation.completedAtTick : null,
      beachheadOutcome: operation.beachheadOutcome, beachheadTick: operation.beachheadEvaluatedAtTick,
      cancellationReason: operation.cancellationReason,
    });
  }
}

function variantMetrics(evaluations: readonly Evaluation[], operations: readonly OperationResult[]): VariantMetrics {
  const firstByDemand = firstEvaluations(evaluations);
  const threatened = evaluations.filter((item) => item.feasibility.opportunityWindow.enemyCapitalThreat === "threatened");
  return {
    evaluationLevel: decisionMetrics(evaluations), uniqueDemandLevel: decisionMetrics(firstByDemand),
    enemyCapitalThreatened: threatenedMetrics(threatened),
    downstream: {
      operationCreationCount: operations.length, uniqueDemandsWithOperation: new Set(operations.map((item) => `${item.seed}:${item.demandId}`)).size,
      launchCount: operations.filter((item) => item.launchedAtTick !== null).length,
      landingCount: operations.filter((item) => item.landedAtTick !== null).length,
      beachheadCount: operations.filter((item) => item.beachheadTick !== null).length,
      successfulBeachheadCount: operations.filter((item) => item.beachheadOutcome === "success").length,
      operationsTerminatedBecauseWarEnded: operations.filter((item) => item.cancellationReason === "war-ended").length,
      operationsTerminatedBeforeLanding: operations.filter((item) => item.cancellationReason !== null && item.landedAtTick === null).length,
    },
    admittedOperationTiming: {
      estimatedCompletionTicks: distribution(operations.map((item) => item.estimatedCompletionTicks)),
      actualRemainingWarTicks: distribution(operations.map((item) => item.actualRemainingWarTicks)),
      launchTick: distribution(operations.map((item) => item.launchedAtTick)),
      landingTick: distribution(operations.map((item) => item.landedAtTick)),
    },
  };
}

function decisionMetrics(items: readonly Evaluation[]): DecisionMetrics {
  const resolved = items.filter((item) => !item.rightCensored);
  const accepted = resolved.filter((item) => item.accepted);
  const rejected = resolved.filter((item) => !item.accepted);
  const correct = rejected.filter((item) => item.actualCompletionPossible === false).length;
  const falseRejections = rejected.filter((item) => item.actualCompletionPossible === true).length;
  return {
    totalFeasibilityEvaluations: items.length, acceptedEvaluations: items.filter((item) => item.accepted).length,
    rejectedEvaluations: items.filter((item) => !item.accepted).length, resolvedEvaluationCount: resolved.length,
    rightCensoredEvaluationCount: items.length - resolved.length, correctRejections: correct, falseRejections,
    correctRejectionRate: rejected.length ? correct / rejected.length : null, falseRejectionRate: rejected.length ? falseRejections / rejected.length : null,
    confusionMatrix: {
      acceptActualPossible: accepted.filter((item) => item.actualCompletionPossible === true).length,
      acceptActualImpossible: accepted.filter((item) => item.actualCompletionPossible === false).length,
      rejectActualPossible: falseRejections, rejectActualImpossible: correct,
    },
  };
}

function threatenedMetrics(items: readonly Evaluation[]): ThreatenedMetrics {
  const rejected = items.filter((item) => !item.accepted);
  const resolved = rejected.filter((item) => !item.rightCensored);
  const falseRejections = resolved.filter((item) => item.actualCompletionPossible === true).length;
  return { evaluationCount: items.length, rejectionCount: rejected.length, resolvedRejectionCount: resolved.length,
    correctRejectionCount: resolved.filter((item) => item.actualCompletionPossible === false).length, falseRejectionCount: falseRejections,
    falseRejectionRate: resolved.length ? falseRejections / resolved.length : null };
}

function firstEvaluations(items: readonly Evaluation[]): Evaluation[] {
  const first = new Map<string, Evaluation>();
  for (const item of items) {
    const key = `${item.seed}:${item.demandId}`;
    if (!first.has(key)) first.set(key, item);
  }
  return [...first.values()];
}

function distribution(values: readonly (number | null)[]): Distribution {
  const sorted = values.filter((value): value is number => value !== null && Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, mean: null, median: null, p90: null, p95: null, min: null, max: null };
  const percentile = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
  return { count: sorted.length, mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    median: percentile(0.5), p90: percentile(0.9), p95: percentile(0.95), min: sorted[0]!, max: sorted.at(-1)! };
}

function compareVariants(variants: Record<string, VariantResult>): {
  falseRejectionReduction: Record<string, number | null>;
  newlyAdmitted: Record<string, NewlyAdmittedSummary>;
  launchDelta: Record<string, number>;
  landingDelta: Record<string, number>;
  beachheadDelta: Record<string, number>;
  representativeCases: { beneficialRelaxations: NewlyAdmittedCase[]; harmfulRelaxations: NewlyAdmittedCase[] };
} {
  const baseline = variants["baseline-360"]!;
  const falseBaseline = baseline.metrics.evaluationLevel.falseRejections;
  const falseRejectionReduction: Record<string, number | null> = {};
  const newlyAdmitted: Record<string, NewlyAdmittedSummary> = {};
  const launchDelta: Record<string, number> = {};
  const landingDelta: Record<string, number> = {};
  const beachheadDelta: Record<string, number> = {};
  const beneficialRelaxations: NewlyAdmittedCase[] = [];
  const harmfulRelaxations: NewlyAdmittedCase[] = [];
  for (const policy of VARIANTS.filter((item) => item !== "baseline-360")) {
    const variant = variants[policy]!;
    falseRejectionReduction[policy] = falseBaseline - variant.metrics.evaluationLevel.falseRejections;
    const cases = newlyAdmittedCases(baseline, variant);
    newlyAdmitted[policy] = summarizeNewlyAdmitted(cases);
    launchDelta[policy] = variant.metrics.downstream.launchCount - baseline.metrics.downstream.launchCount;
    landingDelta[policy] = variant.metrics.downstream.landingCount - baseline.metrics.downstream.landingCount;
    beachheadDelta[policy] = variant.metrics.downstream.successfulBeachheadCount - baseline.metrics.downstream.successfulBeachheadCount;
    beneficialRelaxations.push(...cases.filter((item) => item.classification === "beneficial relaxation").slice(0, 3));
    harmfulRelaxations.push(...cases.filter((item) => item.classification === "harmful relaxation").slice(0, 3));
  }
  return { falseRejectionReduction, newlyAdmitted, launchDelta, landingDelta, beachheadDelta,
    representativeCases: { beneficialRelaxations: beneficialRelaxations.slice(0, 6), harmfulRelaxations: harmfulRelaxations.slice(0, 6) } };
}

interface NewlyAdmittedCase {
  policy: string; seed: number; demandId: string; evaluationTick: number;
  classification: "beneficial relaxation" | "harmful relaxation" | "right censored";
  baseline: Evaluation; variant: Evaluation; operation: OperationResult | null;
}

interface NewlyAdmittedSummary { count: number; beneficialRelaxationCount: number; harmfulRelaxationCount: number; rightCensoredCount: number }

function newlyAdmittedCases(baseline: VariantResult, variant: VariantResult): NewlyAdmittedCase[] {
  const baselineByKey = new Map(baseline.evaluations.map((item) => [`${item.seed}:${item.demandId}:${item.evaluationTick}`, item]));
  const operationsByDemand = new Map(variant.operations.map((item) => [`${item.seed}:${item.demandId}`, item]));
  const cases: NewlyAdmittedCase[] = [];
  for (const evaluation of variant.evaluations) {
    const prior = baselineByKey.get(`${evaluation.seed}:${evaluation.demandId}:${evaluation.evaluationTick}`);
    if (!prior || prior.accepted || !evaluation.accepted) continue;
    const classification = evaluation.rightCensored ? "right censored"
      : evaluation.actualCompletionPossible ? "beneficial relaxation" : "harmful relaxation";
    cases.push({ policy: variant.policy, seed: evaluation.seed, demandId: evaluation.demandId, evaluationTick: evaluation.evaluationTick,
      classification, baseline: prior, variant: evaluation, operation: operationsByDemand.get(`${evaluation.seed}:${evaluation.demandId}`) ?? null });
  }
  return cases;
}

function summarizeNewlyAdmitted(cases: readonly NewlyAdmittedCase[]): NewlyAdmittedSummary {
  return { count: cases.length, beneficialRelaxationCount: cases.filter((item) => item.classification === "beneficial relaxation").length,
    harmfulRelaxationCount: cases.filter((item) => item.classification === "harmful relaxation").length,
    rightCensoredCount: cases.filter((item) => item.classification === "right censored").length };
}
