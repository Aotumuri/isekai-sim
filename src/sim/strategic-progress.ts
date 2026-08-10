import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import {
  getFrontSide,
  getOpposingFrontSide,
  type OperationalSector,
} from "./land-fronts";
import type { OffensiveOperation } from "./offensive-operations";
import type { WorldState } from "./world-state";
import { getMesoById, getOwnerByMesoId } from "./world-cache";

export type StrategicProgressReason =
  | "net-territorial-gain"
  | "sustained-frontline-displacement"
  | "persistent-breakthrough"
  | "capital-approach"
  | "operational-front-collapse"
  | "successful-operation"
  | "important-capture"
  | "successful-exploitation"
  | "pocket-closed"
  | "pocket-reduced-significantly"
  | "pocket-destroyed"
  | "meaningful-force-isolated"
  | "frontline-supply-cut"
  | "major-component-isolated"
  | "maritime-supply-cut";

export interface StrategicProgressAssessment {
  nationId: NationId;
  enemyNationId: NationId;
  score: number;
  reasonFlags: StrategicProgressReason[];
  lastProgressReasons: StrategicProgressReason[];
  lastProgressTick: number | null;
  frontlineDisplacement: number;
  netTerritorialGain: number;
  breakthroughPersistence: number;
  capitalApproach: number;
  resetsPressure: boolean;
  evaluatedAtTick: number;
}

interface StrategicProgressTracker {
  nationId: NationId;
  enemyNationId: NationId;
  baselineControllerByRegionId: Map<MesoRegionId, NationId | null>;
  baselineFriendlyBorderIds: Set<MesoRegionId>;
  baselineCapitalDistance: number | null;
  previousPhysicalFrontCount: number;
  breakthroughPersistence: number;
  evidenceUnits: number;
  lastProgressTick: number | null;
  lastProgressReasons: StrategicProgressReason[];
  seenSuccessfulOperationIds: Set<string>;
  seenSustainedCutoffOperationIds: Set<string>;
  seenPocketEventKeys: Set<string>;
}

export interface StrategicProgressState {
  assessments: StrategicProgressAssessment[];
  assessmentsByNationEnemy: Map<string, StrategicProgressAssessment>;
  trackersByNationEnemy: Map<string, StrategicProgressTracker>;
  version: number;
  evaluationCount: number;
  progressEventCount: number;
  pressureResetCount: number;
  scoreSampleTotal: number;
  scoreSampleCount: number;
  reasonCounts: Record<StrategicProgressReason, number>;
}

const REQUIRED_EVIDENCE_UNITS = 3;
const OPERATIONAL_GAIN_BASE = 2;
const DEEP_EXPLOITATION_DEPTH = 2;

export function createStrategicProgressState(): StrategicProgressState {
  return {
    assessments: [],
    assessmentsByNationEnemy: new Map(),
    trackersByNationEnemy: new Map(),
    version: 0,
    evaluationCount: 0,
    progressEventCount: 0,
    pressureResetCount: 0,
    scoreSampleTotal: 0,
    scoreSampleCount: 0,
    reasonCounts: createReasonCounts(),
  };
}

export function getStrategicProgressAssessment(
  world: WorldState,
  nationId: NationId,
  enemyNationId: NationId,
): StrategicProgressAssessment | undefined {
  return world.strategicProgress.assessmentsByNationEnemy.get(
    pairKey(nationId, enemyNationId),
  );
}

export function updateStrategicProgress(world: WorldState): void {
  const startedAt = world.instrumentation ? performance.now() : 0;
  const state = world.strategicProgress;
  const sectorsByPair = indexSectorsByPair(world);
  const nextAssessments: StrategicProgressAssessment[] = [];
  const nextTrackers = new Map<string, StrategicProgressTracker>();

  for (const key of [...sectorsByPair.keys()].sort()) {
    const sectors = sectorsByPair.get(key)!;
    const [nationId, enemyNationId] = parsePairKey(key);
    const tracker = state.trackersByNationEnemy.get(key) ??
      createTracker(world, nationId, enemyNationId, sectors);
    const assessment = evaluatePair(world, tracker, sectors);
    nextAssessments.push(assessment);
    nextTrackers.set(key, tracker);
    state.scoreSampleTotal += assessment.score;
    state.scoreSampleCount += 1;
    if (assessment.resetsPressure) {
      state.progressEventCount += 1;
      state.pressureResetCount += 1;
      for (const reason of assessment.reasonFlags) state.reasonCounts[reason] += 1;
      world.instrumentation?.incrementCounter("strategicProgress.events");
      world.instrumentation?.incrementCounter("strategicProgress.pressureResets");
    }
  }

  state.assessments = nextAssessments;
  state.assessmentsByNationEnemy = new Map(
    nextAssessments.map((assessment) => [
      pairKey(assessment.nationId, assessment.enemyNationId),
      assessment,
    ]),
  );
  state.trackersByNationEnemy = nextTrackers;
  state.evaluationCount += 1;
  state.version += 1;
  if (world.instrumentation) {
    world.instrumentation.recordDuration(
      "strategicProgress.evaluation",
      performance.now() - startedAt,
    );
  }
}

