import { writeFile } from "node:fs/promises";
import { WORLD_BALANCE } from "../../src/data/balance";
import { getFrontSide, getOpposingFrontSide } from "../../src/sim/land-fronts";
import { getFrontlineCoverage } from "../../src/sim/frontline-coverage";
import type { OffensiveOperation } from "../../src/sim/offensive-operations";
import { getUnitCombatStrength } from "../../src/sim/unit-strength";
import type { WorldState } from "../../src/sim/world-state";
import { FAST_TICK_MS, SLOW_TICK_MS } from "../../src/sim/time";
import { stepFastTick, stepSlowTick } from "../../src/sim/update";
import { createScenarioWorld } from "../scenarios";
import type { BenchmarkScenarioName } from "./types";

type FailureCategory =
  | "insufficient staging"
  | "local strength collapsed"
  | "reserve recalled"
  | "target invalidated"
  | "front geometry changed"
  | "posture changed"
  | "exploitation unavailable"
  | "capital emergency"
  | "retreat"
  | "timeout"
  | "war ended"
  | "cancelled by stronger offensive"
  | "other";

interface Sample {
  tick: number;
  phase: OffensiveOperation["phase"];
  frontStrength: number;
  offensiveStrength: number;
  reserveStrength: number;
  reserveContribution: number;
  nonOffensiveFrontStrength: number;
  percentageConcentrated: number;
  defenderStrength: number;
  localSuperiorityRatio: number;
  stagedStrength: number;
  stagedFraction: number;
  readyApproaches: number;
  attackerDirections: number;
  breakthroughCount: number;
}

interface MajorOffensiveRecord {
  scenario: BenchmarkScenarioName;
  seed: number;
  operationId: string;
  nationId: string;
  enemyNationId: string;
  creationTick: number;
  selectedSector: string;
  schwerpunktSelectedTick: number | null;
  pressure: number;
  priority: number;
  plannedForce: number;
  actualStagedForce: number;
  actualStagedFraction: number;
  reserveContribution: number;
  reserveArrivalTick: number | null;
  approachCount: number;
  achievedApproachCount: number;
  preparationDuration: number | null;
  attackStartTick: number | null;
  attackEndTick: number | null;
  result: OffensiveOperation["outcome"];
  completionReason: OffensiveOperation["completionReason"];
  failureCategory: FailureCategory | null;
  frontStrengthAtCreation: number;
  offensiveStrengthAtAttack: number;
  reserveStrengthAtAttack: number;
  nonOffensiveFrontStrengthAtAttack: number;
  percentageConcentratedAtAttack: number;
  localSuperiorityAtAttack: number;
  measuredLocalSuperiorityAtAttack: number;
  minimumLocalSuperiorityDuringAttack: number;
  attackerDirections: number;
  defenderStrengthAtAttack: number;
  breakthroughCount: number;
  capturedRegions: number;
  exploitationTriggered: boolean;
  exploitationStartTick: number | null;
  offensiveDuration: number | null;
  reserveRecalledDuringOperation: boolean;
  timeline: string[];
  lastSample: Sample;
  finalPreparationSample: Sample | null;
}

interface MutableRecord extends MajorOffensiveRecord {
  lastPhase: OffensiveOperation["phase"];
  lastCapturedRegions: number;
}

const args = process.argv.slice(2);
const scenario = option("--scenario", "active-war") as BenchmarkScenarioName;
const seed = Number(option("--seed", "822748319789"));
const ticks = Number(option("--ticks", "3200"));
const output = option("--output", "");
const world = createScenarioWorld(scenario, {
  seed,
  width: 1_920,
  height: 1_080,
  quick: false,
  reserveEnabled: true,
  reorganizationEnabled: true,
  exploitationEnabled: true,
});
const records = new Map<string, MutableRecord>();
const originalInfo = console.info;
console.info = () => undefined;
try {
  for (let index = 0; index < ticks; index += 1) {
    stepFastTick(world, FAST_TICK_MS);
    sampleWorld(world, scenario, seed, records);
    const dueSlowTicks = Math.floor(world.time.elapsedMs / SLOW_TICK_MS);
    while (world.time.slowTick < dueSlowTicks) {
      stepSlowTick(world, SLOW_TICK_MS);
      sampleWorld(world, scenario, seed, records);
    }
  }
} finally {
  console.info = originalInfo;
}

