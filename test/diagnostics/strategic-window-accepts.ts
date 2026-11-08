import { mkdir, writeFile } from "node:fs/promises";
import { WORLD_BALANCE } from "../../src/data/balance";
import { setAmphibiousDiagnosticObserver, type AmphibiousLaunchFeasibilityDiagnostic, type AmphibiousOperation } from "../../src/sim/amphibious";
import { getCapitalDefenseAssessment } from "../../src/sim/capital-defense";
import { getUnitCombatStrength } from "../../src/sim/unit-strength";
import { FAST_TICK_MS, SLOW_TICK_MS } from "../../src/sim/time";
import { stepFastTick, stepSlowTick } from "../../src/sim/update";
import { getMesoById } from "../../src/sim/world-cache";
import type { WorldState } from "../../src/sim/world-state";
import type { WarState } from "../../src/sim/war-state";
import type { NationId } from "../../src/worldgen/nation";
import { createScenarioWorld } from "../scenarios";

const FIRST_SEED = 822_748_319_788;
const DEFAULT_SEED_COUNT = 30;
const SEED_COUNT = Number(process.env.STRATEGIC_WINDOW_ACCEPTS_SEED_COUNT ?? DEFAULT_SEED_COUNT);
const FAST_TICKS = 3_200;
const HISTORY_TICKS = 100;
const HISTORY_SAMPLE_INTERVAL_TICKS = 20;
const OUTPUT_PATH = "diagnostics/strategic-window-acceptance-report.json";

type TerminationMechanism = "attacker surrendered" | "defender surrendered" | "war ended through nation elimination" | "other";
type Threat = "none" | "threatened" | "critical";

interface WarOutcome { endTick: number; terminationMechanism: TerminationMechanism }

interface NationState {
  tick: number;
  surrenderScore: number;
  occupationLossContribution: number;
  capitalFallContribution: number;
  cityLossContribution: number;
  unitLossContribution: number;
  cooperationMultiplier: number;
  landUnitCount: number;
  landCombatStrength: number;
  controlledTerritoryRatio: number;
  cityCount: number;
  capitalThreat: Threat;
  majorSupplyStatus: null;
}

interface Velocity {
  windowTicks: number;
  surrenderScoreChange: number | null;
  controlledTerritoryRatioChange: number | null;
  landCombatStrengthChange: number | null;
  cityCountChange: number | null;
  capitalThreatChanged: boolean | null;
}

interface AcceptedEvaluation {
  seed: number;
  warId: string;
  demandId: string;
  evaluationTick: number;
  attacker: string;
  defender: string;
  launchingNationId: string;
  targetNationId: string;
  estimatedCompletionTicks: number;
  estimatedVoyageTicks: number;
  routeSegmentCount: number;
  predictedWindowTicks: number;
  safetyMarginTicks: number;
  feasibility: AmphibiousLaunchFeasibilityDiagnostic;
  launchingSideState: NationState;
  targetSideState: NationState;
  warAttackerState: NationState;
  warDefenderState: NationState;
  launchingSideVelocity100: Velocity;
  targetSideVelocity100: Velocity;
  warAttackerVelocity100: Velocity;
  warDefenderVelocity100: Velocity;
  actualWarEndTick: number | null;
  actualRemainingWarTicks: number | null;
  rightCensored: boolean;
  actualCompletionPossible: boolean | null;
  terminationMechanism: TerminationMechanism | null;
  terminationSide: "attacker" | "defender" | "other" | "unknown";
  operation: OperationOutcome | null;
  rootCause: string | null;
}

interface OperationOutcome {
  operationCreated: boolean;
  launchTick: number | null;
  landingTick: number | null;
  beachheadTick: number | null;
  cancellationTick: number | null;
  cancellationReason: string | null;
  landedBeforeWarEndDespiteEstimate: boolean | null;
}

interface History { initialLandMesoCount: Map<string, number>; entries: Map<string, NationState[]> }

const originalInfo = console.info;
console.info = () => undefined;
const accepted: AcceptedEvaluation[] = [];
try {
  for (let index = 0; index < SEED_COUNT; index += 1) runSeed(FIRST_SEED + index, accepted);
} finally {
  console.info = originalInfo;
  setAmphibiousDiagnosticObserver(null);
}

