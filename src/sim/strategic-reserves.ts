import { WORLD_BALANCE } from "../data/balance";
import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import {
  getControlledDistanceField,
  getControlledRegions,
  getEnemyRegionIds,
  getFrontDistanceField,
  isSafeControlledRegion,
} from "./ai-geography";
import { getCapitalDefenseAssessment } from "./capital-defense";
import {
  getFrontSide,
  getOpposingFrontSide,
  type FrontId,
} from "./land-fronts";
import { isNationActive } from "./nation-active";
import type { UnitId, UnitState } from "./unit";
import { getUnitCombatStrength } from "./unit-strength";
import { buildWarAdjacency, isAtWar } from "./war-state";
import type { WorldState } from "./world-state";
import { getMesoById, getNeighborsById, getOwnerByMesoId } from "./world-cache";

export type ReserveStatus = "forming" | "ready" | "deploying" | "returning";

export type ReserveDeploymentTargetType =
  | "capital-defense"
  | "front-reinforcement"
  | "retreat-support"
  | "front-collapse";

export type ReserveDeploymentStatus = "moving" | "engaged" | "returning";

export type ReserveDeploymentReason =
  | "capital-critical"
  | "front-severe-deficit"
  | "retreat-fallback-threat"
  | "front-collapse"
  | "reserve-reforming";

export type ReserveEventType =
  | "formed"
  | "membership-changed"
  | "deployment-started"
  | "deployment-engaged"
  | "return-started"
  | "return-completed"
  | "cleaned-up";

export interface ReserveDeployment {
  targetType: ReserveDeploymentTargetType;
  targetFrontId?: FrontId;
  targetRegionIds: MesoRegionId[];
  unitIds: UnitId[];
  unitTargetRegionIds: Map<UnitId, MesoRegionId>;
  startedAtTick: number;
  status: ReserveDeploymentStatus;
  reasonFlags: ReserveDeploymentReason[];
  firstArrivalAtTick: number | null;
  initialTargetDeficit: number;
  lastEffectiveDeficit: number;
  lastArrivedUnitCount: number;
  capitalEmergencyStartedAtTick: number | null;
}

export interface NationReserveState {
  nationId: NationId;
  unitIds: UnitId[];
  totalStrength: number;
  desiredReserveStrength: number;
  stagingRegionIds: MesoRegionId[];
  status: ReserveStatus;
  deployment?: ReserveDeployment;
  membershipStartedAtTickByUnitId: Map<UnitId, number>;
  cooldownUntilTick: number;
  lastCollapseDeploymentAtTick: number;
}

export interface ReserveEvent {
  tick: number;
  nationId: NationId;
  type: ReserveEventType;
  detail: string;
}

export interface StrategicReserveState {
  enabled: boolean;
  reserves: NationReserveState[];
  reservesByNationId: Map<NationId, NationReserveState>;
  reserveNationByUnitId: Map<UnitId, NationId>;
  timeline: ReserveEvent[];
  version: number;
  membershipVersion: number;
  formationCount: number;
  membershipChangeCount: number;
  deploymentCount: number;
  deploymentCountByReason: Record<ReserveDeploymentReason, number>;
  deployedUnitCount: number;
  arrivalLatencyTicks: number;
  arrivalLatencySampleCount: number;
  capitalArrivalLatencyTicks: number;
  capitalArrivalLatencySampleCount: number;
  frontDeficitImprovement: number;
  retreatFallbackArrivalCount: number;
  returnStartedCount: number;
  returnCompletedCount: number;
  sampleCount: number;
  sampledUnitCount: number;
  sampledStrength: number;
  previousFrontIdsByNationId: Map<NationId, Set<FrontId>>;
  previousEnemyNationByFrontNation: Map<string, NationId>;
}

interface DeploymentTrigger {
  targetType: ReserveDeploymentTargetType;
  targetFrontId?: FrontId;
  targetRegionIds: MesoRegionId[];
  targetStrength: number;
  initialDeficit: number;
  reason: ReserveDeploymentReason;
  capitalEmergencyStartedAtTick: number | null;
}

export function createStrategicReserveState(enabled = true): StrategicReserveState {
  return {
    enabled,
    reserves: [],
    reservesByNationId: new Map(),
    reserveNationByUnitId: new Map(),
    timeline: [],
    version: 0,
    membershipVersion: 0,
    formationCount: 0,
    membershipChangeCount: 0,
    deploymentCount: 0,
    deploymentCountByReason: {
      "capital-critical": 0,
      "front-severe-deficit": 0,
      "retreat-fallback-threat": 0,
      "front-collapse": 0,
      "reserve-reforming": 0,
    },
    deployedUnitCount: 0,
    arrivalLatencyTicks: 0,
    arrivalLatencySampleCount: 0,
    capitalArrivalLatencyTicks: 0,
    capitalArrivalLatencySampleCount: 0,
    frontDeficitImprovement: 0,
    retreatFallbackArrivalCount: 0,
    returnStartedCount: 0,
    returnCompletedCount: 0,
    sampleCount: 0,
    sampledUnitCount: 0,
    sampledStrength: 0,
    previousFrontIdsByNationId: new Map(),
    previousEnemyNationByFrontNation: new Map(),
  };
}

