import { WORLD_BALANCE } from "../data/balance";
import type { NationId } from "../worldgen/nation";
import { getCapitalDefenseAssessment } from "./capital-defense";
import { getFrontlineCoverage } from "./frontline-coverage";
import {
  getFrontSide,
  getOpposingFrontSide,
  type FrontId,
  type OperationalSector,
} from "./land-fronts";
import { getFrontAllocation } from "./nation-front-allocations";
import { getSectorPlan } from "./nation-front-plans";
import type { WorldState } from "./world-state";
import { getOwnerByMesoId } from "./world-cache";

export type StalemateReason =
  | "no-territory-progress"
  | "no-breakthrough-progress"
  | "repeated-operation-cancel"
  | "balanced-strength"
  | "continuous-coverage"
  | "artificial-inactivity";
export type ArtificialInactivityBlocker = "posture" | "allocation" | "target-validity" | null;

export interface StalemateAssessment {
  nationId: NationId;
  enemyNationId: NationId;
  pressure: number;
  staticTicks: number;
  reasonFlags: StalemateReason[];
  artificialInactivity: boolean;
  artificialInactivityBlocker: ArtificialInactivityBlocker;
  schwerpunktSectorId: FrontId | null;
  selectedAtTick: number | null;
  cooldownUntilTick: number;
  lastOccupationVersion: number;
  lastBreakthroughCount: number;
  lastOperationSuccessCount: number;
  lastOperationFailureCount: number;
  releasedSecondaryStrength: number;
}

export interface StalematePressureState {
  assessments: StalemateAssessment[];
  byNationEnemy: Map<string, StalemateAssessment>;
  schwerpunktByNationId: Map<NationId, StalemateAssessment>;
  version: number;
  allocationVersion: number;
  detections: number;
  selections: number;
  selectionChanges: number;
  artificialInactivitySamples: number;
  artificialInactivityByBlocker: Record<Exclude<ArtificialInactivityBlocker, null>, number>;
  pressureSampleTotal: number;
  pressureSampleCount: number;
  maxPressure: number;
  staticTickSampleTotal: number;
  staticTickSampleCount: number;
  maxStaticTicks: number;
  majorOffensivesLaunched: number;
  majorOffensiveSuccesses: number;
  majorOffensiveFailures: number;
}

export function createStalematePressureState(): StalematePressureState {
  return {
    assessments: [], byNationEnemy: new Map(), schwerpunktByNationId: new Map(),
    version: 0, allocationVersion: 0, detections: 0, selections: 0, selectionChanges: 0,
    artificialInactivitySamples: 0,
    artificialInactivityByBlocker: { posture: 0, allocation: 0, "target-validity": 0 },
    pressureSampleTotal: 0, pressureSampleCount: 0,
    maxPressure: 0, staticTickSampleTotal: 0, staticTickSampleCount: 0, maxStaticTicks: 0,
    majorOffensivesLaunched: 0, majorOffensiveSuccesses: 0,
    majorOffensiveFailures: 0,
  };
}

export function getStalemateAssessment(
  world: WorldState, nationId: NationId, enemyNationId: NationId,
): StalemateAssessment | undefined {
  return world.stalematePressure.byNationEnemy.get(key(nationId, enemyNationId));
}

export function getNationSchwerpunkt(
  world: WorldState, nationId: NationId,
): StalemateAssessment | undefined {
  return world.stalematePressure.schwerpunktByNationId.get(nationId);
}

export function isSchwerpunktSector(
  world: WorldState, nationId: NationId, sectorId: FrontId,
): boolean {
  return getNationSchwerpunkt(world, nationId)?.schwerpunktSectorId === sectorId;
}