const summary = summarize(accepted);
await mkdir("diagnostics", { recursive: true });
await writeFile(OUTPUT_PATH, `${JSON.stringify({
  experiment: { scenario: "active-war", seeds: { first: FIRST_SEED, count: SEED_COUNT }, resolution: { width: 1_920, height: 1_080 }, speed: 32, fastTicks: FAST_TICKS,
    history: { windowTicks: HISTORY_TICKS, sampleIntervalTicks: HISTORY_SAMPLE_INTERVAL_TICKS, sampling: "bounded in-memory nation snapshots" }, policy: "baseline-360" },
  summary,
  acceptedEvaluations: accepted,
  representativeFalseAcceptances: accepted.filter((item) => item.actualCompletionPossible === false).slice(0, 10),
  representativeTrueAcceptances: accepted.filter((item) => item.actualCompletionPossible === true).slice(0, 10),
}, null, 2)}\n`, "utf8");
console.log(`Strategic-window acceptance diagnostic complete: ${OUTPUT_PATH}`);

function runSeed(seed: number, destination: AcceptedEvaluation[]): void {
  const world = createScenarioWorld("active-war", { seed, width: 1_920, height: 1_080, quick: false,
    reserveEnabled: true, reorganizationEnabled: true, exploitationEnabled: true, pocketReductionEnabled: true });
  const history = createHistory(world);
  sampleHistory(world, history);
  const knownWars = new Map<string, WarState>();
  const outcomes = new Map<string, WarOutcome>();
  let priorCounts = nationLandCounts(world);
  trackWars(world, knownWars, outcomes, priorCounts);
  setAmphibiousDiagnosticObserver({ onOperationConnection(event) {
    if (event.stage !== "operation-creation" || event.launchFeasibility?.reason !== null) return;
    const demand = world.amphibiousOperations.capabilityDemands.find((item) => item.id === event.demandId);
    if (!demand) return;
    const war = world.wars.find((item) => matchesWar(item, demand.nationId, demand.enemyNationId));
    if (!war) return;
    const launchingSideState = nationState(world, demand.nationId, history.initialLandMesoCount, event.tick);
    const targetSideState = nationState(world, demand.enemyNationId, history.initialLandMesoCount, event.tick);
    const launchingSideVelocity100 = velocity(history.entries.get(demand.nationId) ?? [], launchingSideState);
    const targetSideVelocity100 = velocity(history.entries.get(demand.enemyNationId) ?? [], targetSideState);
    const launchesAsWarAttacker = demand.nationId === war.aggressorId;
    destination.push({
      seed, warId: war.id, demandId: demand.id, evaluationTick: event.tick, attacker: war.aggressorId, defender: war.defenderId,
      launchingNationId: demand.nationId, targetNationId: demand.enemyNationId,
      estimatedCompletionTicks: event.launchFeasibility.estimatedCompletionTicks, estimatedVoyageTicks: event.launchFeasibility.estimatedVoyageTicks,
      routeSegmentCount: event.launchFeasibility.routeSegmentCount, predictedWindowTicks: event.launchFeasibility.opportunityWindowTicks,
      safetyMarginTicks: event.launchFeasibility.safetyMarginTicks, feasibility: event.launchFeasibility,
      launchingSideState, targetSideState,
      warAttackerState: launchesAsWarAttacker ? launchingSideState : targetSideState,
      warDefenderState: launchesAsWarAttacker ? targetSideState : launchingSideState,
      launchingSideVelocity100, targetSideVelocity100,
      warAttackerVelocity100: launchesAsWarAttacker ? launchingSideVelocity100 : targetSideVelocity100,
      warDefenderVelocity100: launchesAsWarAttacker ? targetSideVelocity100 : launchingSideVelocity100,
      actualWarEndTick: null, actualRemainingWarTicks: null, rightCensored: true, actualCompletionPossible: null,
      terminationMechanism: null, terminationSide: "unknown", operation: null, rootCause: null,
    });
  } });
  for (let tick = 0; tick < FAST_TICKS; tick += 1) {
    stepFastTick(world, FAST_TICK_MS);
    trackWars(world, knownWars, outcomes, priorCounts);
    priorCounts = nationLandCounts(world);
    if (world.time.fastTick % HISTORY_SAMPLE_INTERVAL_TICKS === 0) sampleHistory(world, history);
    const dueSlowTicks = Math.floor(world.time.elapsedMs / SLOW_TICK_MS);
    while (world.time.slowTick < dueSlowTicks) {
      stepSlowTick(world, SLOW_TICK_MS);
      trackWars(world, knownWars, outcomes, priorCounts);
      priorCounts = nationLandCounts(world);
    }
  }
  resolveSeed(destination, seed, outcomes, world);
}