export function updateStrategicReserves(world: WorldState): void {
  const startedAt = world.instrumentation ? performance.now() : 0;
  const state = world.strategicReserves;
  if (!state.enabled) {
    if (state.reserves.length > 0 || state.reserveNationByUnitId.size > 0) {
      state.reserves = [];
      state.reservesByNationId.clear();
      state.reserveNationByUnitId.clear();
      state.membershipVersion += 1;
      state.version += 1;
    }
    return;
  }
  const previousMembership = new Map(state.reserveNationByUnitId);
  const unitById = new Map(world.units.map((unit) => [unit.id, unit]));
  const activeNationIds = new Set(
    world.nations.filter(isNationActive).map((nation) => nation.id),
  );
  const next: NationReserveState[] = [];

  for (const nation of world.nations.filter(isNationActive).sort(compareNations)) {
    const landUnits = world.units.filter(
      (unit) => unit.domain === "land" && unit.nationId === nation.id,
    );
    let reserve = state.reservesByNationId.get(nation.id);
    if (!reserve) {
      reserve = createNationReserve(nation.id);
    }

    cleanInvalidMembership(world, reserve, unitById);
    reserve.desiredReserveStrength = calculateDesiredReserveStrength(
      world,
      nation.id,
      landUnits,
    );
    if (
      reserve.stagingRegionIds.length === 0 ||
      !reserve.stagingRegionIds.every((regionId) =>
        isSafeStagingRegion(world, nation.id, regionId),
      )
    ) {
      reserve.stagingRegionIds = selectStagingRegions(world, nation.id, landUnits);
    }

    const critical =
      getCapitalDefenseAssessment(world, nation.id)?.threatLevel === "critical";
    if (!critical && !reserve.deployment) {
      reconcileReserveMembership(world, reserve, landUnits, unitById);
    }
    refreshReserveStrength(reserve, unitById);

    if (reserve.deployment) {
      advanceDeployment(world, reserve, unitById);
    }

    const collapseTrigger = findFrontCollapseTrigger(world, reserve);
    const trigger = findDeploymentTrigger(world, reserve, collapseTrigger);
    const shouldOverrideReturn =
      reserve.deployment?.status === "returning" &&
      trigger?.reason === "capital-critical";
    if (
      trigger &&
      reserve.unitIds.length > 0 &&
      (!reserve.deployment || shouldOverrideReturn) &&
      (world.time.fastTick >= reserve.cooldownUntilTick ||
        trigger.reason === "capital-critical")
    ) {
      startDeployment(world, reserve, trigger, unitById);
    }

    if (!reserve.deployment) {
      reserve.status = reserveUnitsAreStaged(world, reserve, unitById)
        ? "ready"
        : "forming";
    }
    if (reserve.unitIds.length > 0 || reserve.desiredReserveStrength > 0) {
      next.push(reserve);
    }
  }

  for (const reserve of state.reserves) {
    if (!activeNationIds.has(reserve.nationId)) {
      recordEvent(world, reserve.nationId, "cleaned-up", "nation-inactive");
    }
  }

  state.reserves = next.sort((a, b) => compareIds(a.nationId, b.nationId));
  state.reservesByNationId = new Map(
    state.reserves.map((reserve) => [reserve.nationId, reserve]),
  );
  rebuildReserveMembershipIndex(state);
  const membershipChanges = countMembershipChanges(
    previousMembership,
    state.reserveNationByUnitId,
  );
  if (membershipChanges > 0) {
    state.membershipVersion += 1;
    state.membershipChangeCount += membershipChanges;
    world.instrumentation?.incrementCounter(
      "strategicReserve.membershipChanges",
      membershipChanges,
    );
  }
  state.version += 1;
  sampleReserveMetrics(world);
  captureCurrentFronts(world);
  trimTimeline(state);
  if (world.instrumentation) {
    world.instrumentation.recordDuration(
      "strategicReserve.evaluation",
      performance.now() - startedAt,
    );
  }
}

export function getNationReserveStates(
  world: WorldState,
): readonly NationReserveState[] {
  return world.strategicReserves.reserves;
}

export function getNationReserveState(
  world: WorldState,
  nationId: NationId,
): NationReserveState | undefined {
  return world.strategicReserves.reservesByNationId.get(nationId);
}

export function getReserveForUnit(
  world: WorldState,
  unitId: UnitId,
): NationReserveState | undefined {
  const nationId = world.strategicReserves.reserveNationByUnitId.get(unitId);
  return nationId
    ? world.strategicReserves.reservesByNationId.get(nationId)
    : undefined;
}

export function isStrategicReserveUnit(
  world: WorldState,
  unitId: UnitId,
): boolean {
  return world.strategicReserves.reserveNationByUnitId.has(unitId);
}

/** Releases reserve ownership before another exclusive land-AI system claims it. */
export function releaseStrategicReserveUnit(
  world: WorldState,
  unitId: UnitId,
): boolean {
  const state = world.strategicReserves;
  const nationId = state.reserveNationByUnitId.get(unitId);
  const reserve = nationId ? state.reservesByNationId.get(nationId) : undefined;
  if (!reserve) return false;
  reserve.unitIds = reserve.unitIds.filter((id) => id !== unitId);
  reserve.membershipStartedAtTickByUnitId.delete(unitId);
  if (reserve.deployment) {
    reserve.deployment.unitIds = reserve.deployment.unitIds.filter(
      (id) => id !== unitId,
    );
    reserve.deployment.unitTargetRegionIds.delete(unitId);
    if (reserve.deployment.unitIds.length === 0) {
      reserve.deployment = undefined;
      reserve.status = "forming";
    }
  }
  const unit = world.units.find((candidate) => candidate.id === unitId);
  reserve.totalStrength = Math.max(
    0,
    reserve.totalStrength - (unit ? finiteUnitStrength(unit) : 0),
  );
  state.reserveNationByUnitId.delete(unitId);
  state.membershipVersion += 1;
  state.membershipChangeCount += 1;
  state.version += 1;
  world.instrumentation?.incrementCounter("strategicReserve.membershipChanges");
  recordEvent(world, reserve.nationId, "membership-changed", `released:${unitId}`);
  return true;
}

