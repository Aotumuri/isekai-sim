import { mkdir, writeFile } from "node:fs/promises";
import { setAmphibiousDiagnosticObserver, type AmphibiousLaunchFeasibilityDiagnostic } from "../../src/sim/amphibious";
import { FAST_TICK_MS, SLOW_TICK_MS } from "../../src/sim/time";
import { stepFastTick, stepSlowTick } from "../../src/sim/update";
import type { WorldState } from "../../src/sim/world-state";
import type { WarState } from "../../src/sim/war-state";
import { createScenarioWorld } from "../scenarios";

const FIRST_SEED = 822_748_319_788;
const DEFAULT_SEED_COUNT = 30;
const SEED_COUNT = Number(process.env.STRATEGIC_WINDOW_COMPONENT_SEED_COUNT ?? DEFAULT_SEED_COUNT);
const FAST_TICKS = 3_200;
const OUTPUT_PATH = "diagnostics/strategic-window-component-report.json";

type Termination = "attacker surrendered" | "defender surrendered" | "other" | null;
interface WarInstance { id: string; seed: number; warId: string; creationTick: number; endTick: number | null; attacker: string; defender: string; nationA: string; nationB: string; termination: Termination }
interface Step { component: string; input: number | string | null; modifierOrCap: number | null; beforeTicks: number; afterTicks: number }
interface Evaluation {
  seed: number; evaluationTick: number; demandId: string; operationKind: string; departurePort: string; targetRegion: string;
  attacker: string; defender: string; warInstanceId: string | null; warId: string | null; warCreationTick: number | null; warEndTick: number | null;
  terminationMechanism: Termination; resolved: boolean; rightCensored: boolean; associationValid: boolean; invalidAssociationReason: string | null;
  estimatedAssemblyTicks: number; estimatedTransportDelayTicks: number; estimatedEscortDelayTicks: number; estimatedEmbarkationTicks: number; estimatedVoyageTicks: number; estimatedLandingTicks: number; estimatedCompletionTicks: number;
  predictedWindowTicks: number; safetyMarginTicks: number; feasibility: AmphibiousLaunchFeasibilityDiagnostic; windowSteps: Step[];
  actualRemainingWarTicks: number | null; predictionError: number | null; completionMarginPredicted: number; completionMarginActual: number | null;
  classification: "true accept" | "false accept" | "right censored" | "invalid association";
  counterfactualWindows: Record<string, number>;
}
interface Dist { count: number; mean: number | null; median: number | null; p90: number | null; p95: number | null; min: number | null; max: number | null }

const originalInfo = console.info;
console.info = () => undefined;
const evaluations: Evaluation[] = [];
const instances: WarInstance[] = [];
try { for (let index = 0; index < SEED_COUNT; index += 1) runSeed(FIRST_SEED + index, evaluations, instances); }
finally { console.info = originalInfo; setAmphibiousDiagnosticObserver(null); }

const resolved = resolve(evaluations, new Map(instances.map((item) => [item.id, item])));
const attributionValidation = attribution(resolved, instances);
const valid = attributionValidation.reportValid;
const summary = summarize(resolved);
const counterfactuals = counterfactualSummary(resolved.filter((item) => item.associationValid && item.resolved));
await mkdir("diagnostics", { recursive: true });
await writeFile(OUTPUT_PATH, `${JSON.stringify({
  experiment: { scenario: "active-war", seeds: { first: FIRST_SEED, count: SEED_COUNT }, resolution: { width: 1_920, height: 1_080 }, speed: 32, fastTicks: FAST_TICKS, policy: "baseline-360" },
  attributionValidation, summary, distributions: distributions(resolved), componentImpact: componentImpact(resolved.filter((item) => item.classification === "false accept"), counterfactuals), counterfactuals,
  representativeCases: representatives(resolved), acceptedEvaluations: resolved,
  calibrationConclusionsValid: valid,
}, null, 2)}\n`, "utf8");
console.log(`Strategic-window component diagnostic complete: ${OUTPUT_PATH}`);