function createHistory(world: WorldState): History {
  const initialLandMesoCount = nationLandCounts(world);
  return { initialLandMesoCount, entries: new Map() };
}

function sampleHistory(world: WorldState, history: History): void {
  for (const nation of world.nations) {
    const state = nationState(world, nation.id, history.initialLandMesoCount, world.time.fastTick);
    const entries = history.entries.get(nation.id) ?? [];
    entries.push(state);
    while (entries.length > 0 && entries[0]!.tick < world.time.fastTick - HISTORY_TICKS - HISTORY_SAMPLE_INTERVAL_TICKS) entries.shift();
    history.entries.set(nation.id, entries);
  }
}

function nationState(world: WorldState, nationId: NationId, initialLandMesoCount: Map<string, number>, tick: number): NationState {
  const nation = world.nations.find((item) => item.id === nationId);
  const meso = getMesoById(world);
  const owned = world.macroRegions.filter((macro) => macro.nationId === nationId).flatMap((macro) => macro.mesoRegionIds)
    .filter((id) => meso.get(id)?.type !== "sea");
  const occupied = owned.filter((id) => { const occupier = world.occupation.mesoById.get(id); return occupier !== undefined && occupier !== nationId; });
  const cityCount = owned.filter((id) => { const building = meso.get(id)?.building; return building === "city" || building === "capital"; }).length;
  const controlled = owned.length - occupied.length;
  const allUnits = world.units.filter((unit) => unit.nationId === nationId);
  const landUnits = allUnits.filter((unit) => unit.domain === "land");
  const surrender = WORLD_BALANCE.war.surrender;
  const cooperation = WORLD_BALANCE.war.cooperation;
  const cooperationRange = Math.max(0.0001, cooperation.max - cooperation.min);
  const normalizedCooperation = Math.max(0, Math.min(1, ((nation?.warCooperation ?? 0) - cooperation.min) / cooperationRange));
  const cooperationMultiplier = cooperation.surrenderMultiplierAtMin +
    (cooperation.surrenderMultiplierAtMax - cooperation.surrenderMultiplierAtMin) * normalizedCooperation;
  const occupationLossRatio = owned.length ? occupied.length / owned.length : 0;
  const capitalFallRatio = Math.max(0, Math.min(1, (nation?.capitalFallCount ?? 0) / Math.max(1, surrender.capitalFallMax)));
  const cityLossRatio = Math.max(0, Math.min(1, 1 - cityCount / Math.max(1, nation?.initialCityCount ?? 1)));
  const unitLossRatio = Math.max(0, Math.min(1, 1 - allUnits.length / Math.max(1, nation?.initialUnitCount ?? 1)));
  const threat = getCapitalDefenseAssessment(world, nationId)?.threatLevel ?? "none";
  return {
    tick, surrenderScore: nation?.surrenderScore ?? 0,
    occupationLossContribution: occupationLossRatio * surrender.occupationWeight,
    capitalFallContribution: capitalFallRatio * surrender.capitalFallWeight,
    cityLossContribution: cityLossRatio * surrender.cityLossWeight,
    unitLossContribution: unitLossRatio * surrender.unitLossWeight,
    cooperationMultiplier, landUnitCount: landUnits.length,
    landCombatStrength: landUnits.reduce((sum, unit) => sum + getUnitCombatStrength(unit), 0),
    controlledTerritoryRatio: controlled / Math.max(1, initialLandMesoCount.get(nationId) ?? 1), cityCount,
    capitalThreat: threat, majorSupplyStatus: null,
  };
}

function velocity(entries: readonly NationState[], current: NationState): Velocity {
  const prior = [...entries].reverse().find((entry) => entry.tick <= current.tick - HISTORY_TICKS) ?? null;
  return { windowTicks: HISTORY_TICKS, surrenderScoreChange: prior ? current.surrenderScore - prior.surrenderScore : null,
    controlledTerritoryRatioChange: prior ? current.controlledTerritoryRatio - prior.controlledTerritoryRatio : null,
    landCombatStrengthChange: prior ? current.landCombatStrength - prior.landCombatStrength : null,
    cityCountChange: prior ? current.cityCount - prior.cityCount : null,
    capitalThreatChanged: prior ? current.capitalThreat !== prior.capitalThreat : null };
}