/** Restores a ready unit to an existing reserve deficit without a second owner. */
export function assignUnitToStrategicReserve(
  world: WorldState,
  unitId: UnitId,
): boolean {
  const unit = world.units.find((candidate) => candidate.id === unitId);
  if (!unit || unit.domain !== "land") return false;
  if (
    world.reorganization.planIdByUnitId.has(unitId) ||
    world.retreatPlans.retreatIdByUnitId.has(unitId) ||
    world.offensiveOperations.operationIdByUnitId.has(unitId) ||
    world.frontAllocations.frontIdByUnitId.has(unitId)
  ) {
    return false;
  }
  const state = world.strategicReserves;
  const reserve = state.reservesByNationId.get(unit.nationId);
  if (!reserve || reserve.stagingRegionIds.length === 0) return false;
  if (reserve.unitIds.includes(unitId)) return true;
  reserve.unitIds.push(unitId);
  reserve.unitIds.sort(compareIds);
  reserve.membershipStartedAtTickByUnitId.set(unitId, world.time.fastTick);
  reserve.totalStrength += finiteUnitStrength(unit);
  reserve.status = reserve.deployment ? reserve.status : "forming";
  state.reserveNationByUnitId.set(unitId, unit.nationId);
  state.membershipVersion += 1;
  state.membershipChangeCount += 1;
  state.version += 1;
  world.instrumentation?.incrementCounter("strategicReserve.membershipChanges");
  recordEvent(world, reserve.nationId, "membership-changed", `returned:${unitId}`);
  return true;
}

export function getReserveTargetForUnit(
  reserve: NationReserveState,
  unitId: UnitId,
): MesoRegionId | undefined {
  const deployment = reserve.deployment;
  const deploymentIndex = deployment?.unitIds.indexOf(unitId) ?? -1;
  if (
    deployment &&
    deployment.status !== "returning" &&
    deploymentIndex >= 0 &&
    deployment.targetRegionIds.length > 0
  ) {
    return (
      deployment.unitTargetRegionIds.get(unitId) ??
      deployment.targetRegionIds[
        deploymentIndex % deployment.targetRegionIds.length
      ]
    );
  }
  const reserveIndex = reserve.unitIds.indexOf(unitId);
  return reserve.stagingRegionIds.length > 0 && reserveIndex >= 0
    ? reserve.stagingRegionIds[reserveIndex % reserve.stagingRegionIds.length]
    : undefined;
}

export function formatStrategicReserveSummary(world: WorldState): string {
  return world.strategicReserves.reserves
    .map((reserve) => {
      const deployment = reserve.deployment;
      return [
        `Nation ${reserve.nationId} Strategic Reserve`,
        `  desired strength: ${reserve.desiredReserveStrength.toFixed(1)}`,
        `  current strength: ${reserve.totalStrength.toFixed(1)}`,
        `  staging: ${reserve.stagingRegionIds.join(", ") || "none"}`,
        `  status: ${reserve.status}`,
        `  units: ${reserve.unitIds.length}`,
        ...(deployment
          ? [
              `  deployment: ${deployment.targetType}`,
              `  reason: ${deployment.reasonFlags.join(", ")}`,
              `  target: ${deployment.targetRegionIds.join(", ")}`,
              `  deployed: ${deployment.unitIds.length}`,
            ]
          : []),
      ].join("\n");
    })
    .join("\n");
}

function createNationReserve(nationId: NationId): NationReserveState {
  return {
    nationId,
    unitIds: [],
    totalStrength: 0,
    desiredReserveStrength: 0,
    stagingRegionIds: [],
    status: "forming",
    membershipStartedAtTickByUnitId: new Map(),
    cooldownUntilTick: 0,
    lastCollapseDeploymentAtTick: -1_000_000_000,
  };
}

function calculateDesiredReserveStrength(
  world: WorldState,
  nationId: NationId,
  landUnits: UnitState[],
): number {
  const settings = WORLD_BALANCE.war.landFront.strategicReserve;
  const totalStrength = sumStrength(landUnits);
  if (
    landUnits.length < settings.minimumLandUnitCount ||
    totalStrength < settings.minimumLandStrength
  ) {
    return 0;
  }
  const fronts = world.landFronts.physicalFrontsByNationId.get(nationId) ?? [];
  const hasWar = world.wars.some(
    (war) => war.nationAId === nationId || war.nationBId === nationId,
  );
  let ratio: number = hasWar
    ? settings.balancedWarRatio
    : settings.peacefulRatio;
  if (fronts.length >= settings.multiFrontCount) {
    const strengths = fronts.reduce(
      (totals, front) => {
        totals.friendly += getFrontSide(front, nationId)?.strength ?? 0;
        totals.enemy += getOpposingFrontSide(front, nationId)?.strength ?? 0;
        return totals;
      },
      { friendly: 0, enemy: 0 },
    );
    if (
      strengths.friendly <
      strengths.enemy * settings.disadvantagedStrengthRatio
    ) {
      ratio = settings.disadvantagedMultiFrontRatio;
    }
  }
  return finiteNumber(totalStrength * ratio);
}

function reconcileReserveMembership(
  world: WorldState,
  reserve: NationReserveState,
  landUnits: UnitState[],
  unitById: Map<UnitId, UnitState>,
): void {
  const settings = WORLD_BALANCE.war.landFront.strategicReserve;
  const now = world.time.fastTick;
  let strength = sumStrength(
    reserve.unitIds
      .map((unitId) => unitById.get(unitId))
      .filter((unit): unit is UnitState => !!unit),
  );
  const before = new Set(reserve.unitIds);

  if (strength > reserve.desiredReserveStrength) {
    const removable = reserve.unitIds
      .map((unitId) => unitById.get(unitId))
      .filter((unit): unit is UnitState => {
        if (!unit) return false;
        const since = reserve.membershipStartedAtTickByUnitId.get(unit.id) ?? now;
        return now - since >= settings.minimumMembershipTicks;
      })
      .sort(
        (a, b) =>
          reserveReadinessScore(a) - reserveReadinessScore(b) ||
          compareIds(a.id, b.id),
      );
    for (const unit of removable) {
      const unitStrength = finiteUnitStrength(unit);
      if (
        strength - unitStrength < reserve.desiredReserveStrength &&
        reserve.desiredReserveStrength > 0
      ) {
        continue;
      }
      reserve.unitIds = reserve.unitIds.filter((unitId) => unitId !== unit.id);
      reserve.membershipStartedAtTickByUnitId.delete(unit.id);
      strength -= unitStrength;
    }
  }

  if (strength < reserve.desiredReserveStrength) {
    const memberIds = new Set(reserve.unitIds);
    const scoreByUnitId = new Map<UnitId, number>();
    const candidates = landUnits
      .filter(
        (unit) =>
          !memberIds.has(unit.id) &&
          !world.retreatPlans.retreatIdByUnitId.has(unit.id) &&
          !world.offensiveOperations.operationIdByUnitId.has(unit.id) &&
          !world.reorganization.planIdByUnitId.has(unit.id) &&
          isReserveFormationCandidate(world, unit),
      )
      .sort((a, b) =>
        compareReserveCandidates(world, a, b, scoreByUnitId),
      );
    for (const unit of candidates) {
      if (strength >= reserve.desiredReserveStrength) break;
      reserve.unitIds.push(unit.id);
      reserve.membershipStartedAtTickByUnitId.set(unit.id, now);
      strength += finiteUnitStrength(unit);
    }
  }

  reserve.unitIds.sort(compareIds);
  const changed = !setsEqual(before, new Set(reserve.unitIds));
  if (changed) {
    if (before.size === 0 && reserve.unitIds.length > 0) {
      world.strategicReserves.formationCount += 1;
      world.instrumentation?.incrementCounter("strategicReserve.formations");
      recordEvent(world, reserve.nationId, "formed", `${reserve.unitIds.length}`);
    } else {
      recordEvent(
        world,
        reserve.nationId,
        "membership-changed",
        `${before.size}->${reserve.unitIds.length}`,
      );
    }
  }
}

