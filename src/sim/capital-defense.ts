import { WORLD_BALANCE } from "../data/balance";
import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import {
  getFrontSide,
  getOpposingFrontSide,
  type FrontId,
  type OperationalSector,
} from "./land-fronts";
import { isNationActive } from "./nation-active";
import type { UnitId } from "./unit";
import { getUnitCombatStrength } from "./unit-strength";
import { buildWarAdjacency, isAtWar } from "./war-state";
import type { WorldState } from "./world-state";
import { getMesoById, getNeighborsById, getOwnerByMesoId } from "./world-cache";

export type CapitalThreatLevel = "none" | "threatened" | "critical";

export interface CapitalDefenseAssessment {
  nationId: NationId;
  capitalRegionId: MesoRegionId;
  defenseRegionIds: MesoRegionId[];
  threatenedFrontIds: FrontId[];
  primaryFrontId: FrontId | null;
  threatLevel: CapitalThreatLevel;
  nearestFrontDistance: number | null;
  friendlyStrength: number;
  enemyStrength: number;
  frontEnemyStrength: number;
  nationalLandStrength: number;
  minimumDefenseStrength: number;
  friendlyUnitIds: UnitId[];
  enemyUnitIds: UnitId[];
  emergencyStartedAtTick: number | null;
  evaluatedAtTick: number;
}

export interface CapitalDefenseEvent {
  tick: number;
  nationId: NationId;
  previousLevel: CapitalThreatLevel;
  threatLevel: CapitalThreatLevel;
  primaryFrontId: FrontId | null;
  friendlyStrength: number;
  enemyStrength: number;
}

export interface CapitalDefenseState {
  assessments: CapitalDefenseAssessment[];
  assessmentsByNationId: Map<NationId, CapitalDefenseAssessment>;
  timeline: CapitalDefenseEvent[];
  version: number;
  emergencyCount: number;
  criticalEmergencyCount: number;
  emergencyDurationTicks: number;
  reallocatedUnitCount: number;
  fallbackSelectionCount: number;
  operationCancellationCount: number;
  capitalFallCount: number;
  capitalFallTicks: number[];
  unguardedTickCount: number;
  lastEvaluationTick: number;
  lastObservedCapitalFallCount: number;
}

interface FrontThreatCandidate {
  front: OperationalSector;
  distance: number;
  enemyStrength: number;
}

export function createCapitalDefenseState(): CapitalDefenseState {
  return {
    assessments: [],
    assessmentsByNationId: new Map(),
    timeline: [],
    version: 0,
    emergencyCount: 0,
    criticalEmergencyCount: 0,
    emergencyDurationTicks: 0,
    reallocatedUnitCount: 0,
    fallbackSelectionCount: 0,
    operationCancellationCount: 0,
    capitalFallCount: 0,
    capitalFallTicks: [],
    unguardedTickCount: 0,
    lastEvaluationTick: 0,
    lastObservedCapitalFallCount: 0,
  };
}

export function updateCapitalDefense(world: WorldState): void {
  const startedAt = world.instrumentation ? performance.now() : 0;
  const state = world.capitalDefense;
  const now = world.time.fastTick;
  const elapsedTicks = Math.max(0, now - state.lastEvaluationTick);
  for (const previous of state.assessments) {
    if (previous.threatLevel === "none") continue;
    state.emergencyDurationTicks += elapsedTicks;
    world.instrumentation?.incrementCounter(
      "capitalDefense.emergencyDurationTicks",
      elapsedTicks,
    );
    if (previous.friendlyStrength <= 0) {
      state.unguardedTickCount += elapsedTicks;
      world.instrumentation?.incrementCounter(
        "capitalDefense.unguardedTicks",
        elapsedTicks,
      );
    }
  }

  const previousByNation = state.assessmentsByNationId;
  const assessments = world.nations
    .filter(isNationActive)
    .map((nation) =>
      assessCapitalDefense(
        world,
        nation.id,
        nation.capitalMesoId,
        previousByNation.get(nation.id),
      ),
    )
    .filter((assessment): assessment is CapitalDefenseAssessment => !!assessment)
    .sort((a, b) => compareIds(a.nationId, b.nationId));

  for (const assessment of assessments) {
    const previousLevel =
      previousByNation.get(assessment.nationId)?.threatLevel ?? "none";
    if (previousLevel === "none" && assessment.threatLevel !== "none") {
      state.emergencyCount += 1;
      world.instrumentation?.incrementCounter("capitalDefense.emergencies");
    }
    if (
      previousLevel !== "critical" &&
      assessment.threatLevel === "critical"
    ) {
      state.criticalEmergencyCount += 1;
      world.instrumentation?.incrementCounter(
        "capitalDefense.criticalEmergencies",
      );
    }
    if (previousLevel !== assessment.threatLevel) {
      state.timeline.push({
        tick: now,
        nationId: assessment.nationId,
        previousLevel,
        threatLevel: assessment.threatLevel,
        primaryFrontId: assessment.primaryFrontId,
        friendlyStrength: assessment.friendlyStrength,
        enemyStrength: assessment.enemyStrength,
      });
    }
  }
  for (const [nationId, previous] of previousByNation) {
    if (
      previous.threatLevel !== "none" &&
      !assessments.some((assessment) => assessment.nationId === nationId)
    ) {
      state.timeline.push({
        tick: now,
        nationId,
        previousLevel: previous.threatLevel,
        threatLevel: "none",
        primaryFrontId: null,
        friendlyStrength: 0,
        enemyStrength: 0,
      });
    }
  }
  const timelineLimit =
    WORLD_BALANCE.war.landFront.capitalDefense.timelineLimit;
  if (state.timeline.length > timelineLimit) {
    state.timeline.splice(0, state.timeline.length - timelineLimit);
  }

  const observedFalls = world.nations.reduce(
    (total, nation) => total + nation.capitalFallCount,
    0,
  );
  const newFalls = Math.max(0, observedFalls - state.lastObservedCapitalFallCount);
  if (newFalls > 0) {
    state.capitalFallCount += newFalls;
    for (let index = 0; index < newFalls; index += 1) {
      state.capitalFallTicks.push(now);
    }
    world.instrumentation?.incrementCounter("capitalDefense.capitalFalls", newFalls);
  }
  state.lastObservedCapitalFallCount = observedFalls;
  state.assessments = assessments;
  state.assessmentsByNationId = new Map(
    assessments.map((assessment) => [assessment.nationId, assessment]),
  );
  state.lastEvaluationTick = now;
  state.version += 1;
  if (world.instrumentation) {
    world.instrumentation.recordDuration(
      "capitalDefense.evaluation",
      performance.now() - startedAt,
    );
  }
}