function runSeed(seed: number, result: Evaluation[], allInstances: WarInstance[]): void {
  const world = createScenarioWorld("active-war", { seed, width: 1_920, height: 1_080, quick: false, reserveEnabled: true, reorganizationEnabled: true, exploitationEnabled: true, pocketReductionEnabled: true });
  const registry = new Map<string, WarInstance>();
  let previousTerritory = territory(world);
  observeWars(world, seed, registry, previousTerritory);
  setAmphibiousDiagnosticObserver({ onOperationConnection(event) {
    if (event.stage !== "operation-creation" || event.launchFeasibility?.reason !== null) return;
    const demand = world.amphibiousOperations.capabilityDemands.find((item) => item.id === event.demandId);
    if (!demand) return;
    const matches = world.wars.filter((war) => pairMatches(war, demand.nationId, demand.enemyNationId));
    const war = matches.length === 1 ? matches[0]! : null;
    const instance = war ? registry.get(instanceId(seed, war)) ?? null : null;
    result.push(evaluation(seed, event.tick, demand, war, instance, matches.length, event.launchFeasibility));
  } });
  for (let tick = 0; tick < FAST_TICKS; tick += 1) {
    stepFastTick(world, FAST_TICK_MS); observeWars(world, seed, registry, previousTerritory); previousTerritory = territory(world);
    const dueSlowTicks = Math.floor(world.time.elapsedMs / SLOW_TICK_MS);
    while (world.time.slowTick < dueSlowTicks) { stepSlowTick(world, SLOW_TICK_MS); observeWars(world, seed, registry, previousTerritory); previousTerritory = territory(world); }
  }
  allInstances.push(...registry.values());
}

function evaluation(seed: number, tick: number, demand: WorldState["amphibiousOperations"]["capabilityDemands"][number], war: WarState | null, instance: WarInstance | null, matchCount: number, feasibility: AmphibiousLaunchFeasibilityDiagnostic): Evaluation {
  const reason = matchCount === 0 ? "no-active-war-for-demand-pair" : matchCount > 1 ? "ambiguous-active-war-pair" : !instance ? "active-war-instance-not-registered" : null;
  const steps = windowSteps(feasibility);
  return {
    seed, evaluationTick: tick, demandId: demand.id, operationKind: demand.kind, departurePort: demand.departurePortId, targetRegion: demand.destinationPortId,
    attacker: war?.aggressorId ?? demand.nationId, defender: war?.defenderId ?? demand.enemyNationId,
    warInstanceId: instance?.id ?? null, warId: war?.id ?? null, warCreationTick: instance?.creationTick ?? null, warEndTick: null,
    terminationMechanism: null, resolved: false, rightCensored: true, associationValid: reason === null, invalidAssociationReason: reason,
    estimatedAssemblyTicks: feasibility.estimatedAssemblyTicks, estimatedTransportDelayTicks: feasibility.estimatedTransportDelayTicks, estimatedEscortDelayTicks: feasibility.estimatedEscortDelayTicks,
    estimatedEmbarkationTicks: feasibility.estimatedEmbarkationTicks, estimatedVoyageTicks: feasibility.estimatedVoyageTicks, estimatedLandingTicks: feasibility.estimatedLandingTicks,
    estimatedCompletionTicks: feasibility.estimatedCompletionTicks, predictedWindowTicks: feasibility.opportunityWindowTicks, safetyMarginTicks: feasibility.safetyMarginTicks,
    feasibility, windowSteps: steps, actualRemainingWarTicks: null, predictionError: null, completionMarginPredicted: feasibility.safetyMarginTicks,
    completionMarginActual: null, classification: reason ? "invalid association" : "right censored", counterfactualWindows: counterfactualWindows(feasibility),
  };
}