export function updateStalematePressure(world: WorldState): void {
  const state = world.stalematePressure;
  const startedAt = world.instrumentation ? performance.now() : 0;
  const previousFocus = [...state.schwerpunktByNationId.entries()]
    .map(([nationId, item]) => `${nationId}:${item.schwerpunktSectorId ?? ""}`)
    .sort().join("|");
  const settings = WORLD_BALANCE.war.landFront.stalemate;
  const previous = state.byNationEnemy;
  const operationProgress = indexOperationProgress(world);
  const occupationSignatures = indexOccupationSignatures(world);
  const sectorsByPair = new Map<string, OperationalSector[]>();
  for (const sector of world.landFronts.operationalSectors) {
    for (const [nationId, enemyId] of [[sector.nationAId, sector.nationBId], [sector.nationBId, sector.nationAId]] as const) {
      const list = sectorsByPair.get(key(nationId, enemyId));
      if (list) list.push(sector); else sectorsByPair.set(key(nationId, enemyId), [sector]);
    }
  }
  const next: StalemateAssessment[] = [];
  for (const pairKey of [...sectorsByPair.keys()].sort()) {
    const sectors = sectorsByPair.get(pairKey)!;
    const first = sectors[0];
    const nationId = pairKey.slice(0, pairKey.indexOf("|")) as NationId;
    const enemyNationId = (first.nationAId === nationId ? first.nationBId : first.nationAId);
    const before = previous.get(pairKey);
    const friendlyStrength = sumSides(sectors, nationId, true);
    const enemyStrength = sumSides(sectors, nationId, false);
    const ratio = friendlyStrength / Math.max(1, enemyStrength);
    const bothCapable = friendlyStrength >= settings.minimumMeaningfulStrength && enemyStrength >= settings.minimumMeaningfulStrength;
    const balanced = ratio >= settings.balancedMinimumRatio && ratio <= settings.balancedMaximumRatio;
    const breakthrough = world.frontlineCoverage.breakthroughEvents;
    const progress = operationProgress.get(pairKey) ?? { success: 0, failure: 0 };
    const success = progress.success;
    const failure = progress.failure;
    const occupationSignature = occupationSignatures.get(normalizedKey(nationId, enemyNationId)) ?? 0;
    const territoryProgress = !!before && before.lastOccupationVersion !== occupationSignature;
    // Coverage "breakthroughEvents" includes newly exposed friendly gaps during
    // deliberate concentration. Only a successful Operation is strategic
    // breakthrough progress; otherwise concentration would reset itself.
    const breakthroughProgress = !!before && before.lastOperationSuccessCount !== success;
    const critical = getCapitalDefenseAssessment(world, nationId)?.threatLevel === "critical";
    const retreating = sectors.some((sector) => getSectorPlan(world, sector.id, nationId)?.posture === "retreat");
    const continuous = sectors.every((sector) => {
      const ours = getFrontlineCoverage(world, sector.id, nationId);
      const theirs = getFrontlineCoverage(world, sector.id, enemyNationId);
      return !!ours && !!theirs && ours.gapSegments === 0 && theirs.gapSegments === 0;
    });
    const noOperation = !(world.offensiveOperations.operationsByNationId.get(nationId)?.some((op) => op.enemyNationId === enemyNationId && op.phase !== "recovering"));
    const surplus = sectors.reduce((sum, sector) => sum + (getFrontAllocation(world, sector.id, nationId)?.surplus ?? 0), 0);
    const enemyLineStrength = sectors.reduce((sum, sector) => sum + (getFrontlineCoverage(world, sector.id, enemyNationId)?.defenderStrength ?? 0), 0);
    const hasAllocatedForce = sectors.some((sector) => (getFrontAllocation(world, sector.id, nationId)?.unitIds.length ?? 0) > 0);
    const artificial = noOperation && hasAllocatedForce && friendlyStrength >= settings.minimumMeaningfulStrength &&
      (enemyStrength < settings.minimumMeaningfulStrength * 0.25 || enemyLineStrength <= 0 || surplus > enemyStrength * 0.75);
    const artificialBlocker: ArtificialInactivityBlocker = !artificial ? null
      : sectors.every((sector) => !getFrontAllocation(world, sector.id, nationId)) ? "allocation"
        : sectors.every((sector) => getSectorPlan(world, sector.id, nationId)?.posture !== "attack") ? "posture"
          : "target-validity";
    let pressure = before?.pressure ?? 0;
    let staticTicks = before?.staticTicks ?? 0;
    if (territoryProgress || breakthroughProgress) {
      pressure = Math.max(0, pressure - settings.pressureDecayOnProgress);
      staticTicks = 0;
    } else if (bothCapable && balanced && !critical && !retreating) {
      pressure = Math.min(settings.maximumPressure, pressure + settings.pressureGainPerSlowTick);
      staticTicks += 1;
    } else {
      pressure = Math.max(0, pressure - settings.pressureGainPerSlowTick);
      staticTicks = 0;
    }
    const reasons: StalemateReason[] = [];
    if (!territoryProgress) reasons.push("no-territory-progress");
    if (!breakthroughProgress) reasons.push("no-breakthrough-progress");
    if (balanced) reasons.push("balanced-strength");
    if (continuous) reasons.push("continuous-coverage");
    if (before && failure > before.lastOperationFailureCount) reasons.push("repeated-operation-cancel");
    if (artificial) reasons.push("artificial-inactivity");
    let schwerpunktSectorId = before?.schwerpunktSectorId ?? null;
    let selectedAtTick = before?.selectedAtTick ?? null;
    const cooldownUntilTick = before?.cooldownUntilTick ?? 0;
    if (critical || retreating || pressure < settings.selectionThreshold || world.time.fastTick < cooldownUntilTick) {
      schwerpunktSectorId = null; selectedAtTick = null;
    } else if (!schwerpunktSectorId || !sectors.some((sector) => sector.id === schwerpunktSectorId)) {
      schwerpunktSectorId = selectSector(world, sectors, nationId);
      selectedAtTick = world.time.fastTick;
      state.selections += 1;
      if (before?.schwerpunktSectorId) state.selectionChanges += 1;
    }
    const assessment: StalemateAssessment = {
      nationId, enemyNationId, pressure, staticTicks, reasonFlags: reasons,
      artificialInactivity: artificial, artificialInactivityBlocker: artificialBlocker,
      schwerpunktSectorId, selectedAtTick,
      cooldownUntilTick, lastOccupationVersion: occupationSignature,
      lastBreakthroughCount: breakthrough, lastOperationSuccessCount: success,
      lastOperationFailureCount: failure, releasedSecondaryStrength: before?.releasedSecondaryStrength ?? 0,
    };
    if (schwerpunktSectorId) {
      assessment.releasedSecondaryStrength = sectors
        .filter((sector) => sector.id !== schwerpunktSectorId)
        .reduce((sum, sector) => sum + (getSectorPlan(world, sector.id, nationId)?.desiredStrength ?? 0) * (1 - settings.secondaryDesiredStrengthRatio), 0);
    }
    if (pressure >= settings.selectionThreshold && (before?.pressure ?? 0) < settings.selectionThreshold) state.detections += 1;
    if (artificial) {
      state.artificialInactivitySamples += 1;
      if (artificialBlocker) state.artificialInactivityByBlocker[artificialBlocker] += 1;
    }
    state.pressureSampleTotal += pressure; state.pressureSampleCount += 1;
    state.maxPressure = Math.max(state.maxPressure, pressure);
    state.staticTickSampleTotal += staticTicks; state.staticTickSampleCount += 1;
    state.maxStaticTicks = Math.max(state.maxStaticTicks, staticTicks);
    next.push(assessment);
  }
  const nextByKey = new Map(next.map((item) => [key(item.nationId, item.enemyNationId), item]));
  const schwerpunktByNationId = new Map<NationId, StalemateAssessment>();
  for (const item of next.sort(compareAssessment)) {
    if (item.schwerpunktSectorId && !schwerpunktByNationId.has(item.nationId)) schwerpunktByNationId.set(item.nationId, item);
    else if (item.schwerpunktSectorId) { item.schwerpunktSectorId = null; item.selectedAtTick = null; }
  }
  state.assessments = next; state.byNationEnemy = nextByKey;
  state.schwerpunktByNationId = schwerpunktByNationId; state.version += 1;
  const nextFocus = [...schwerpunktByNationId.entries()]
    .map(([nationId, item]) => `${nationId}:${item.schwerpunktSectorId ?? ""}`)
    .sort().join("|");
  if (previousFocus !== nextFocus) state.allocationVersion += 1;
  world.instrumentation?.recordDuration("stalemate.evaluation", performance.now() - startedAt);
}