const offensiveRecords = [...records.values()]
  .map(({ lastPhase: _lastPhase, lastCapturedRegions: _lastCaptured, ...record }) => record)
  .sort((a, b) => a.creationTick - b.creationTick || a.operationId.localeCompare(b.operationId));
const report = {
  scenario,
  seed,
  ticks,
  majorOffensivesLaunched: world.stalematePressure.majorOffensivesLaunched,
  majorOffensiveSuccesses: world.stalematePressure.majorOffensiveSuccesses,
  majorOffensiveFailures: world.stalematePressure.majorOffensiveFailures,
  completedRecords: offensiveRecords.filter((record) => record.result !== null).length,
  failureDistribution: countBy(
    offensiveRecords.filter((record) => record.result !== "success"),
    (record) => record.failureCategory ?? (record.result === null ? "active at end" : "other"),
  ),
  completionReasonDistribution: countBy(
    offensiveRecords.filter((record) => record.result !== "success"),
    (record) => record.completionReason ?? (record.result === null ? "active at end" : "other"),
  ),
  comparison: {
    success: summarize(offensiveRecords.filter((record) => record.result === "success")),
    failed: summarize(offensiveRecords.filter((record) => record.result !== null && record.result !== "success")),
  },
  offensives: offensiveRecords,
};
const json = `${JSON.stringify(report, null, 2)}\n`;
if (output) await writeFile(output, json, "utf8");
console.log(json);