function evaluatePair(
  world: WorldState,
  tracker: StrategicProgressTracker,
  sectors: OperationalSector[],
): StrategicProgressAssessment {
  extendTrackedFrontScope(world, tracker, sectors);
  const netTerritorialGain = calculateNetTerritorialGain(world, tracker);
  const frontlineDisplacement = calculateFrontlineDisplacement(tracker, sectors);
  const meaningfulGain = Math.max(
    OPERATIONAL_GAIN_BASE,
    new Set(sectors.map((sector) => sector.physicalFrontId)).size + 1,
  );
  const enemyGapCount = sectors.reduce((sum, sector) => {
    const coverage = world.frontlineCoverage.coverageBySectorNation.get(
      `${sector.id}::${tracker.enemyNationId}`,
    );
    return sum + (coverage?.gapSegments ?? 0);
  }, 0);
  tracker.breakthroughPersistence = enemyGapCount > 0 && netTerritorialGain > 0
    ? tracker.breakthroughPersistence + 1
    : Math.max(0, tracker.breakthroughPersistence - 1);
  const capitalDistance = getPairCapitalDistance(world, tracker, sectors);
  if (tracker.baselineCapitalDistance === null && capitalDistance !== null) {
    tracker.baselineCapitalDistance = capitalDistance;
  }
  const capitalApproach = tracker.baselineCapitalDistance !== null && capitalDistance !== null
    ? Math.max(0, tracker.baselineCapitalDistance - capitalDistance)
    : 0;
  const currentPhysicalFrontCount = new Set(
    sectors.map((sector) => sector.physicalFrontId),
  ).size;
  const reasons = new Set<StrategicProgressReason>();
  let evidenceAdded = 0;

  if (netTerritorialGain >= meaningfulGain) {
    reasons.add("net-territorial-gain");
    evidenceAdded += 1;
  }
  if (frontlineDisplacement >= meaningfulGain && netTerritorialGain > 0) {
    reasons.add("sustained-frontline-displacement");
    evidenceAdded += 1;
  }
  if (tracker.breakthroughPersistence >= REQUIRED_EVIDENCE_UNITS) {
    reasons.add("persistent-breakthrough");
    evidenceAdded += 1;
  }
  if (capitalApproach > 0 && netTerritorialGain > 0) {
    reasons.add("capital-approach");
    evidenceAdded += 1;
  }
  if (
    currentPhysicalFrontCount < tracker.previousPhysicalFrontCount &&
    netTerritorialGain >= meaningfulGain
  ) {
    reasons.add("operational-front-collapse");
    evidenceAdded += 2;
  }
  if (hasImportantBaselineCapture(world, tracker)) {
    reasons.add("important-capture");
    evidenceAdded = REQUIRED_EVIDENCE_UNITS;
  }

  const operationEvidence = collectOperationEvidence(world, tracker);
  for (const reason of operationEvidence.reasons) reasons.add(reason);
  evidenceAdded += operationEvidence.evidenceUnits;
  const pocketEvidence = collectPocketEvidence(world, tracker);
  for (const reason of pocketEvidence.reasons) reasons.add(reason);
  evidenceAdded += pocketEvidence.evidenceUnits;
  tracker.previousPhysicalFrontCount = currentPhysicalFrontCount;
  tracker.evidenceUnits = evidenceAdded > 0
    ? Math.min(REQUIRED_EVIDENCE_UNITS, tracker.evidenceUnits + evidenceAdded)
    : Math.max(0, tracker.evidenceUnits - 1);

  const resetsPressure = tracker.evidenceUnits >= REQUIRED_EVIDENCE_UNITS;
  const reasonFlags = [...reasons].sort();
  const score = resetsPressure
    ? 100
    : tracker.evidenceUnits / REQUIRED_EVIDENCE_UNITS * 100;
  if (resetsPressure) {
    tracker.lastProgressTick = world.time.fastTick;
    tracker.lastProgressReasons = reasonFlags;
    rebaseTracker(world, tracker, sectors, capitalDistance);
  }

  return {
    nationId: tracker.nationId,
    enemyNationId: tracker.enemyNationId,
    score,
    reasonFlags,
    lastProgressReasons: [...tracker.lastProgressReasons],
    lastProgressTick: tracker.lastProgressTick,
    frontlineDisplacement,
    netTerritorialGain,
    breakthroughPersistence: tracker.breakthroughPersistence,
    capitalApproach,
    resetsPressure,
    evaluatedAtTick: world.time.fastTick,
  };
}