export function recordMajorOffensiveOutcome(world: WorldState, nationId: NationId, enemyId: NationId, success: boolean): void {
  const assessment = getStalemateAssessment(world, nationId, enemyId);
  if (!assessment) return;
  const settings = WORLD_BALANCE.war.landFront.stalemate;
  assessment.pressure = Math.max(0, assessment.pressure - settings.pressureDecayOnFailure);
  assessment.cooldownUntilTick = world.time.fastTick + settings.failedOffensiveCooldownTicks;
  assessment.schwerpunktSectorId = null; assessment.selectedAtTick = null;
  if (success) world.stalematePressure.majorOffensiveSuccesses += 1;
  else world.stalematePressure.majorOffensiveFailures += 1;
}

function selectSector(world: WorldState, sectors: OperationalSector[], nationId: NationId): FrontId {
  return [...sectors].sort((a, b) => scoreSector(world, b, nationId) - scoreSector(world, a, nationId) || a.id.localeCompare(b.id))[0].id;
}
function scoreSector(world: WorldState, sector: OperationalSector, nationId: NationId): number {
  const plan = getSectorPlan(world, sector.id, nationId);
  const friendly = getFrontSide(sector, nationId); const enemy = getOpposingFrontSide(sector, nationId);
  const enemyCoverage = enemy ? getFrontlineCoverage(world, sector.id, enemy.nationId) : undefined;
  const ratio = (friendly?.strength ?? 0) / Math.max(1, enemy?.strength ?? 0);
  return (plan?.priority ?? 0) + ratio * 20 + (enemyCoverage?.gapSegments ?? 0) * 25 + (enemyCoverage?.weakSegments ?? 0) * 10;
}
function sumSides(sectors: OperationalSector[], nationId: NationId, friendly: boolean): number {
  return sectors.reduce((sum, sector) => sum + ((friendly ? getFrontSide(sector, nationId) : getOpposingFrontSide(sector, nationId))?.strength ?? 0), 0);
}
function compareAssessment(a: StalemateAssessment, b: StalemateAssessment): number { return a.nationId.localeCompare(b.nationId) || b.pressure - a.pressure || a.enemyNationId.localeCompare(b.enemyNationId); }
function key(a: NationId, b: NationId): string { return `${a}|${b}`; }
function normalizedKey(a: NationId, b: NationId): string { return a < b ? `${a}|${b}` : `${b}|${a}`; }