function isReserveFormationCandidate(world: WorldState, unit: UnitState): boolean {
  if (unit.domain !== "land" || unit.manpower <= 0) return false;
  if (
    world.battles.some(
      (battle) =>
        battle.mesoId === unit.regionId &&
        (battle.attackerNationId === unit.nationId ||
          battle.defenderNationId === unit.nationId),
    )
  ) {
    return false;
  }
  const frontId = world.frontAllocations.frontIdByUnitId.get(unit.id);
  if (!frontId) return true;
  const allocation = world.frontAllocations.allocationsByFrontNation.get(
    `${frontId}::${unit.nationId}`,
  );
  if (!allocation || allocation.posture !== "hold") return false;
  const settings = WORLD_BALANCE.war.landFront.strategicReserve;
  const remainingStrength = allocation.allocatedStrength - finiteUnitStrength(unit);
  return (
    allocation.priority <= settings.lowPriorityFrontCeiling &&
    remainingStrength >=
      allocation.desiredStrength * settings.frontStrengthFloorRatio
  );
}

function compareReserveCandidates(
  world: WorldState,
  a: UnitState,
  b: UnitState,
  scoreByUnitId: Map<UnitId, number>,
): number {
  const scoreA = getOrCalculateReserveCandidateScore(world, a, scoreByUnitId);
  const scoreB = getOrCalculateReserveCandidateScore(world, b, scoreByUnitId);
  return scoreB - scoreA || compareIds(a.id, b.id);
}

function getOrCalculateReserveCandidateScore(
  world: WorldState,
  unit: UnitState,
  scoreByUnitId: Map<UnitId, number>,
): number {
  const cached = scoreByUnitId.get(unit.id);
  if (cached !== undefined) return cached;
  const score = reserveCandidateScore(world, unit);
  scoreByUnitId.set(unit.id, score);
  return score;
}

function reserveCandidateScore(world: WorldState, unit: UnitState): number {
  const frontId = world.frontAllocations.frontIdByUnitId.get(unit.id);
  const distance = frontId
    ? (getFrontDistanceField(world, frontId, unit.nationId)?.distanceByRegionId.get(
        unit.regionId,
      ) ?? 0)
    : 12;
  const unassignedBonus = frontId ? 0 : 100;
  return (
    unassignedBonus +
    distance * 4 +
    clamp(unit.org, 0, 1) * 30 +
    equipmentFulfillment(unit) * 20 +
    Math.log1p(finiteUnitStrength(unit)) * 5
  );
}

function findDeploymentTrigger(
  world: WorldState,
  reserve: NationReserveState,
  collapseTrigger: DeploymentTrigger | null,
): DeploymentTrigger | null {
  const capital = getCapitalDefenseAssessment(world, reserve.nationId);
  if (capital?.threatLevel === "critical") {
    return {
      targetType: "capital-defense",
      targetFrontId: capital.primaryFrontId ?? undefined,
      targetRegionIds: selectCapitalDeploymentAnchor(world, capital),
      targetStrength: Number.POSITIVE_INFINITY,
      initialDeficit: Math.max(
        0,
        capital.minimumDefenseStrength - capital.friendlyStrength,
      ),
      reason: "capital-critical",
      capitalEmergencyStartedAtTick: capital.emergencyStartedAtTick,
    };
  }

  const severe = world.frontAllocations.allocations
    .filter(
      (allocation) =>
        allocation.nationId === reserve.nationId &&
        allocation.posture === "reinforce" &&
        allocation.desiredStrength > 0 &&
        allocation.deficit / allocation.desiredStrength >=
          WORLD_BALANCE.war.landFront.strategicReserve.severeDeficitRatio,
    )
    .sort(
      (a, b) =>
        b.priority * (b.deficit / b.desiredStrength) -
          a.priority * (a.deficit / a.desiredStrength) ||
        compareIds(a.frontId, b.frontId),
    )[0];
  if (severe) {
    const front = world.landFronts.physicalFrontsById.get(severe.frontId);
    const friendly = front ? getFrontSide(front, reserve.nationId) : undefined;
    if (friendly && friendly.borderRegionIds.length > 0) {
      return {
        targetType: "front-reinforcement",
        targetFrontId: severe.frontId,
        targetRegionIds: friendly.borderRegionIds,
        targetStrength:
          severe.deficit *
          WORLD_BALANCE.war.landFront.strategicReserve.reinforcementMargin,
        initialDeficit: severe.deficit,
        reason: "front-severe-deficit",
        capitalEmergencyStartedAtTick: null,
      };
    }
  }

  const retreat = world.retreatPlans.plans
    .filter(
      (plan) =>
        plan.nationId === reserve.nationId &&
        plan.phase === "withdrawing" &&
        fallbackHasEnemyPressure(world, plan.nationId, plan.fallbackRegionIds),
    )
    .sort(
      (a, b) =>
        b.initialEnemyStrength - a.initialEnemyStrength ||
        compareIds(a.id, b.id),
    )[0];
  if (retreat) {
    return {
      targetType: "retreat-support",
      targetFrontId: retreat.frontId,
      targetRegionIds: retreat.fallbackRegionIds,
      targetStrength:
        reserve.totalStrength *
        WORLD_BALANCE.war.landFront.strategicReserve.retreatDeploymentRatio,
      initialDeficit: Math.max(
        0,
        retreat.initialEnemyStrength - retreat.currentRetreatingStrength,
      ),
      reason: "retreat-fallback-threat",
      capitalEmergencyStartedAtTick: null,
    };
  }
  return collapseTrigger;
}