function createTracker(
  world: WorldState,
  nationId: NationId,
  enemyNationId: NationId,
  sectors: OperationalSector[],
): StrategicProgressTracker {
  const tracker: StrategicProgressTracker = {
    nationId,
    enemyNationId,
    baselineControllerByRegionId: new Map(),
    baselineFriendlyBorderIds: new Set(),
    baselineCapitalDistance: null,
    previousPhysicalFrontCount: new Set(
      sectors.map((sector) => sector.physicalFrontId),
    ).size,
    breakthroughPersistence: 0,
    evidenceUnits: 0,
    lastProgressTick: null,
    lastProgressReasons: [],
    seenSuccessfulOperationIds: new Set(),
    seenSustainedCutoffOperationIds: new Set(),
    seenPocketEventKeys: new Set(),
  };
  rebaseTracker(
    world,
    tracker,
    sectors,
    getPairCapitalDistance(world, tracker, sectors),
  );
  for (const operation of getPairOperations(world, tracker)) {
    if (operation.outcome === "success") {
      tracker.seenSuccessfulOperationIds.add(operation.id);
    }
  }
  return tracker;
}

function collectPocketEvidence(
  world: WorldState,
  tracker: StrategicProgressTracker,
): { reasons: StrategicProgressReason[]; evidenceUnits: number } {
  const reasons = new Set<StrategicProgressReason>();
  let evidenceUnits = 0;
  const active = world.battlefieldTopology.pockets.filter((pocket) =>
    pocket.attackerNationId === tracker.nationId && pocket.enemyNationId === tracker.enemyNationId
  );
  const history = world.battlefieldTopology.pocketHistory.filter((pocket) =>
    pocket.attackerNationId === tracker.nationId && pocket.enemyNationId === tracker.enemyNationId
  );
  for (const pocket of active) {
    const closedKey = `${pocket.id}:closed`;
    if (!tracker.seenPocketEventKeys.has(closedKey)) {
      tracker.seenPocketEventKeys.add(closedKey); reasons.add("pocket-closed"); evidenceUnits += 1;
    }
    const reducedKey = `${pocket.id}:reduced`;
    if (pocket.regionIds.length * 2 <= pocket.initialRegionCount &&
      !tracker.seenPocketEventKeys.has(reducedKey)) {
      tracker.seenPocketEventKeys.add(reducedKey); reasons.add("pocket-reduced-significantly"); evidenceUnits += 2;
    }
  }
  for (const pocket of history) {
    const key = `${pocket.id}:destroyed`;
    if (pocket.status === "destroyed" && !tracker.seenPocketEventKeys.has(key)) {
      tracker.seenPocketEventKeys.add(key); reasons.add("pocket-destroyed"); evidenceUnits = REQUIRED_EVIDENCE_UNITS;
    }
  }
  return { reasons: [...reasons], evidenceUnits };
}