function windowSteps(f: AmphibiousLaunchFeasibilityDiagnostic): Step[] {
  const w = f.opportunityWindow;
  const base = 120;
  return [
    { component: "surrender-resistance-expansion", input: w.resistance, modifierOrCap: null, beforeTicks: base, afterTicks: w.resistanceWindowTicks ?? base },
    { component: "war-age-cap", input: w.warAgeTicks, modifierOrCap: w.ageWindowTicks, beforeTicks: w.resistanceWindowTicks ?? base, afterTicks: w.afterAgeCapTicks ?? w.resistanceWindowTicks ?? base },
    { component: "strategic-progress-multiplier", input: w.strategicProgressScore, modifierOrCap: w.strategicProgressMultiplier, beforeTicks: w.afterAgeCapTicks ?? base, afterTicks: w.afterStrategicProgressTicks ?? w.afterAgeCapTicks ?? base },
    { component: "active-land-offensive-multiplier", input: w.activeLandOffensiveCount, modifierOrCap: w.activeLandOffensiveMultiplier, beforeTicks: w.afterStrategicProgressTicks ?? base, afterTicks: w.afterActiveLandOffensiveTicks ?? w.afterStrategicProgressTicks ?? base },
    { component: `enemy-capital-${w.enemyCapitalThreat ?? "none"}-cap`, input: w.enemyCapitalThreat, modifierOrCap: capitalCap(w.enemyCapitalThreat, "enemy"), beforeTicks: w.afterActiveLandOffensiveTicks ?? base, afterTicks: w.afterEnemyCapitalCapTicks ?? w.afterActiveLandOffensiveTicks ?? base },
    { component: `own-capital-${w.ownCapitalThreat ?? "none"}-cap`, input: w.ownCapitalThreat, modifierOrCap: capitalCap(w.ownCapitalThreat, "own"), beforeTicks: w.afterEnemyCapitalCapTicks ?? base, afterTicks: w.afterOwnCapitalCapTicks ?? w.afterEnemyCapitalCapTicks ?? base },
  ];
}

function capitalCap(threat: string | null, side: "enemy" | "own"): number | null {
  if (threat === "critical") return side === "enemy" ? 180 : 120;
  if (threat === "threatened") return side === "enemy" ? 360 : 300;
  return null;
}

function counterfactualWindows(f: AmphibiousLaunchFeasibilityDiagnostic): Record<string, number> {
  const w = f.opportunityWindow;
  const afterAge = (value: number) => Math.min(value, w.ageWindowTicks ?? value);
  const afterProgress = (value: number, neutral = false) => Math.round(value * (neutral ? 1 : w.strategicProgressMultiplier ?? 1));
  const afterOffensive = (value: number, neutral = false) => Math.round(value * (neutral ? 1 : w.activeLandOffensiveMultiplier ?? 1));
  const caps = (value: number, enemy = true, own = true) => Math.min(value,
    enemy ? capitalCap(w.enemyCapitalThreat, "enemy") ?? value : value,
    own ? capitalCap(w.ownCapitalThreat, "own") ?? value : value);
  const base = w.resistanceWindowTicks ?? 120;
  const complete = (start: number, disableAge = false, neutralProgress = false, neutralOffensive = false, enemyCap = true, ownCap = true) =>
    caps(afterOffensive(afterProgress(disableAge ? start : afterAge(start), neutralProgress), neutralOffensive), enemyCap, ownCap);
  return {
    actual: w.finalWindowTicks,
    noSurrenderResistanceExpansion: complete(120),
    noWarAgeCap: complete(base, true),
    noStrategicProgressMultiplier: complete(base, false, true),
    noActiveOffensiveMultiplier: complete(base, false, false, true),
    noCapitalThreatCaps: complete(base, false, false, false, false, false),
    strategicProgressMultiplierCappedAtOne: complete(base, false, true),
    activeOffensiveMultiplierCappedAtOne: complete(base, false, false, true),
    bothPositiveMultipliersCappedAtOne: complete(base, false, true, true),
  };
}

function observeWars(world: WorldState, seed: number, registry: Map<string, WarInstance>, priorTerritory: Map<string, number>): void {
  const active = new Set<string>(); const currentTerritory = territory(world);
  for (const war of world.wars) { const id = instanceId(seed, war); active.add(id); if (!registry.has(id)) registry.set(id, { id, seed, warId: war.id, creationTick: war.startedAtFastTick, endTick: null, attacker: war.aggressorId, defender: war.defenderId, nationA: war.nationAId, nationB: war.nationBId, termination: null }); }
  for (const item of registry.values()) if (item.endTick === null && !active.has(item.id)) {
    item.endTick = world.time.fastTick;
    item.termination = (priorTerritory.get(item.attacker) ?? 0) > 0 && (currentTerritory.get(item.attacker) ?? 0) === 0 ? "attacker surrendered"
      : (priorTerritory.get(item.defender) ?? 0) > 0 && (currentTerritory.get(item.defender) ?? 0) === 0 ? "defender surrendered" : "other";
  }
}