function nationLandCounts(world: WorldState): Map<string, number> {
  const meso = getMesoById(world);
  const counts = new Map<string, number>();
  for (const macro of world.macroRegions) counts.set(macro.nationId, (counts.get(macro.nationId) ?? 0) + macro.mesoRegionIds.filter((id) => meso.get(id)?.type !== "sea").length);
  return counts;
}

function matchesWar(war: WarState, a: string, b: string): boolean { return war.nationAId === a && war.nationBId === b || war.nationAId === b && war.nationBId === a; }

function trackWars(world: WorldState, known: Map<string, WarState>, outcomes: Map<string, WarOutcome>, priorCounts: Map<string, number>): void {
  const active = new Set<string>(world.wars.map((war) => war.id));
  const currentCounts = nationLandCounts(world);
  for (const [id, war] of known) {
    if (active.has(id) || outcomes.has(id)) continue;
    const attackerGone = (priorCounts.get(war.aggressorId) ?? 0) > 0 && (currentCounts.get(war.aggressorId) ?? 0) === 0;
    const defenderGone = (priorCounts.get(war.defenderId) ?? 0) > 0 && (currentCounts.get(war.defenderId) ?? 0) === 0;
    outcomes.set(id, { endTick: world.time.fastTick, terminationMechanism: attackerGone ? "attacker surrendered" : defenderGone ? "defender surrendered" : "other" });
  }
  for (const war of world.wars) known.set(war.id, { ...war, contributionByNationId: new Map(war.contributionByNationId) });
}

function resolveSeed(records: AcceptedEvaluation[], seed: number, outcomes: Map<string, WarOutcome>, world: WorldState): void {
  const demands = new Map(world.amphibiousOperations.capabilityDemands.map((demand) => [demand.id, demand]));
  const operations = new Map(world.amphibiousOperations.operations.map((operation) => [operation.capabilityDemandId, operation]));
  for (const record of records) {
    if (record.seed !== seed || !record.rightCensored) continue;
    const outcome = outcomes.get(record.warId);
    if (outcome) {
      record.actualWarEndTick = outcome.endTick;
      record.actualRemainingWarTicks = Math.max(0, outcome.endTick - record.evaluationTick);
      record.rightCensored = false;
      record.actualCompletionPossible = record.actualRemainingWarTicks >= record.estimatedCompletionTicks;
      record.terminationMechanism = outcome.terminationMechanism;
      record.terminationSide = outcome.terminationMechanism === "attacker surrendered" ? "attacker" : outcome.terminationMechanism === "defender surrendered" ? "defender" : "other";
    }
    const operation = operations.get(record.demandId);
    record.operation = operationOutcome(operation, record.actualWarEndTick);
    if (record.actualCompletionPossible === false) record.rootCause = classifyRootCause(record);
    void demands;
  }
}

function operationOutcome(operation: AmphibiousOperation | undefined, warEndTick: number | null): OperationOutcome {
  const landedAtTick = operation?.phase === "landed" ? operation.completedAtTick : null;
  return {
    operationCreated: !!operation, launchTick: operation?.launchedAtTick ?? null, landingTick: landedAtTick,
    beachheadTick: operation?.beachheadEvaluatedAtTick ?? null,
    cancellationTick: operation?.phase === "cancelled" ? operation.completedAtTick : null,
    cancellationReason: operation?.cancellationReason ?? null,
    landedBeforeWarEndDespiteEstimate: landedAtTick !== null && warEndTick !== null ? landedAtTick < warEndTick : null,
  };
}

function classifyRootCause(record: AcceptedEvaluation): string {
  const launchingSideSurrendered = record.terminationSide === "attacker" && record.launchingNationId === record.attacker ||
    record.terminationSide === "defender" && record.launchingNationId === record.defender;
  const targetSideSurrendered = record.terminationSide === "attacker" && record.targetNationId === record.attacker ||
    record.terminationSide === "defender" && record.targetNationId === record.defender;
  if (launchingSideSurrendered) return "launching side surrendered unexpectedly";
  if (targetSideSurrendered && (record.targetSideVelocity100.surrenderScoreChange ?? 0) >= 0.1) return "target side surrendered faster than predicted";
  if (record.targetSideVelocity100.capitalThreatChanged) return "capital collapse accelerated after acceptance";
  if ((record.targetSideVelocity100.controlledTerritoryRatioChange ?? 0) <= -0.1) return "territorial collapse accelerated after acceptance";
  if ((record.targetSideVelocity100.landCombatStrengthChange ?? 0) <= -Math.max(1, record.targetSideState.landCombatStrength * 0.25)) return "unit-strength collapse accelerated after acceptance";
  if (targetSideSurrendered) return "strategic-window base estimate too large";
  if ((record.launchingSideVelocity100.surrenderScoreChange ?? 0) >= 0.1 || (record.launchingSideVelocity100.controlledTerritoryRatioChange ?? 0) <= -0.1) return "missing bilateral / own-side risk";
  return "other";
}