function indexOperationProgress(world: WorldState): Map<string, { success: number; failure: number }> {
  const result = new Map<string, { success: number; failure: number }>();
  for (const operation of [...world.offensiveOperations.history, ...world.offensiveOperations.operations]) {
    if (!operation.outcome) continue;
    const item = result.get(key(operation.nationId, operation.enemyNationId)) ?? { success: 0, failure: 0 };
    if (operation.outcome === "success") item.success += 1; else item.failure += 1;
    result.set(key(operation.nationId, operation.enemyNationId), item);
  }
  return result;
}

function indexOccupationSignatures(world: WorldState): Map<string, number> {
  const result = new Map<string, number>();
  const owners = getOwnerByMesoId(world);
  for (const [regionId, occupierId] of world.occupation.mesoById) {
    const ownerId = owners.get(regionId);
    if (!ownerId || ownerId === occupierId) continue;
    const pair = normalizedKey(ownerId, occupierId);
    let hash = result.get(pair) ?? 0;
    for (let index = 0; index < regionId.length; index += 1) hash = (hash * 31 + regionId.charCodeAt(index)) | 0;
    for (let index = 0; index < occupierId.length; index += 1) hash = (hash * 31 + occupierId.charCodeAt(index)) | 0;
    result.set(pair, hash);
  }
  return result;
}