function territory(world: WorldState): Map<string, number> { const result = new Map<string, number>(); for (const macro of world.macroRegions) result.set(macro.nationId, (result.get(macro.nationId) ?? 0) + 1); return result; }
function instanceId(seed: number, war: WarState): string { return `${seed}:${war.id}:${war.startedAtFastTick}:${war.aggressorId}:${war.defenderId}`; }
function pairMatches(war: WarState, a: string, b: string): boolean { return war.nationAId === a && war.nationBId === b || war.nationAId === b && war.nationBId === a; }

function resolve(items: Evaluation[], byId: Map<string, WarInstance>): Evaluation[] {
  for (const item of items) {
    const instance = item.warInstanceId ? byId.get(item.warInstanceId) : undefined;
    if (!instance) continue;
    item.warEndTick = instance.endTick; item.terminationMechanism = instance.termination;
    if (!item.associationValid || instance.endTick === null) continue;
    const remaining = instance.endTick - item.evaluationTick;
    if (remaining < 0) { item.associationValid = false; item.invalidAssociationReason = "negative-remaining-war-duration"; item.classification = "invalid association"; continue; }
    item.resolved = true; item.rightCensored = false; item.actualRemainingWarTicks = remaining; item.predictionError = item.predictedWindowTicks - remaining; item.completionMarginActual = remaining - item.estimatedCompletionTicks;
    item.classification = item.completionMarginActual >= 0 ? "true accept" : "false accept";
  }
  return items;
}

function attribution(items: readonly Evaluation[], wars: readonly WarInstance[]): Record<string, number | boolean> & { reportValid: boolean } {
  const before = items.filter((item) => item.warCreationTick !== null && item.evaluationTick < item.warCreationTick).length;
  const after = items.filter((item) => item.warEndTick !== null && item.resolved && item.evaluationTick > item.warEndTick).length;
  const negative = items.filter((item) => item.invalidAssociationReason === "negative-remaining-war-duration").length;
  const unmatched = items.filter((item) => item.invalidAssociationReason === "no-active-war-for-demand-pair").length;
  const ambiguous = items.filter((item) => item.invalidAssociationReason === "ambiguous-active-war-pair").length;
  const reused = group(wars, (item) => `${item.seed}:${item.warId}`).filter(([, values]) => values.length > 1).length;
  const reportValid = before === 0 && after === 0 && negative === 0 && unmatched === 0 && ambiguous === 0;
  return { reportValid, evaluationBeforeWarCreationCount: before, evaluationAfterWarEndCount: after, negativeRemainingWarCount: negative, unmatchedAcceptedEvaluationCount: unmatched, ambiguousWarInstanceMatchCount: ambiguous, reusedWarIdLifetimeCount: reused };
}

function summarize(items: readonly Evaluation[]): object {
  const resolved = items.filter((item) => item.associationValid && item.resolved); const truth = resolved.filter((item) => item.classification === "true accept"); const falseAccepts = resolved.filter((item) => item.classification === "false accept");
  return { acceptedCount: items.length, resolvedCount: resolved.length, rightCensoredCount: items.filter((item) => item.associationValid && item.rightCensored).length, trueAccepts: truth.length, falseAccepts: falseAccepts.length, falseAcceptanceRate: resolved.length ? falseAccepts.length / resolved.length : null };
}

function distributions(items: readonly Evaluation[]): object {
  const resolved = items.filter((item) => item.associationValid && item.resolved); const truth = resolved.filter((item) => item.classification === "true accept"); const falseAccepts = resolved.filter((item) => item.classification === "false accept");
  return { trueAccepts: distributionSet(truth), falseAccepts: distributionSet(falseAccepts), components: componentDistributions(resolved) };
}
function distributionSet(items: readonly Evaluation[]): object { return { predictedWindowTicks: dist(items.map((item) => item.predictedWindowTicks)), actualRemainingWarTicks: dist(items.map((item) => item.actualRemainingWarTicks)), predictionError: dist(items.map((item) => item.predictionError)), estimatedCompletionTicks: dist(items.map((item) => item.estimatedCompletionTicks)), completionMarginPredicted: dist(items.map((item) => item.completionMarginPredicted)), completionMarginActual: dist(items.map((item) => item.completionMarginActual)) }; }
function componentDistributions(items: readonly Evaluation[]): Record<string, Dist> { const result: Record<string, number[]> = {}; for (const item of items) for (const step of item.windowSteps) { const list = result[`${step.component}:effect`] ?? []; list.push(step.afterTicks - step.beforeTicks); result[`${step.component}:effect`] = list; } return Object.fromEntries(Object.entries(result).map(([key, values]) => [key, dist(values)])); }