interface Distribution { count: number; mean: number | null; median: number | null; p90: number | null; p95: number | null; min: number | null; max: number | null }

function summarize(records: readonly AcceptedEvaluation[]): object {
  const resolved = records.filter((record) => !record.rightCensored);
  const falseAccepts = resolved.filter((record) => record.actualCompletionPossible === false);
  const trueAccepts = resolved.filter((record) => record.actualCompletionPossible === true);
  const first = firstPerDemand(records);
  const rootCauseCounts: Record<string, number> = {};
  for (const record of falseAccepts) if (record.rootCause) rootCauseCounts[record.rootCause] = (rootCauseCounts[record.rootCause] ?? 0) + 1;
  return {
    acceptedEvaluations: records.length, resolvedAcceptedEvaluations: resolved.length, rightCensoredAcceptedEvaluations: records.length - resolved.length,
    actualCompletionPossibleCount: trueAccepts.length, actualCompletionImpossibleCount: falseAccepts.length,
    falseAcceptanceRate: resolved.length ? falseAccepts.length / resolved.length : null,
    uniqueAcceptedDemands: first.length, uniqueFalseAcceptedDemands: first.filter((record) => record.actualCompletionPossible === false).length,
    terminationSide: countBy(falseAccepts, (record) => record.terminationSide),
    errorDistributions: {
      predictionErrorTicks: distribution(resolved.map((record) => record.predictedWindowTicks - record.actualRemainingWarTicks!)),
      completionSlackActual: distribution(resolved.map((record) => record.actualRemainingWarTicks! - record.estimatedCompletionTicks)),
    },
    trueVsFalseAccepts: { trueAccepts: compareSignals(trueAccepts), falseAccepts: compareSignals(falseAccepts) },
    rootCauseCounts,
  };
}

function firstPerDemand(records: readonly AcceptedEvaluation[]): AcceptedEvaluation[] {
  const first = new Map<string, AcceptedEvaluation>();
  for (const record of records) if (!first.has(`${record.seed}:${record.demandId}`)) first.set(`${record.seed}:${record.demandId}`, record);
  return [...first.values()];
}

function compareSignals(records: readonly AcceptedEvaluation[]): Record<string, Distribution | Record<string, number>> {
  return {
    predictedWindowTicks: distribution(records.map((record) => record.predictedWindowTicks)),
    estimatedCompletionTicks: distribution(records.map((record) => record.estimatedCompletionTicks)),
    safetyMarginTicks: distribution(records.map((record) => record.safetyMarginTicks)),
    enemySurrenderScore: distribution(records.map((record) => record.targetSideState.surrenderScore)),
    ownSurrenderScore: distribution(records.map((record) => record.launchingSideState.surrenderScore)),
    warAgeTicks: distribution(records.map((record) => record.feasibility.opportunityWindow.warAgeTicks)),
    recentEnemySurrenderVelocity: distribution(records.map((record) => record.targetSideVelocity100.surrenderScoreChange)),
    recentOwnSurrenderVelocity: distribution(records.map((record) => record.launchingSideVelocity100.surrenderScoreChange)),
    recentEnemyTerritoryLossVelocity: distribution(records.map((record) => record.targetSideVelocity100.controlledTerritoryRatioChange)),
    recentEnemyLandStrengthLossVelocity: distribution(records.map((record) => record.targetSideVelocity100.landCombatStrengthChange)),
    enemyCapitalThreat: countBy(records, (record) => record.targetSideState.capitalThreat),
    ownCapitalThreat: countBy(records, (record) => record.launchingSideState.capitalThreat),
  };
}

function distribution(values: readonly (number | null)[]): Distribution {
  const sorted = values.filter((value): value is number => value !== null && Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, mean: null, median: null, p90: null, p95: null, min: null, max: null };
  const p = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
  return { count: sorted.length, mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length, median: p(0.5), p90: p(0.9), p95: p(0.95), min: sorted[0]!, max: sorted.at(-1)! };
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const item of items) { const value = key(item); result[value] = (result[value] ?? 0) + 1; }
  return result;
}