function sampleWorld(
  state: WorldState,
  scenarioName: BenchmarkScenarioName,
  scenarioSeed: number,
  result: Map<string, MutableRecord>,
): void {
  const operations = [...state.offensiveOperations.operations, ...state.offensiveOperations.history];
  for (const operation of operations) {
    if (!operation.isMajorOffensive) continue;
    const key = operation.id as string;
    const sample = takeSample(state, operation);
    let record = result.get(key);
    if (!record) {
      const assessment = state.stalematePressure.assessments.find((item) =>
        item.nationId === operation.nationId && item.enemyNationId === operation.enemyNationId,
      );
      const plan = state.frontPlans.plansByFrontNation.get(`${operation.frontId}::${operation.nationId}`);
      record = {
        scenario: scenarioName,
        seed: scenarioSeed,
        operationId: key,
        nationId: operation.nationId,
        enemyNationId: operation.enemyNationId,
        creationTick: operation.startedAtTick,
        selectedSector: operation.frontId,
        schwerpunktSelectedTick: assessment?.selectedAtTick ?? null,
        pressure: assessment?.pressure ?? 0,
        priority: plan?.priority ?? 0,
        plannedForce: operation.initialAssignedStrength,
        actualStagedForce: sample.stagedStrength,
        actualStagedFraction: sample.stagedFraction,
        reserveContribution: sample.reserveContribution,
        reserveArrivalTick: relevantReserveArrivalTick(state, operation),
        approachCount: operation.plannedApproachRegionIds.length,
        achievedApproachCount: operation.actualActiveApproachCount,
        preparationDuration: null,
        attackStartTick: null,
        attackEndTick: null,
        result: operation.outcome,
        completionReason: operation.completionReason,
        failureCategory: null,
        frontStrengthAtCreation: sample.frontStrength,
        offensiveStrengthAtAttack: 0,
        reserveStrengthAtAttack: 0,
        nonOffensiveFrontStrengthAtAttack: 0,
        percentageConcentratedAtAttack: 0,
        localSuperiorityAtAttack: 0,
        measuredLocalSuperiorityAtAttack: 0,
        minimumLocalSuperiorityDuringAttack: Number.POSITIVE_INFINITY,
        attackerDirections: sample.attackerDirections,
        defenderStrengthAtAttack: 0,
        breakthroughCount: sample.breakthroughCount,
        capturedRegions: operation.capturedRegionIds.length,
        exploitationTriggered: operation.exploitationStartedAtTick !== null,
        exploitationStartTick: operation.exploitationStartedAtTick,
        offensiveDuration: null,
        reserveRecalledDuringOperation: reserveWasRecalled(state, operation),
        timeline: [
          `tick ${assessment?.selectedAtTick ?? operation.startedAtTick}: Schwerpunkt selected`,
          `tick ${operation.startedAtTick}: Major Offensive created; Pressure ${(assessment?.pressure ?? 0).toFixed(1)}`,
        ],
        lastSample: sample,
        finalPreparationSample: null,
        lastPhase: operation.phase,
        lastCapturedRegions: operation.capturedRegionIds.length,
      };
      result.set(key, record);
    }
    if (record.result !== null) continue;

    record.actualStagedForce = Math.max(record.actualStagedForce, sample.stagedStrength);
    record.actualStagedFraction = Math.max(record.actualStagedFraction, sample.stagedFraction);
    record.reserveContribution = Math.max(record.reserveContribution, sample.reserveContribution);
    record.reserveArrivalTick = record.reserveArrivalTick ?? relevantReserveArrivalTick(state, operation);
    record.achievedApproachCount = Math.max(record.achievedApproachCount, operation.actualActiveApproachCount);
    record.attackerDirections = Math.max(record.attackerDirections, sample.attackerDirections);
    record.breakthroughCount = Math.max(record.breakthroughCount, sample.breakthroughCount);
    record.reserveRecalledDuringOperation ||= reserveWasRecalled(state, operation);

    if (record.lastPhase === "preparing" && operation.phase !== "preparing") {
      record.finalPreparationSample = record.lastSample;
      record.attackStartTick = operation.phase === "attacking" || operation.phase === "exploiting"
        ? operation.phaseStartedAtTick
        : null;
      record.preparationDuration = record.attackStartTick === null
        ? operation.completedAtTick === null ? null : operation.completedAtTick - operation.startedAtTick
        : record.attackStartTick - operation.startedAtTick;
      if (record.attackStartTick !== null) {
        record.actualStagedForce = sample.stagedStrength;
        record.offensiveStrengthAtAttack = sample.offensiveStrength;
        record.reserveStrengthAtAttack = sample.reserveStrength;
        record.nonOffensiveFrontStrengthAtAttack = sample.nonOffensiveFrontStrength;
        record.percentageConcentratedAtAttack = sample.percentageConcentrated;
        record.localSuperiorityAtAttack = operation.localStrengthRatioAtAttack || sample.localSuperiorityRatio;
        record.measuredLocalSuperiorityAtAttack = sample.localSuperiorityRatio;
        record.defenderStrengthAtAttack = sample.defenderStrength;
        record.timeline.push(`tick ${record.attackStartTick}: Preparation complete; attack begins; local superiority ${record.localSuperiorityAtAttack.toFixed(2)}`);
      }
    }
    if (operation.phase === "attacking" || operation.phase === "exploiting") {
      record.minimumLocalSuperiorityDuringAttack = Math.min(
        record.minimumLocalSuperiorityDuringAttack,
        sample.localSuperiorityRatio,
      );
    }
    if (operation.capturedRegionIds.length > record.lastCapturedRegions) {
      record.timeline.push(`tick ${state.time.fastTick}: captured region count ${operation.capturedRegionIds.length}`);
    }
    if (!record.exploitationTriggered && operation.exploitationStartedAtTick !== null) {
      record.timeline.push(`tick ${operation.exploitationStartedAtTick}: exploitation begins`);
    }
    record.capturedRegions = Math.max(record.capturedRegions, operation.capturedRegionIds.length);
    record.exploitationTriggered ||= operation.exploitationStartedAtTick !== null;
    record.exploitationStartTick ??= operation.exploitationStartedAtTick;
    if (operation.outcome !== null && record.result === null) {
      record.result = operation.outcome;
      record.completionReason = operation.completionReason;
      record.attackEndTick = operation.completedAtTick;
      record.offensiveDuration = record.attackStartTick === null || operation.completedAtTick === null
        ? null
        : operation.completedAtTick - record.attackStartTick;
      record.failureCategory = operation.outcome === "success"
        ? null
        : classifyFailure(operation, record, sample, state);
      record.timeline.push(
        `tick ${operation.completedAtTick}: ${operation.outcome}; ${operation.completionReason}; ${record.failureCategory ?? "success"}`,
      );
    }
    record.lastPhase = operation.phase;
    record.lastCapturedRegions = operation.capturedRegionIds.length;
    record.lastSample = sample;
  }
}