function selectCapitalDeploymentAnchor(
  world: WorldState,
  capital: NonNullable<ReturnType<typeof getCapitalDefenseAssessment>>,
): MesoRegionId[] {
  if (capital.defenseRegionIds.includes(capital.capitalRegionId)) {
    return [capital.capitalRegionId];
  }
  const mesoById = getMesoById(world);
  const center = mesoById.get(capital.capitalRegionId)?.center;
  const nearest = [...capital.defenseRegionIds].sort((a, b) => {
    const centerA = mesoById.get(a)?.center;
    const centerB = mesoById.get(b)?.center;
    const distanceA = center && centerA ? distanceSquared(center, centerA) : 0;
    const distanceB = center && centerB ? distanceSquared(center, centerB) : 0;
    return distanceA - distanceB || compareIds(a, b);
  })[0];
  return nearest ? [nearest] : [];
}

function startDeployment(
  world: WorldState,
  reserve: NationReserveState,
  trigger: DeploymentTrigger,
  unitById: Map<UnitId, UnitState>,
): void {
  const candidates = reserve.unitIds
    .map((unitId) => unitById.get(unitId))
    .filter((unit): unit is UnitState => !!unit)
    .sort(
      (a, b) =>
        reserveReadinessScore(b) - reserveReadinessScore(a) ||
        compareIds(a.id, b.id),
    );
  const selected: UnitId[] = [];
  let strength = 0;
  for (const unit of candidates) {
    if (strength >= trigger.targetStrength && selected.length > 0) break;
    selected.push(unit.id);
    strength += finiteUnitStrength(unit);
  }
  if (selected.length === 0 || trigger.targetRegionIds.length === 0) return;
  const targetRegionIds = [...new Set(trigger.targetRegionIds)].sort(compareIds);
  reserve.deployment = {
    targetType: trigger.targetType,
    targetFrontId: trigger.targetFrontId,
    targetRegionIds,
    unitIds: selected.sort(compareIds),
    unitTargetRegionIds: assignDeploymentTargets(
      world,
      reserve.nationId,
      selected,
      targetRegionIds,
      unitById,
    ),
    startedAtTick: world.time.fastTick,
    status: "moving",
    reasonFlags: [trigger.reason],
    firstArrivalAtTick: null,
    initialTargetDeficit: finiteNumber(trigger.initialDeficit),
    lastEffectiveDeficit: finiteNumber(trigger.initialDeficit),
    lastArrivedUnitCount: 0,
    capitalEmergencyStartedAtTick: trigger.capitalEmergencyStartedAtTick,
  };
  reserve.status = "deploying";
  const state = world.strategicReserves;
  state.deploymentCount += 1;
  state.deploymentCountByReason[trigger.reason] += 1;
  state.deployedUnitCount += selected.length;
  if (trigger.reason === "front-collapse") {
    reserve.lastCollapseDeploymentAtTick = world.time.fastTick;
  }
  world.instrumentation?.incrementCounter("strategicReserve.deployments");
  world.instrumentation?.incrementCounter(
    `strategicReserve.deployments.${trigger.reason}`,
  );
  world.instrumentation?.incrementCounter(
    "strategicReserve.deployedUnits",
    selected.length,
  );
  recordEvent(
    world,
    reserve.nationId,
    "deployment-started",
    `${trigger.reason}:${selected.length}`,
  );
}