function rebaseTracker(
  world: WorldState,
  tracker: StrategicProgressTracker,
  sectors: OperationalSector[],
  capitalDistance: number | null,
): void {
  tracker.baselineControllerByRegionId.clear();
  tracker.baselineFriendlyBorderIds.clear();
  const ownerByRegionId = getOwnerByMesoId(world);
  for (const sector of sectors) {
    const friendly = getFrontSide(sector, tracker.nationId);
    const enemy = getOpposingFrontSide(sector, tracker.nationId);
    for (const regionId of friendly?.borderRegionIds ?? []) {
      tracker.baselineFriendlyBorderIds.add(regionId);
    }
    for (const regionId of [
      ...(friendly?.influenceRegionIds ?? []),
      ...(enemy?.influenceRegionIds ?? []),
    ]) {
      tracker.baselineControllerByRegionId.set(
        regionId,
        effectiveController(world, regionId, ownerByRegionId),
      );
    }
  }
  tracker.baselineCapitalDistance = capitalDistance;
  tracker.breakthroughPersistence = 0;
  tracker.evidenceUnits = 0;
}

function extendTrackedFrontScope(
  world: WorldState,
  tracker: StrategicProgressTracker,
  sectors: OperationalSector[],
): void {
  const ownerByRegionId = getOwnerByMesoId(world);
  for (const sector of sectors) {
    const friendly = getFrontSide(sector, tracker.nationId);
    const enemy = getOpposingFrontSide(sector, tracker.nationId);
    for (const regionId of [
      ...(friendly?.influenceRegionIds ?? []),
      ...(enemy?.influenceRegionIds ?? []),
    ]) {
      if (!tracker.baselineControllerByRegionId.has(regionId)) {
        tracker.baselineControllerByRegionId.set(
          regionId,
          effectiveController(world, regionId, ownerByRegionId),
        );
      }
    }
  }
}

function calculateNetTerritorialGain(
  world: WorldState,
  tracker: StrategicProgressTracker,
): number {
  const ownerByRegionId = getOwnerByMesoId(world);
  let result = 0;
  for (const [regionId, baselineController] of tracker.baselineControllerByRegionId) {
    const controller = effectiveController(world, regionId, ownerByRegionId);
    if (baselineController === tracker.enemyNationId && controller === tracker.nationId) {
      result += 1;
    } else if (
      baselineController === tracker.nationId &&
      controller === tracker.enemyNationId
    ) {
      result -= 1;
    }
  }
  return result;
}

function calculateFrontlineDisplacement(
  tracker: StrategicProgressTracker,
  sectors: OperationalSector[],
): number {
  const currentFriendlyBorderIds = new Set<MesoRegionId>();
  for (const sector of sectors) {
    for (const regionId of getFrontSide(sector, tracker.nationId)?.borderRegionIds ?? []) {
      currentFriendlyBorderIds.add(regionId);
    }
  }
  let overlap = 0;
  for (const regionId of tracker.baselineFriendlyBorderIds) {
    if (currentFriendlyBorderIds.has(regionId)) overlap += 1;
  }
  return Math.max(0, tracker.baselineFriendlyBorderIds.size - overlap);
}

function hasImportantBaselineCapture(
  world: WorldState,
  tracker: StrategicProgressTracker,
): boolean {
  const ownerByRegionId = getOwnerByMesoId(world);
  const mesoById = getMesoById(world);
  for (const [regionId, baselineController] of tracker.baselineControllerByRegionId) {
    if (baselineController !== tracker.enemyNationId) continue;
    const building = mesoById.get(regionId)?.building;
    if (building !== "city" && building !== "capital") continue;
    if (effectiveController(world, regionId, ownerByRegionId) === tracker.nationId) {
      return true;
    }
  }
  return false;
}