export function getCapitalDefenseAssessment(
  world: WorldState,
  nationId: NationId,
): CapitalDefenseAssessment | undefined {
  return world.capitalDefense.assessmentsByNationId.get(nationId);
}

export function isCapitalThreatenedFront(
  world: WorldState,
  nationId: NationId,
  frontId: FrontId,
): boolean {
  const assessment = getCapitalDefenseAssessment(world, nationId);
  return (
    !!assessment &&
    assessment.threatLevel !== "none" &&
    assessment.threatenedFrontIds.includes(frontId)
  );
}

export function recordCapitalDefenseReallocation(
  world: WorldState,
  amount: number,
): void {
  if (amount <= 0) return;
  world.capitalDefense.reallocatedUnitCount += amount;
  world.instrumentation?.incrementCounter(
    "capitalDefense.reallocatedUnits",
    amount,
  );
}

export function recordCapitalFallbackSelection(world: WorldState): void {
  world.capitalDefense.fallbackSelectionCount += 1;
  world.instrumentation?.incrementCounter("capitalDefense.fallbackSelections");
}

export function recordCapitalOperationCancellations(
  world: WorldState,
  amount: number,
): void {
  if (amount <= 0) return;
  world.capitalDefense.operationCancellationCount += amount;
  world.instrumentation?.incrementCounter(
    "capitalDefense.operationCancellations",
    amount,
  );
}