function advanceDeployment(
  world: WorldState,
  reserve: NationReserveState,
  unitById: Map<UnitId, UnitState>,
): void {
  const deployment = reserve.deployment;
  if (!deployment) return;
  deployment.unitIds = deployment.unitIds.filter((unitId) =>
    reserve.unitIds.includes(unitId),
  );
  if (deployment.status === "returning") {
    reserve.status = "returning";
    if (reserveUnitsAreStaged(world, reserve, unitById)) {
      reserve.deployment = undefined;
      reserve.status = "ready";
      reserve.cooldownUntilTick =
        world.time.fastTick +
        WORLD_BALANCE.war.landFront.strategicReserve.returnCooldownTicks;
      world.strategicReserves.returnCompletedCount += 1;
      world.instrumentation?.incrementCounter("strategicReserve.returnsCompleted");
      recordEvent(world, reserve.nationId, "return-completed", "staged");
    }
    return;
  }

  const targetIds = new Set(deployment.targetRegionIds);
  const arrivedUnits = deployment.unitIds
    .map((unitId) => unitById.get(unitId))
    .filter(
      (unit): unit is UnitState => !!unit && targetIds.has(unit.regionId),
    );
  if (arrivedUnits.length > 0 && deployment.firstArrivalAtTick === null) {
    deployment.firstArrivalAtTick = world.time.fastTick;
    const latency = Math.max(0, world.time.fastTick - deployment.startedAtTick);
    world.strategicReserves.arrivalLatencyTicks += latency;
    world.strategicReserves.arrivalLatencySampleCount += 1;
    world.instrumentation?.incrementCounter(
      "strategicReserve.arrivalLatencyTicks",
      latency,
    );
    world.instrumentation?.incrementCounter("strategicReserve.arrivals");
    if (
      deployment.targetType === "capital-defense" &&
      deployment.capitalEmergencyStartedAtTick !== null
    ) {
      const capitalLatency = Math.max(
        0,
        world.time.fastTick - deployment.capitalEmergencyStartedAtTick,
      );
      world.strategicReserves.capitalArrivalLatencyTicks += capitalLatency;
      world.strategicReserves.capitalArrivalLatencySampleCount += 1;
      world.instrumentation?.incrementCounter(
        "strategicReserve.capitalArrivalLatencyTicks",
        capitalLatency,
      );
      world.instrumentation?.incrementCounter("strategicReserve.capitalArrivals");
    }
  }
  if (deployment.targetType === "retreat-support") {
    const newlyArrived = Math.max(
      0,
      arrivedUnits.length - deployment.lastArrivedUnitCount,
    );
    world.strategicReserves.retreatFallbackArrivalCount += newlyArrived;
    world.instrumentation?.incrementCounter(
      "strategicReserve.retreatFallbackArrivals",
      newlyArrived,
    );
  }
  deployment.lastArrivedUnitCount = arrivedUnits.length;

  const arrivalRatio =
    arrivedUnits.length / Math.max(1, deployment.unitIds.length);
  if (
    deployment.status === "moving" &&
    arrivalRatio >= WORLD_BALANCE.war.landFront.strategicReserve.arrivalRatio
  ) {
    deployment.status = "engaged";
    reserve.status = "deploying";
    recordEvent(
      world,
      reserve.nationId,
      "deployment-engaged",
      deployment.targetType,
    );
  }

  const arrivedStrength = sumStrength(arrivedUnits);
  const currentRawDeficit = deployment.targetFrontId
    ? (world.frontAllocations.allocationsByFrontNation.get(
        `${deployment.targetFrontId}::${reserve.nationId}`,
      )?.deficit ?? 0)
    : deployment.initialTargetDeficit;
  const effectiveDeficit = Math.max(0, currentRawDeficit - arrivedStrength);
  const improvement = Math.max(
    0,
    deployment.lastEffectiveDeficit - effectiveDeficit,
  );
  world.strategicReserves.frontDeficitImprovement += improvement;
  world.instrumentation?.incrementCounter(
    "strategicReserve.frontDeficitImprovement",
    improvement,
  );
  deployment.lastEffectiveDeficit = effectiveDeficit;

  if (deploymentShouldReturn(world, reserve, deployment, effectiveDeficit)) {
    beginReturn(world, reserve);
  }
}

function deploymentShouldReturn(
  world: WorldState,
  reserve: NationReserveState,
  deployment: ReserveDeployment,
  effectiveDeficit: number,
): boolean {
  const hasWar = world.wars.some(
    (war) =>
      war.nationAId === reserve.nationId || war.nationBId === reserve.nationId,
  );
  if (!hasWar) return true;
  const elapsed = world.time.fastTick - deployment.startedAtTick;
  if (
    elapsed < WORLD_BALANCE.war.landFront.strategicReserve.minimumDeploymentTicks
  ) {
    return false;
  }
  if (deployment.targetType === "capital-defense") {
    return (
      getCapitalDefenseAssessment(world, reserve.nationId)?.threatLevel !==
      "critical"
    );
  }
  if (deployment.targetType === "front-reinforcement") {
    const allocation = deployment.targetFrontId
      ? world.frontAllocations.allocationsByFrontNation.get(
          `${deployment.targetFrontId}::${reserve.nationId}`,
        )
      : undefined;
    return (
      !allocation ||
      allocation.posture !== "reinforce" ||
      effectiveDeficit <= allocation.desiredStrength * 0.1
    );
  }
  if (deployment.targetType === "retreat-support") {
    return !world.retreatPlans.plans.some(
      (retreat) =>
        retreat.nationId === reserve.nationId &&
        retreat.frontId === deployment.targetFrontId &&
        retreat.phase === "withdrawing",
    );
  }
  return (
    !deployment.targetFrontId ||
    !world.landFronts.physicalFrontsById.has(deployment.targetFrontId) ||
    (deployment.status === "engaged" &&
      elapsed >= WORLD_BALANCE.war.landFront.strategicReserve.stableFrontTicks)
  );
}

function beginReturn(world: WorldState, reserve: NationReserveState): void {
  if (!reserve.deployment || reserve.deployment.status === "returning") return;
  reserve.deployment.status = "returning";
  reserve.status = "returning";
  world.strategicReserves.returnStartedCount += 1;
  world.instrumentation?.incrementCounter("strategicReserve.returnsStarted");
  recordEvent(
    world,
    reserve.nationId,
    "return-started",
    reserve.deployment.targetType,
  );
}

function findFrontCollapseTrigger(
  world: WorldState,
  reserve: NationReserveState,
): DeploymentTrigger | null {
  const nationId = reserve.nationId;
  if (
    world.time.fastTick - reserve.lastCollapseDeploymentAtTick <
    WORLD_BALANCE.war.landFront.strategicReserve
      .collapseDeploymentCooldownTicks
  ) {
    return null;
  }
  const hasRecentCollapseRetreat = [
    ...world.retreatPlans.plans,
    ...world.retreatPlans.history,
  ].some(
    (retreat) =>
      retreat.nationId === nationId &&
      retreat.reasonFlags.includes("front-collapse") &&
      world.time.fastTick - retreat.createdAtTick <=
        WORLD_BALANCE.war.landFront.strategicReserve
          .collapseResponseWindowTicks,
  );
  if (!hasRecentCollapseRetreat) return null;
  const previous = world.strategicReserves.previousFrontIdsByNationId.get(nationId);
  if (!previous || previous.size === 0) return null;
  const current = world.landFronts.physicalFrontsByNationId.get(nationId) ?? [];
  const currentIds = new Set(current.map((front) => front.id));
  const removedEnemyIds = new Set<NationId>();
  for (const frontId of previous) {
    if (currentIds.has(frontId)) continue;
    const enemyId = world.strategicReserves.previousEnemyNationByFrontNation.get(
      `${nationId}::${frontId}`,
    );
    if (enemyId) removedEnemyIds.add(enemyId);
  }
  const replacement = current
    .filter((front) => {
      if (previous.has(front.id)) return false;
      const enemy = getOpposingFrontSide(front, nationId);
      return !!enemy && removedEnemyIds.has(enemy.nationId);
    })
    .sort((a, b) => compareIds(a.id, b.id))[0];
  const friendly = replacement ? getFrontSide(replacement, nationId) : undefined;
  if (!replacement || !friendly || friendly.borderRegionIds.length === 0) {
    return null;
  }
  return {
    targetType: "front-collapse",
    targetFrontId: replacement.id,
    targetRegionIds: friendly.borderRegionIds,
    targetStrength: Number.POSITIVE_INFINITY,
    initialDeficit:
      world.frontAllocations.allocationsByFrontNation.get(
        `${replacement.id}::${nationId}`,
      )?.deficit ?? 0,
    reason: "front-collapse",
    capitalEmergencyStartedAtTick: null,
  };
}