function collectOperationEvidence(
  world: WorldState,
  tracker: StrategicProgressTracker,
): { reasons: StrategicProgressReason[]; evidenceUnits: number } {
  const reasons = new Set<StrategicProgressReason>();
  let evidenceUnits = 0;
  const mesoById = getMesoById(world);
  const pairOperations = getPairOperations(world, tracker);
  const retainedOperationIds = new Set<string>(
    pairOperations.map((operation) => operation.id),
  );
  for (const operationId of tracker.seenSuccessfulOperationIds) {
    if (!retainedOperationIds.has(operationId)) {
      tracker.seenSuccessfulOperationIds.delete(operationId);
    }
  }
  for (const operationId of tracker.seenSustainedCutoffOperationIds) {
    if (!retainedOperationIds.has(operationId)) {
      tracker.seenSustainedCutoffOperationIds.delete(operationId);
    }
  }
  for (const operation of pairOperations) {
    if (operation.supplyCutoffConfirmation?.state === "sustained" &&
        !tracker.seenSustainedCutoffOperationIds.has(operation.id)) {
      tracker.seenSustainedCutoffOperationIds.add(operation.id);
      reasons.add("meaningful-force-isolated");
      const objective = operation.supplyCutoffObjective;
      evidenceUnits += objective?.majorForceAffected ||
        (objective?.affectedStrength ?? 0) >= 5000 ? 2 : 1;
      if (objective?.frontlineAffected) reasons.add("frontline-supply-cut");
      if (objective?.majorForceAffected) reasons.add("major-component-isolated");
      if (objective?.sourceKind === "maritime" || objective?.sourceKind === "mixed") {
        reasons.add("maritime-supply-cut");
      }
    }
    if (
      operation.outcome !== "success" ||
      tracker.seenSuccessfulOperationIds.has(operation.id)
    ) continue;
    tracker.seenSuccessfulOperationIds.add(operation.id);
    const capturedRegionIds = operation.capturedRegionIds;
    if (capturedRegionIds.length >= OPERATIONAL_GAIN_BASE) {
      reasons.add("successful-operation");
      evidenceUnits += Math.min(
        REQUIRED_EVIDENCE_UNITS,
        capturedRegionIds.length - 1,
      );
    }
    if (capturedRegionIds.some((regionId) => {
      const building = mesoById.get(regionId)?.building;
      return building === "city" || building === "capital";
    })) {
      reasons.add("important-capture");
      evidenceUnits = REQUIRED_EVIDENCE_UNITS;
    }
    if (operation.exploitationDepth >= DEEP_EXPLOITATION_DEPTH) {
      reasons.add("successful-exploitation");
      evidenceUnits = REQUIRED_EVIDENCE_UNITS;
    }
  }
  return { reasons: [...reasons], evidenceUnits };
}

function getPairOperations(
  world: WorldState,
  tracker: StrategicProgressTracker,
): OffensiveOperation[] {
  return [...world.offensiveOperations.operations, ...world.offensiveOperations.history]
    .filter((operation) =>
      operation.nationId === tracker.nationId &&
      operation.enemyNationId === tracker.enemyNationId
    );
}

function getPairCapitalDistance(
  world: WorldState,
  tracker: StrategicProgressTracker,
  sectors: OperationalSector[],
): number | null {
  const capital = world.capitalDefense.assessmentsByNationId.get(
    tracker.enemyNationId,
  );
  if (capital?.nearestFrontDistance === null || !capital?.primaryFrontId) return null;
  if (!sectors.some((sector) => sector.id === capital.primaryFrontId)) return null;
  return capital.nearestFrontDistance;
}

function indexSectorsByPair(world: WorldState): Map<string, OperationalSector[]> {
  const result = new Map<string, OperationalSector[]>();
  for (const sector of world.landFronts.operationalSectors) {
    for (const [nationId, enemyNationId] of [
      [sector.nationAId, sector.nationBId],
      [sector.nationBId, sector.nationAId],
    ] as const) {
      const key = pairKey(nationId, enemyNationId);
      const list = result.get(key);
      if (list) list.push(sector);
      else result.set(key, [sector]);
    }
  }
  return result;
}

function effectiveController(
  world: WorldState,
  regionId: MesoRegionId,
  ownerByRegionId: ReadonlyMap<MesoRegionId, NationId>,
): NationId | null {
  return world.occupation.mesoById.get(regionId) ?? ownerByRegionId.get(regionId) ?? null;
}

function createReasonCounts(): Record<StrategicProgressReason, number> {
  return {
    "net-territorial-gain": 0,
    "sustained-frontline-displacement": 0,
    "persistent-breakthrough": 0,
    "capital-approach": 0,
    "operational-front-collapse": 0,
    "successful-operation": 0,
    "important-capture": 0,
    "successful-exploitation": 0,
    "pocket-closed": 0,
    "pocket-reduced-significantly": 0,
    "pocket-destroyed": 0,
    "meaningful-force-isolated": 0,
    "frontline-supply-cut": 0,
    "major-component-isolated": 0,
    "maritime-supply-cut": 0,
  };
}

function pairKey(nationId: NationId, enemyNationId: NationId): string {
  return `${nationId}|${enemyNationId}`;
}

function parsePairKey(key: string): [NationId, NationId] {
  const separator = key.indexOf("|");
  return [key.slice(0, separator) as NationId, key.slice(separator + 1) as NationId];
}