function assessCapitalDefense(
  world: WorldState,
  nationId: NationId,
  capitalRegionId: MesoRegionId,
  previous: CapitalDefenseAssessment | undefined,
): CapitalDefenseAssessment | null {
  const mesoById = getMesoById(world);
  const capital = mesoById.get(capitalRegionId);
  if (!capital || capital.type === "sea" || capital.building !== "capital") {
    return null;
  }
  const settings = WORLD_BALANCE.war.landFront.capitalDefense;
  const distances = buildLandDistances(
    capitalRegionId,
    settings.radius,
    mesoById,
    getNeighborsById(world),
  );
  const ownerByMesoId = getOwnerByMesoId(world);
  const defenseRegionIds = [...distances.keys()]
    .filter(
      (regionId) =>
        effectiveController(world, regionId, ownerByMesoId) === nationId,
    )
    .sort(compareIds);
  const zoneIds = new Set(distances.keys());
  const warAdjacency = buildWarAdjacency(world.wars);
  const friendlyUnits = world.units.filter(
    (unit) =>
      unit.domain === "land" &&
      unit.nationId === nationId &&
      zoneIds.has(unit.regionId),
  );
  const enemyUnits = world.units.filter(
    (unit) =>
      unit.domain === "land" &&
      zoneIds.has(unit.regionId) &&
      isAtWar(nationId, unit.nationId, warAdjacency),
  );
  const nationalUnits = world.units.filter(
    (unit) => unit.domain === "land" && unit.nationId === nationId,
  );
  const friendlyStrength = sumStrength(friendlyUnits);
  const enemyStrength = sumStrength(enemyUnits);
  const nationalLandStrength = sumStrength(nationalUnits);
  const frontCandidates = (world.landFronts.operationalSectorsByNationId.get(nationId) ?? [])
    .map((front) => createFrontThreatCandidate(front, nationId, distances))
    .filter((candidate): candidate is FrontThreatCandidate => !!candidate)
    .sort(
      (a, b) =>
        a.distance - b.distance ||
        b.enemyStrength - a.enemyStrength ||
        compareIds(a.front.id, b.front.id),
    );
  const threatened = frontCandidates.filter(
    (candidate) => candidate.distance <= settings.radius,
  );
  const primary = threatened[0] ?? frontCandidates[0] ?? null;
  const frontEnemyStrength = threatened.reduce(
    (maximum, candidate) => Math.max(maximum, candidate.enemyStrength),
    0,
  );
  const capitalController = effectiveController(world, capitalRegionId, ownerByMesoId);
  const nearestEnemyUnitDistance = enemyUnits.reduce(
    (minimum, unit) => Math.min(minimum, distances.get(unit.regionId) ?? Infinity),
    Infinity,
  );
  const hasThreat = threatened.length > 0 || enemyUnits.length > 0;
  let threatLevel: CapitalThreatLevel = "none";
  if (hasThreat) {
    threatLevel =
      capitalController !== nationId ||
      nearestEnemyUnitDistance <= settings.criticalEnemyRadius ||
      (threatened[0]?.distance ?? Infinity) === 0
        ? "critical"
        : "threatened";
  }
  const threatStrength = Math.max(enemyStrength, frontEnemyStrength);
  const minimumDefenseStrength = Math.min(
    nationalLandStrength,
    Math.max(
      threatStrength * settings.enemyStrengthMultiplier,
      nationalLandStrength * settings.minimumNationalStrengthRatio,
    ),
  );
  const wasActive = previous?.threatLevel !== "none";
  const isActive = threatLevel !== "none";
  return {
    nationId,
    capitalRegionId,
    defenseRegionIds,
    threatenedFrontIds: threatened.map((candidate) => candidate.front.id),
    primaryFrontId: isActive ? primary?.front.id ?? null : null,
    threatLevel,
    nearestFrontDistance: primary ? primary.distance : null,
    friendlyStrength,
    enemyStrength,
    frontEnemyStrength,
    nationalLandStrength,
    minimumDefenseStrength: finiteNumber(minimumDefenseStrength),
    friendlyUnitIds: friendlyUnits.map((unit) => unit.id).sort(compareIds),
    enemyUnitIds: enemyUnits.map((unit) => unit.id).sort(compareIds),
    emergencyStartedAtTick:
      isActive && wasActive
        ? previous?.emergencyStartedAtTick ?? world.time.fastTick
        : isActive
          ? world.time.fastTick
          : null,
    evaluatedAtTick: world.time.fastTick,
  };
}

function createFrontThreatCandidate(
  front: OperationalSector,
  nationId: NationId,
  distances: Map<MesoRegionId, number>,
): FrontThreatCandidate | null {
  const friendly = getFrontSide(front, nationId);
  const enemy = getOpposingFrontSide(front, nationId);
  if (!friendly || !enemy || enemy.strength <= 0) return null;
  const distance = friendly.borderRegionIds.reduce(
    (minimum, regionId) => Math.min(minimum, distances.get(regionId) ?? Infinity),
    Infinity,
  );
  return Number.isFinite(distance)
    ? { front, distance, enemyStrength: finiteNumber(enemy.strength) }
    : null;
}

function buildLandDistances(
  startId: MesoRegionId,
  maxDistance: number,
  mesoById: ReturnType<typeof getMesoById>,
  neighborsById: ReturnType<typeof getNeighborsById>,
): Map<MesoRegionId, number> {
  const distances = new Map<MesoRegionId, number>([[startId, 0]]);
  const queue: MesoRegionId[] = [startId];
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    const distance = distances.get(current) ?? 0;
    if (distance >= maxDistance) continue;
    for (const neighborId of neighborsById.get(current) ?? []) {
      const neighbor = mesoById.get(neighborId);
      if (!neighbor || neighbor.type === "sea" || distances.has(neighborId)) {
        continue;
      }
      distances.set(neighborId, distance + 1);
      queue.push(neighborId);
    }
  }
  return distances;
}

function effectiveController(
  world: WorldState,
  regionId: MesoRegionId,
  ownerByMesoId: ReturnType<typeof getOwnerByMesoId>,
): NationId | undefined {
  return world.occupation.mesoById.get(regionId) ?? ownerByMesoId.get(regionId);
}

function sumStrength(units: WorldState["units"]): number {
  return finiteNumber(
    units.reduce((total, unit) => total + finiteNumber(getUnitCombatStrength(unit)), 0),
  );
}

function finiteNumber(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