function fallbackHasEnemyPressure(
  world: WorldState,
  nationId: NationId,
  fallbackRegionIds: MesoRegionId[],
): boolean {
  const radius = WORLD_BALANCE.war.landFront.strategicReserve.fallbackThreatRadius;
  const neighborsById = getNeighborsById(world);
  const threatened = new Set(fallbackRegionIds);
  let frontier = [...fallbackRegionIds];
  for (let depth = 0; depth < radius; depth += 1) {
    const next: MesoRegionId[] = [];
    for (const regionId of frontier) {
      for (const neighborId of neighborsById.get(regionId) ?? []) {
        if (threatened.has(neighborId)) continue;
        threatened.add(neighborId);
        next.push(neighborId);
      }
    }
    frontier = next;
  }
  const warAdjacency = buildWarAdjacency(world.wars);
  return world.units.some(
    (unit) =>
      unit.domain === "land" &&
      threatened.has(unit.regionId) &&
      isAtWar(nationId, unit.nationId, warAdjacency),
  );
}

function selectStagingRegions(
  world: WorldState,
  nationId: NationId,
  landUnits: UnitState[],
): MesoRegionId[] {
  const nation = world.nations.find((candidate) => candidate.id === nationId);
  if (!nation) return [];
  const mesoById = getMesoById(world);
  const anchor = isControlledLand(world, nationId, nation.capitalMesoId)
    ? nation.capitalMesoId
    : landUnits.find((unit) => isControlledLand(world, nationId, unit.regionId))
        ?.regionId;
  if (!anchor) return [];
  const reachable = getControlledDistanceField(world, nationId, [anchor])
    .distanceByRegionId;
  const enemyRegionIds = getEnemyRegionIds(world, nationId);
  const fronts =
    world.landFronts.physicalFrontsByNationId.get(nationId) ?? [];
  const frontDistanceMaps = fronts.flatMap((front) => {
    const field = getFrontDistanceField(world, front.id, nationId);
    return field ? [field.distanceByRegionId] : [];
  });
  const directFrontIds = new Set<MesoRegionId>();
  for (const front of fronts) {
    const side = getFrontSide(front, nationId);
    for (const regionId of side?.borderRegionIds ?? []) directFrontIds.add(regionId);
  }
  const candidates = [...reachable.keys()]
    .filter(
      (regionId) =>
        !directFrontIds.has(regionId) &&
        !enemyRegionIds.has(regionId),
    )
    .map((regionId) => {
      const meso = mesoById.get(regionId);
      const capitalBonus = regionId === nation.capitalMesoId ? 10_000 : 0;
      const cityBonus = meso?.building === "city" ? 500 : 0;
      const frontDistances = frontDistanceMaps
        .map((distanceByRegionId) => distanceByRegionId.get(regionId))
        .filter((distance): distance is number => distance !== undefined);
      const averageFrontDistance =
        frontDistances.length > 0
          ? frontDistances.reduce((total, value) => total + value, 0) /
            frontDistances.length
          : (reachable.get(regionId) ?? 0);
      return {
        regionId,
        score: capitalBonus + cityBonus - averageFrontDistance * 10,
      };
    })
    .sort((a, b) => b.score - a.score || compareIds(a.regionId, b.regionId));
  return candidates
    .slice(0, WORLD_BALANCE.war.landFront.strategicReserve.stagingRegionCount)
    .map((candidate) => candidate.regionId);
}

function isSafeStagingRegion(
  world: WorldState,
  nationId: NationId,
  regionId: MesoRegionId,
): boolean {
  return isSafeControlledRegion(world, nationId, regionId);
}

function isControlledLand(
  world: WorldState,
  nationId: NationId,
  regionId: MesoRegionId,
): boolean {
  return getControlledRegions(world, nationId).has(regionId);
}

function reserveUnitsAreStaged(
  world: WorldState,
  reserve: NationReserveState,
  unitById: Map<UnitId, UnitState>,
): boolean {
  if (reserve.unitIds.length === 0) return true;
  const staging = new Set(reserve.stagingRegionIds);
  return (
    staging.size > 0 &&
    reserve.unitIds.every((unitId) => {
      const unit = unitById.get(unitId);
      return !!unit && staging.has(unit.regionId);
    })
  );
}

function cleanInvalidMembership(
  world: WorldState,
  reserve: NationReserveState,
  unitById: Map<UnitId, UnitState>,
): void {
  reserve.unitIds = reserve.unitIds.filter((unitId) => {
    const unit = unitById.get(unitId);
    const valid =
      !!unit && unit.domain === "land" && unit.nationId === reserve.nationId;
    if (!valid) reserve.membershipStartedAtTickByUnitId.delete(unitId);
    return valid;
  });
  if (reserve.deployment) {
    reserve.deployment.unitIds = reserve.deployment.unitIds.filter((unitId) =>
      reserve.unitIds.includes(unitId),
    );
    for (const unitId of reserve.deployment.unitTargetRegionIds.keys()) {
      if (!reserve.deployment.unitIds.includes(unitId)) {
        reserve.deployment.unitTargetRegionIds.delete(unitId);
      }
    }
    reserve.deployment.targetRegionIds = reserve.deployment.targetRegionIds.filter(
      (regionId) => getMesoById(world).get(regionId)?.type !== "sea",
    );
    if (
      reserve.deployment.unitIds.length === 0 ||
      reserve.deployment.targetRegionIds.length === 0
    ) {
      reserve.deployment = undefined;
    }
  }
}