function counterfactualSummary(items: readonly Evaluation[]): Record<string, object> {
  const names = Object.keys(items[0]?.counterfactualWindows ?? {}); const result: Record<string, object> = {};
  for (const name of names) {
    const admitted = items.filter((item) => item.counterfactualWindows[name]! >= item.estimatedCompletionTicks); const falseAccepts = items.filter((item) => item.classification === "false accept"); const truth = items.filter((item) => item.classification === "true accept");
    const prevented = falseAccepts.filter((item) => item.counterfactualWindows[name]! < item.estimatedCompletionTicks).length; const lost = truth.filter((item) => item.counterfactualWindows[name]! < item.estimatedCompletionTicks).length;
    const admittedResolved = admitted.length; const admittedFalse = admitted.filter((item) => item.classification === "false accept").length;
    result[name] = { resolvedAcceptedCases: items.length, acceptedUnderCounterfactual: admittedResolved, falseAcceptsPrevented: prevented, trueAcceptsLost: lost, resultingFalseAcceptanceRate: admittedResolved ? admittedFalse / admittedResolved : null, precision: admittedResolved ? (admittedResolved - admittedFalse) / admittedResolved : null };
  }
  return result;
}

function componentImpact(falseAccepts: readonly Evaluation[], counterfactuals: Record<string, object>): object[] {
  const mapping: Record<string, string> = { "surrender-resistance-expansion": "noSurrenderResistanceExpansion", "war-age-cap": "noWarAgeCap", "strategic-progress-multiplier": "noStrategicProgressMultiplier", "active-land-offensive-multiplier": "noActiveOffensiveMultiplier", "capital-threat-caps": "noCapitalThreatCaps" };
  return Object.entries(mapping).map(([component, counterfactual]) => { const effects = falseAccepts.flatMap((item) => item.windowSteps.filter((step) => step.component === component || component === "capital-threat-caps" && step.component.includes("capital")).map((step) => step.afterTicks - step.beforeTicks)); const cf = counterfactuals[counterfactual] as { falseAcceptsPrevented?: number; trueAcceptsLost?: number } | undefined; return { component, falseAcceptsAffected: effects.filter((effect) => effect !== 0).length, observedWindowEffect: dist(effects), falseAcceptsPreventedIfNeutralized: cf?.falseAcceptsPrevented ?? 0, trueAcceptsLostIfNeutralized: cf?.trueAcceptsLost ?? 0, interactionNote: "Single-component counterfactuals retain the recorded order and all other modifiers; caps can interact non-additively." }; });
}

function representatives(items: readonly Evaluation[]): object { const falseAccepts = items.filter((item) => item.classification === "false accept"); const truth = items.filter((item) => item.classification === "true accept"); const flips = falseAccepts.filter((item) => Object.entries(item.counterfactualWindows).some(([name, value]) => name !== "actual" && value < item.estimatedCompletionTicks)); return { largestFalseAcceptPredictionErrors: [...falseAccepts].sort((a, b) => (b.predictionError ?? -Infinity) - (a.predictionError ?? -Infinity)).slice(0, 10), smallestNegativeActualMargins: [...falseAccepts].sort((a, b) => (b.completionMarginActual ?? -Infinity) - (a.completionMarginActual ?? -Infinity)).slice(0, 10), trueAcceptsNearBoundary: [...truth].sort((a, b) => Math.abs(a.completionMarginActual ?? Infinity) - Math.abs(b.completionMarginActual ?? Infinity)).slice(0, 10), singleComponentDecisionFlips: flips.slice(0, 10) }; }

function group<T>(items: readonly T[], key: (item: T) => string): Array<[string, T[]]> { const map = new Map<string, T[]>(); for (const item of items) { const k = key(item); const values = map.get(k) ?? []; values.push(item); map.set(k, values); } return [...map]; }
function dist(values: readonly (number | null)[]): Dist { const sorted = values.filter((value): value is number => value !== null && Number.isFinite(value)).sort((a, b) => a - b); if (!sorted.length) return { count: 0, mean: null, median: null, p90: null, p95: null, min: null, max: null }; const p = (n: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * n) - 1)]!; return { count: sorted.length, mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length, median: p(.5), p90: p(.9), p95: p(.95), min: sorted[0]!, max: sorted.at(-1)! }; }