function takeSample(world: WorldState, operation: OffensiveOperation): Sample {
  const front = world.landFronts.operationalSectorsById.get(operation.frontId);
  const friendly = front ? getFrontSide(front, operation.nationId) : undefined;
  const units = new Map(world.units.map((unit) => [unit.id, unit]));
  const offensiveStrength = sumStrength(operation.assignedUnitIds.map((id) => units.get(id)));
  const frontStrength = friendly?.strength ?? 0;
  const reserve = world.strategicReserves.reservesByNationId.get(operation.nationId);
  const reserveStrength = sumStrength((reserve?.unitIds ?? []).map((id) => units.get(id)));
  const deployment = reserve?.deployment?.targetFrontId === operation.frontId &&
    reserve.deployment.status !== "returning" ? reserve.deployment : undefined;
  const deploymentTargetIds = new Set(deployment?.targetRegionIds ?? []);
  const reserveContribution = sumStrength(
    (deployment?.unitIds ?? [])
      .map((id) => units.get(id))
      .filter((unit) => unit && deploymentTargetIds.has(unit.regionId)),
  );
  const staged = operation.assignedUnitIds
    .map((id) => units.get(id))
    .filter((unit) => unit && graphDistanceWithin(
      world,
      unit.regionId,
      operation.approachRegionByUnitId.get(unit.id) ?? operation.stagingRegionId,
      WORLD_BALANCE.war.landFront.offensiveOperation.stagingRadius,
    ));
  const stagedStrength = sumStrength(staged);
  const defenderStrength = currentDefenderStrength(world, operation);
  const enemyCoverage = getFrontlineCoverage(world, operation.frontId, operation.enemyNationId);
  const attackerDirections = Math.max(0, ...world.battles
    .filter((battle) => battle.attackerNationId === operation.nationId && battle.mesoId === operation.primaryTargetRegionId)
    .map((battle) => battle.attackDirectionCount));
  return {
    tick: world.time.fastTick,
    phase: operation.phase,
    frontStrength,
    offensiveStrength,
    reserveStrength,
    reserveContribution,
    nonOffensiveFrontStrength: Math.max(0, frontStrength - offensiveStrength),
    percentageConcentrated: frontStrength > 0 ? offensiveStrength / frontStrength * 100 : 0,
    defenderStrength,
    localSuperiorityRatio: offensiveStrength / Math.max(1, defenderStrength),
    stagedStrength,
    stagedFraction: operation.assignedUnitIds.length > 0 ? staged.length / operation.assignedUnitIds.length : 0,
    readyApproaches: operation.actualActiveApproachCount,
    attackerDirections,
    breakthroughCount: enemyCoverage?.breakthroughCount ?? 0,
  };
}

function currentDefenderStrength(world: WorldState, operation: OffensiveOperation): number {
  const coverage = getFrontlineCoverage(world, operation.frontId, operation.enemyNationId);
  const position = coverage?.positions.find((item) => item.friendlyRegionId === operation.primaryTargetRegionId);
  const target = world.mesoRegions.find((region) => region.id === operation.primaryTargetRegionId);
  const nearby = new Set([operation.primaryTargetRegionId, ...(target?.neighbors.map((item) => item.id) ?? [])]);
  const nearbyStrength = world.units.reduce((sum, unit) =>
    unit.domain === "land" && unit.nationId === operation.enemyNationId && nearby.has(unit.regionId)
      ? sum + getUnitCombatStrength(unit)
      : sum,
  0);
  return Math.max(position?.defenderStrength ?? 0, nearbyStrength);
}

function relevantReserveArrivalTick(world: WorldState, operation: OffensiveOperation): number | null {
  const deployment = world.strategicReserves.reservesByNationId.get(operation.nationId)?.deployment;
  return deployment?.targetFrontId === operation.frontId ? deployment.firstArrivalAtTick : null;
}

function reserveWasRecalled(world: WorldState, operation: OffensiveOperation): boolean {
  return world.strategicReserves.timeline.some((event) =>
    event.nationId === operation.nationId && event.type === "return-started" &&
    event.tick >= operation.startedAtTick && (operation.completedAtTick === null || event.tick <= operation.completedAtTick),
  );
}