function assignDeploymentTargets(
  world: WorldState,
  nationId: NationId,
  unitIds: UnitId[],
  targetRegionIds: MesoRegionId[],
  unitById: Map<UnitId, UnitState>,
): Map<UnitId, MesoRegionId> {
  const neighborsById = getNeighborsById(world);
  const mesoById = getMesoById(world);
  const ownerByMesoId = getOwnerByMesoId(world);
  const nearestTargetByRegion = new Map<MesoRegionId, MesoRegionId>();
  const queue = [...targetRegionIds].sort(compareIds);
  for (const targetId of queue) nearestTargetByRegion.set(targetId, targetId);
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    const sourceTarget = nearestTargetByRegion.get(current);
    if (!sourceTarget) continue;
    for (const neighborId of neighborsById.get(current) ?? []) {
      const meso = mesoById.get(neighborId);
      const owner = ownerByMesoId.get(neighborId);
      const controller = world.occupation.mesoById.get(neighborId) ?? owner;
      if (
        !meso ||
        meso.type === "sea" ||
        controller !== nationId ||
        nearestTargetByRegion.has(neighborId)
      ) {
        continue;
      }
      nearestTargetByRegion.set(neighborId, sourceTarget);
      queue.push(neighborId);
    }
  }
  const fallback = targetRegionIds[0];
  return new Map(
    unitIds.flatMap((unitId) => {
      const unit = unitById.get(unitId);
      const target = unit
        ? (nearestTargetByRegion.get(unit.regionId) ?? fallback)
        : fallback;
      return target ? [[unitId, target] as const] : [];
    }),
  );
}

function refreshReserveStrength(
  reserve: NationReserveState,
  unitById: Map<UnitId, UnitState>,
): void {
  reserve.totalStrength = sumStrength(
    reserve.unitIds
      .map((unitId) => unitById.get(unitId))
      .filter((unit): unit is UnitState => !!unit),
  );
}

function rebuildReserveMembershipIndex(state: StrategicReserveState): void {
  const index = new Map<UnitId, NationId>();
  for (const reserve of state.reserves) {
    for (const unitId of reserve.unitIds) index.set(unitId, reserve.nationId);
  }
  state.reserveNationByUnitId = index;
}

function captureCurrentFronts(world: WorldState): void {
  const frontIdsByNationId = new Map<NationId, Set<FrontId>>();
  const enemyByFrontNation = new Map<string, NationId>();
  for (const front of world.landFronts.physicalFronts) {
    for (const nationId of [front.nationAId, front.nationBId]) {
      let ids = frontIdsByNationId.get(nationId);
      if (!ids) {
        ids = new Set();
        frontIdsByNationId.set(nationId, ids);
      }
      ids.add(front.id);
      const enemy = getOpposingFrontSide(front, nationId);
      if (enemy) {
        enemyByFrontNation.set(`${nationId}::${front.id}`, enemy.nationId);
      }
    }
  }
  world.strategicReserves.previousFrontIdsByNationId = frontIdsByNationId;
  world.strategicReserves.previousEnemyNationByFrontNation = enemyByFrontNation;
}

function sampleReserveMetrics(world: WorldState): void {
  const state = world.strategicReserves;
  const unitCount = state.reserves.reduce(
    (total, reserve) => total + reserve.unitIds.length,
    0,
  );
  const strength = state.reserves.reduce(
    (total, reserve) => total + reserve.totalStrength,
    0,
  );
  state.sampleCount += 1;
  state.sampledUnitCount += unitCount;
  state.sampledStrength += strength;
  world.instrumentation?.incrementCounter("strategicReserve.sampleCount");
  world.instrumentation?.incrementCounter(
    "strategicReserve.sampledUnits",
    unitCount,
  );
  world.instrumentation?.incrementCounter(
    "strategicReserve.sampledStrength",
    strength,
  );
}

function recordEvent(
  world: WorldState,
  nationId: NationId,
  type: ReserveEventType,
  detail: string,
): void {
  world.strategicReserves.timeline.push({
    tick: world.time.fastTick,
    nationId,
    type,
    detail,
  });
}

function trimTimeline(state: StrategicReserveState): void {
  const limit = WORLD_BALANCE.war.landFront.strategicReserve.timelineLimit;
  if (state.timeline.length > limit) {
    state.timeline.splice(0, state.timeline.length - limit);
  }
}

function countMembershipChanges(
  previous: Map<UnitId, NationId>,
  next: Map<UnitId, NationId>,
): number {
  let count = 0;
  for (const unitId of new Set([...previous.keys(), ...next.keys()])) {
    if (previous.get(unitId) !== next.get(unitId)) count += 1;
  }
  return count;
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

function reserveReadinessScore(unit: UnitState): number {
  return (
    clamp(unit.org, 0, 1) * 30 +
    equipmentFulfillment(unit) * 20 +
    Math.log1p(finiteUnitStrength(unit)) * 5
  );
}

function equipmentFulfillment(unit: UnitState): number {
  if (unit.equipment.length === 0) return 1;
  return finiteNumber(
    unit.equipment.reduce((total, slot) => total + slot.fill, 0) /
      unit.equipment.length,
  );
}

function sumStrength(units: UnitState[]): number {
  return finiteNumber(
    units.reduce((total, unit) => total + finiteUnitStrength(unit), 0),
  );
}

function finiteUnitStrength(unit: UnitState): number {
  return finiteNumber(getUnitCombatStrength(unit));
}

function finiteNumber(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function distanceSquared(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function compareNations(
  a: WorldState["nations"][number],
  b: WorldState["nations"][number],
): number {
  return compareIds(a.id, b.id);
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