function classifyFailure(
  operation: OffensiveOperation,
  record: MajorOffensiveRecord,
  sample: Sample,
  world: WorldState,
): FailureCategory {
  if (operation.completionReason === "capital-emergency") return "capital emergency";
  if (operation.completionReason === "war-ended") return "war ended";
  if (operation.completionReason === "target-invalid") return "target invalidated";
  if (operation.completionReason === "front-disappeared" || operation.completionReason === "target-unreachable") return "front geometry changed";
  if (operation.completionReason === "attack-expired") return "timeout";
  if (operation.completionReason === "posture-changed") {
    const retreatExists = world.retreatPlans.timeline.some((event) =>
      event.nationId === operation.nationId && event.tick >= operation.startedAtTick &&
      (operation.completedAtTick === null || event.tick <= operation.completedAtTick),
    );
    return retreatExists ? "retreat" : "posture changed";
  }
  if (operation.phase === "recovering" && record.attackStartTick === null && operation.completionReason === "strength-collapsed") {
    return "insufficient staging";
  }
  if (operation.completionReason === "strength-collapsed" || operation.completionReason === "force-depleted") {
    return "local strength collapsed";
  }
  if (operation.completionReason === "allocation-lost" && sample.offensiveStrength <= 0) return "other";
  return "other";
}

function summarize(items: MajorOffensiveRecord[]): Record<string, number> {
  return {
    count: items.length,
    averagePreparationDuration: average(items.map((item) => item.preparationDuration)),
    averageLocalSuperiority: average(items.map((item) => item.localSuperiorityAtAttack || null)),
    averageMeasuredLocalSuperiority: average(items.map((item) => item.measuredLocalSuperiorityAtAttack || null)),
    averageMinimumLocalSuperiority: average(items.map((item) => Number.isFinite(item.minimumLocalSuperiorityDuringAttack) ? item.minimumLocalSuperiorityDuringAttack : null)),
    reserveUsageRatePercent: percent(items.filter((item) => item.reserveContribution > 0).length, items.length),
    reserveArrivalBeforeAttackPercentOfUsers: percent(
      items.filter((item) => item.reserveContribution > 0 && item.reserveArrivalTick !== null && item.attackStartTick !== null && item.reserveArrivalTick <= item.attackStartTick).length,
      items.filter((item) => item.reserveContribution > 0).length,
    ),
    averageAttackDirections: average(items.map((item) => item.attackerDirections)),
    averageBreakthroughCount: average(items.map((item) => item.breakthroughCount)),
    averageCapturedRegions: average(items.map((item) => item.capturedRegions)),
    exploitationRatePercent: percent(items.filter((item) => item.exploitationTriggered).length, items.length),
    averageOffensiveDuration: average(items.map((item) => item.offensiveDuration)),
    averageConcentrationPercent: average(items.map((item) => item.percentageConcentratedAtAttack || null)),
    averagePlannedForce: average(items.map((item) => item.plannedForce)),
    averageActualStagedForce: average(items.map((item) => item.actualStagedForce)),
  };
}

function graphDistanceWithin(world: WorldState, start: string, target: string, maximum: number): boolean {
  if (start === target) return true;
  let frontier = [start];
  const visited = new Set(frontier);
  for (let depth = 1; depth <= maximum; depth += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      const region = world.mesoRegions.find((item) => item.id === id);
      for (const neighbor of region?.neighbors ?? []) {
        if (neighbor.id === target) return true;
        if (!visited.has(neighbor.id)) {
          visited.add(neighbor.id);
          next.push(neighbor.id);
        }
      }
    }
    frontier = next;
  }
  return false;
}

function sumStrength(units: Array<WorldState["units"][number] | undefined>): number {
  return units.reduce((sum, unit) => sum + (unit ? getUnitCombatStrength(unit) : 0), 0);
}

function average(values: Array<number | null>): number {
  const finite = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return finite.length > 0 ? finite.reduce((sum, value) => sum + value, 0) / finite.length : 0;
}

function percent(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator * 100 : 0;
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const item of items) result[key(item)] = (result[key(item)] ?? 0) + 1;
  return result;
}

function option(name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
}
