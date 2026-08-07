import { WORLD_BALANCE } from "../data/balance";
import type { MesoRegion, MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import {
  getFrontSide,
  getOpposingFrontSide,
  type FrontId,
  type PhysicalFront,
} from "./land-fronts";
import {
  getFrontAllocation,
  type NationFrontAllocation,
} from "./nation-front-allocations";
import { getFrontPlan, type NationFrontPlan } from "./nation-front-plans";
import type { UnitId, UnitState } from "./unit";
import { getUnitCombatStrength } from "./unit-strength";
import { buildWarAdjacency, isAtWar } from "./war-state";
import type { WorldState } from "./world-state";
import { getMesoById, getNeighborsById, getOwnerByMesoId } from "./world-cache";

export type OperationId = string & { __brand: "OperationId" };

export type OffensiveOperationPhase =
  | "preparing"
  | "attacking"
  | "recovering";

export type OffensiveOperationOutcome =
  | "success"
  | "failure"
  | "cancelled";

export type OffensiveOperationReason =
  | "front-superiority"
  | "enemy-capital-opportunity"
  | "enemy-city-opportunity"
  | "high-front-priority"
  | "weak-enemy-presence";

export type OffensiveOperationCompletionReason =
  | "primary-target-occupied"
  | "supporting-targets-occupied"
  | "attack-expired"
  | "force-depleted"
  | "strength-collapsed"
  | "target-unreachable"
  | "target-invalid"
  | "front-disappeared"
  | "war-ended"
  | "posture-changed"
  | "allocation-lost";

export type OffensiveOperationEventType =
  | "created"
  | "phase-transition"
  | "front-remapped"
  | "success"
  | "failure"
  | "cancelled"
  | "recovery-complete";

export interface OffensiveOperation {
  id: OperationId;
  nationId: NationId;
  enemyNationId: NationId;
  frontId: FrontId;
  phase: OffensiveOperationPhase;
  primaryTargetRegionId: MesoRegionId;
  supportingTargetRegionIds: MesoRegionId[];
  stagingRegionId: MesoRegionId;
  assignedUnitIds: UnitId[];
  assignedStrength: number;
  initialAssignedUnitIds: UnitId[];
  initialAssignedUnitCount: number;
  initialAssignedStrength: number;
  unitTargetRegionIds: Map<UnitId, MesoRegionId>;
  startedAtTick: number;
  phaseStartedAtTick: number;
  minimumCommitUntilTick: number;
  expiresAtTick: number;
  initialFriendlyStrength: number;
  initialEnemyStrength: number;
  initialStrengthRatio: number;
  reasonFlags: OffensiveOperationReason[];
  outcome: OffensiveOperationOutcome | null;
  completionReason: OffensiveOperationCompletionReason | null;
  completedAtTick: number | null;
}

export interface OffensiveOperationEvent {
  tick: number;
  operationId: OperationId;
  nationId: NationId;
  frontId: FrontId;
  type: OffensiveOperationEventType;
  phase: OffensiveOperationPhase;
  detail: string;
}

export interface OffensiveOperationState {
  operations: OffensiveOperation[];
  operationsById: Map<OperationId, OffensiveOperation>;
  operationsByNationId: Map<NationId, OffensiveOperation[]>;
  operationsByFrontNation: Map<string, OffensiveOperation>;
  operationIdByUnitId: Map<UnitId, OperationId>;
  history: OffensiveOperation[];
  timeline: OffensiveOperationEvent[];
  version: number;
  membershipVersion: number;
  nextOperationNumber: number;
  createdCount: number;
  completedCount: number;
  failedCount: number;
  cancelledCount: number;
  phaseTransitionCount: number;
  unitAssignmentCount: number;
  targetChangeCount: number;
  unitTargetSwitchCount: number;
  preparingDurationTicks: number;
  attackingDurationTicks: number;
  maxTargetConcentration: number;
}

interface OperationTargetSelection {
  primaryTargetRegionId: MesoRegionId;
  supportingTargetRegionIds: MesoRegionId[];
  stagingRegionId: MesoRegionId;
  nearbyEnemyStrength: number;
}

interface OperationAdvanceResult {
  keep: boolean;
  changed: boolean;
}

export function createOffensiveOperationState(): OffensiveOperationState {
  return {
    operations: [],
    operationsById: new Map(),
    operationsByNationId: new Map(),
    operationsByFrontNation: new Map(),
    operationIdByUnitId: new Map(),
    history: [],
    timeline: [],
    version: 0,
    membershipVersion: 0,
    nextOperationNumber: 0,
    createdCount: 0,
    completedCount: 0,
    failedCount: 0,
    cancelledCount: 0,
    phaseTransitionCount: 0,
    unitAssignmentCount: 0,
    targetChangeCount: 0,
    unitTargetSwitchCount: 0,
    preparingDurationTicks: 0,
    attackingDurationTicks: 0,
    maxTargetConcentration: 0,
  };
}

export function updateOffensiveOperations(world: WorldState): void {
  const state = world.offensiveOperations;
  const startedAt = world.instrumentation ? performance.now() : 0;
  const previousMembership = state.operationIdByUnitId;
  let changed = false;
  const retained: OffensiveOperation[] = [];

  for (const operation of state.operations) {
    const result = advanceOperation(world, operation);
    changed = changed || result.changed;
    if (result.keep) {
      retained.push(operation);
    } else {
      archiveOperation(world, operation);
    }
  }
  state.operations = retained;
  rebuildOperationIndexes(state);

  const settings = WORLD_BALANCE.war.landFront.offensiveOperation;
  const plansByNation = [...world.frontPlans.plansByNationId.entries()].sort(
    ([nationA], [nationB]) => compareIds(nationA, nationB),
  );
  for (const [nationId, plans] of plansByNation) {
    const current = state.operationsByNationId.get(nationId) ?? [];
    if (current.length >= settings.maxActivePerNation) {
      continue;
    }
    const candidates = plans
      .filter((plan) => plan.posture === "attack")
      .sort(compareOperationCandidatePlans);
    for (const plan of candidates) {
      if (
        (state.operationsByNationId.get(nationId)?.length ?? 0) >=
        settings.maxActivePerNation
      ) {
        break;
      }
      if (state.operationsByFrontNation.has(createFrontNationKey(plan.frontId, nationId))) {
        continue;
      }
      const operation = createOperation(world, plan);
      if (!operation) {
        continue;
      }
      state.operations.push(operation);
      state.createdCount += 1;
      state.unitAssignmentCount += operation.assignedUnitIds.length;
      world.instrumentation?.incrementCounter("offensiveOperation.created");
      world.instrumentation?.incrementCounter(
        "offensiveOperation.unitAssignments",
        operation.assignedUnitIds.length,
      );
      recordEvent(world, operation, "created", "attack-front-selected");
      changed = true;
      rebuildOperationIndexes(state);
    }
  }

  rebuildOperationIndexes(state);
  const membershipChanged = !areAssignmentMapsEqual(
    previousMembership,
    state.operationIdByUnitId,
  );
  if (membershipChanged) {
    state.membershipVersion += 1;
  }
  if (changed || membershipChanged) {
    state.version += 1;
  }

  sampleOperationMetrics(world);
  if (world.instrumentation) {
    world.instrumentation.recordDuration(
      "offensiveOperation.evaluation",
      performance.now() - startedAt,
    );
  }
}

export function getOffensiveOperations(
  world: WorldState,
  nationId?: NationId,
): readonly OffensiveOperation[] {
  return nationId === undefined
    ? world.offensiveOperations.operations
    : (world.offensiveOperations.operationsByNationId.get(nationId) ?? []);
}

export function getOffensiveOperationForFront(
  world: WorldState,
  frontId: FrontId,
  nationId: NationId,
): OffensiveOperation | undefined {
  return world.offensiveOperations.operationsByFrontNation.get(
    createFrontNationKey(frontId, nationId),
  );
}

export function getOffensiveOperationForUnit(
  world: WorldState,
  unitId: UnitId,
): OffensiveOperation | undefined {
  const operationId = world.offensiveOperations.operationIdByUnitId.get(unitId);
  return operationId
    ? world.offensiveOperations.operationsById.get(operationId)
    : undefined;
}

export function formatOffensiveOperationSummary(world: WorldState): string {
  const lines: string[] = [];
  for (const operation of world.offensiveOperations.operations) {
    lines.push(
      `${operation.id} ${operation.nationId} vs ${operation.enemyNationId}`,
      `  Front: ${operation.frontId}`,
      `  phase: ${operation.phase}`,
      `  primary: ${operation.primaryTargetRegionId}`,
      `  supporting: ${operation.supportingTargetRegionIds.join(", ") || "none"}`,
      `  staging: ${operation.stagingRegionId}`,
      `  units: ${operation.assignedUnitIds.length}`,
      `  strength: ${operation.assignedStrength.toFixed(1)}`,
      `  started: ${operation.startedAtTick}`,
      `  outcome: ${operation.outcome ?? "active"}`,
      `  completion: ${operation.completionReason ?? "none"}`,
      `  reasons: ${operation.reasonFlags.join(", ")}`,
    );
  }
  return lines.join("\n");
}

function advanceOperation(
  world: WorldState,
  operation: OffensiveOperation,
): OperationAdvanceResult {
  const now = world.time.fastTick;
  let operationChanged = false;
  if (operation.phase === "recovering") {
    if (now < operation.expiresAtTick) {
      return { keep: true, changed: false };
    }
    recordEvent(world, operation, "recovery-complete", "cooldown-complete");
    return { keep: false, changed: true };
  }

  if (
    operation.phase === "attacking" &&
    isRegionControlledBy(world, operation.primaryTargetRegionId, operation.nationId)
  ) {
    finishOperation(
      world,
      operation,
      "success",
      "primary-target-occupied",
    );
    return { keep: true, changed: true };
  }
  if (
    operation.phase === "attacking" &&
    hasOccupiedSupportingMajority(world, operation)
  ) {
    finishOperation(
      world,
      operation,
      "success",
      "supporting-targets-occupied",
    );
    return { keep: true, changed: true };
  }

  const warAdjacency = buildWarAdjacency(world.wars);
  if (!isAtWar(operation.nationId, operation.enemyNationId, warAdjacency)) {
    finishOperation(world, operation, "cancelled", "war-ended");
    return { keep: true, changed: true };
  }
  let front = world.landFronts.physicalFrontsById.get(operation.frontId);
  if (!front) {
    const replacement = findContinuationFront(world, operation);
    if (!replacement) {
      finishOperation(world, operation, "cancelled", "front-disappeared");
      return { keep: true, changed: true };
    }
    const previousFrontId = operation.frontId;
    operation.frontId = replacement.id;
    front = replacement;
    operationChanged = true;
    recordEvent(
      world,
      operation,
      "front-remapped",
      `${previousFrontId}->${replacement.id}`,
    );
  }
  const plan = getFrontPlan(world, operation.frontId, operation.nationId);
  if (!plan || plan.posture !== "attack") {
    finishOperation(world, operation, "cancelled", "posture-changed");
    return { keep: true, changed: true };
  }
  const allocation = getFrontAllocation(
    world,
    operation.frontId,
    operation.nationId,
  );
  if (!allocation) {
    finishOperation(world, operation, "cancelled", "allocation-lost");
    return { keep: true, changed: true };
  }
  const enemySide = getOpposingFrontSide(front, operation.nationId);
  if (!enemySide) {
    finishOperation(world, operation, "cancelled", "front-disappeared");
    return { keep: true, changed: true };
  }
  if (!enemySide.influenceRegionIds.includes(operation.primaryTargetRegionId)) {
    finishOperation(world, operation, "cancelled", "target-invalid");
    return { keep: true, changed: true };
  }

  const unitById = new Map(world.units.map((unit) => [unit.id, unit]));
  const survivingInitialCount = operation.initialAssignedUnitIds.filter((unitId) => {
    const unit = unitById.get(unitId);
    return (
      !!unit &&
      unit.domain === "land" &&
      unit.nationId === operation.nationId
    );
  }).length;
  const settings = WORLD_BALANCE.war.landFront.offensiveOperation;
  if (
    survivingInitialCount <
    Math.ceil(
      operation.initialAssignedUnitCount * settings.minimumSurvivingForceRatio,
    )
  ) {
    finishOperation(world, operation, "cancelled", "force-depleted");
    return { keep: true, changed: true };
  }

  const assignmentChanged = refreshOperationUnitAssignment(
    world,
    operation,
    allocation,
  );
  if (operation.assignedUnitIds.length === 0) {
    finishOperation(world, operation, "cancelled", "allocation-lost");
    return { keep: true, changed: true };
  }

  if (operation.phase === "preparing") {
    const preparationTicks = now - operation.phaseStartedAtTick;
    const stagedRatio = getStagedUnitRatio(world, operation);
    if (
      (preparationTicks >= settings.minimumPreparationTicks &&
        stagedRatio >= settings.stagedFraction) ||
      preparationTicks >= settings.preparationTimeoutTicks
    ) {
      transitionToAttacking(world, operation);
      return { keep: true, changed: true };
    }
    return { keep: true, changed: operationChanged || assignmentChanged };
  }

  if (now >= operation.minimumCommitUntilTick) {
    const friendly = getFrontSide(front, operation.nationId);
    const enemy = getOpposingFrontSide(front, operation.nationId);
    const currentRatio = getStrengthRatio(
      friendly?.strength ?? 0,
      enemy?.strength ?? 0,
    );
    if (
      currentRatio < 1 &&
      currentRatio <
        operation.initialStrengthRatio * settings.failureStrengthRatioMultiplier
    ) {
      finishOperation(world, operation, "failure", "strength-collapsed");
      return { keep: true, changed: true };
    }
  }
  if (now >= operation.expiresAtTick) {
    finishOperation(world, operation, "failure", "attack-expired");
    return { keep: true, changed: true };
  }
  if (!isTargetReachableWithinFront(world, operation, front)) {
    finishOperation(world, operation, "failure", "target-unreachable");
    return { keep: true, changed: true };
  }
  return { keep: true, changed: operationChanged || assignmentChanged };
}

function findContinuationFront(
  world: WorldState,
  operation: OffensiveOperation,
): PhysicalFront | undefined {
  return world.landFronts.physicalFronts
    .filter((front) => {
      const samePair =
        (front.nationAId === operation.nationId &&
          front.nationBId === operation.enemyNationId) ||
        (front.nationBId === operation.nationId &&
          front.nationAId === operation.enemyNationId);
      if (!samePair) {
        return false;
      }
      const enemy = getOpposingFrontSide(front, operation.nationId);
      return !!enemy?.influenceRegionIds.includes(
        operation.primaryTargetRegionId,
      );
    })
    .sort((a, b) => {
      const friendlyA = getFrontSide(a, operation.nationId);
      const friendlyB = getFrontSide(b, operation.nationId);
      const stagingA = friendlyA?.influenceRegionIds.includes(
        operation.stagingRegionId,
      )
        ? 1
        : 0;
      const stagingB = friendlyB?.influenceRegionIds.includes(
        operation.stagingRegionId,
      )
        ? 1
        : 0;
      return stagingB - stagingA || compareIds(a.id, b.id);
    })[0];
}

function createOperation(
  world: WorldState,
  plan: NationFrontPlan,
): OffensiveOperation | null {
  const settings = WORLD_BALANCE.war.landFront.offensiveOperation;
  const front = world.landFronts.physicalFrontsById.get(plan.frontId);
  const allocation = getFrontAllocation(world, plan.frontId, plan.nationId);
  if (
    !front ||
    !allocation ||
    allocation.unitIds.length < settings.minimumFrontUnits
  ) {
    return null;
  }
  const friendly = getFrontSide(front, plan.nationId);
  const enemy = getOpposingFrontSide(front, plan.nationId);
  if (!friendly || !enemy) {
    return null;
  }
  const unitById = new Map(world.units.map((unit) => [unit.id, unit]));
  const allocationUnits = allocation.unitIds
    .map((unitId) => unitById.get(unitId))
    .filter(isOperationalLandUnit);
  if (allocationUnits.length < settings.minimumFrontUnits) {
    return null;
  }
  const targets = selectOperationTargets(world, front, plan, allocationUnits);
  if (!targets) {
    return null;
  }
  const assignedUnits = selectOperationUnits(
    allocationUnits,
    targets.stagingRegionId,
    world,
  );
  if (assignedUnits.length < 2) {
    return null;
  }
  const assignedStrength = sumUnitStrength(assignedUnits);
  const initialStrengthRatio = getStrengthRatio(friendly.strength, enemy.strength);
  const operation: OffensiveOperation = {
    id: createOperationId(world.offensiveOperations.nextOperationNumber),
    nationId: plan.nationId,
    enemyNationId: enemy.nationId,
    frontId: front.id,
    phase: "preparing",
    primaryTargetRegionId: targets.primaryTargetRegionId,
    supportingTargetRegionIds: targets.supportingTargetRegionIds,
    stagingRegionId: targets.stagingRegionId,
    assignedUnitIds: assignedUnits.map((unit) => unit.id).sort(compareIds),
    assignedStrength,
    initialAssignedUnitIds: assignedUnits.map((unit) => unit.id).sort(compareIds),
    initialAssignedUnitCount: assignedUnits.length,
    initialAssignedStrength: assignedStrength,
    unitTargetRegionIds: new Map(),
    startedAtTick: world.time.fastTick,
    phaseStartedAtTick: world.time.fastTick,
    minimumCommitUntilTick:
      world.time.fastTick + settings.minimumCommitTicks,
    expiresAtTick:
      world.time.fastTick +
      settings.preparationTimeoutTicks +
      settings.attackTimeoutTicks,
    initialFriendlyStrength: finiteNumber(friendly.strength),
    initialEnemyStrength: finiteNumber(enemy.strength),
    initialStrengthRatio,
    reasonFlags: collectOperationReasons(
      world,
      plan,
      front,
      targets,
      initialStrengthRatio,
    ),
    outcome: null,
    completionReason: null,
    completedAtTick: null,
  };
  world.offensiveOperations.nextOperationNumber += 1;
  return operation;
}

function selectOperationTargets(
  world: WorldState,
  front: PhysicalFront,
  plan: NationFrontPlan,
  allocationUnits: UnitState[],
): OperationTargetSelection | null {
  const friendly = getFrontSide(front, plan.nationId);
  const enemy = getOpposingFrontSide(front, plan.nationId);
  if (!friendly || !enemy) {
    return null;
  }
  const mesoById = getMesoById(world);
  const neighborsById = getNeighborsById(world);
  const frontScope = new Set([
    ...friendly.influenceRegionIds,
    ...enemy.influenceRegionIds,
  ]);
  const distanceFromFriendlyBorder = buildBoundedDistanceField(
    friendly.borderRegionIds,
    frontScope,
    neighborsById,
  );
  const enemyBorderSet = new Set(enemy.borderRegionIds);
  const candidates = enemy.influenceRegionIds
    .filter((regionId) => {
      const meso = mesoById.get(regionId);
      return (
        !!meso &&
        meso.type !== "sea" &&
        distanceFromFriendlyBorder.has(regionId) &&
        isRegionControlledBy(world, regionId, enemy.nationId)
      );
    })
    .map((regionId) => ({
      regionId,
      score: scoreOperationTarget(
        world,
        regionId,
        plan,
        allocationUnits,
        enemy.nationId,
        enemyBorderSet,
        distanceFromFriendlyBorder.get(regionId) ?? 0,
      ),
      nearbyEnemyStrength: getNearbyEnemyStrength(
        world,
        regionId,
        enemy.nationId,
      ),
    }))
    .sort((a, b) => b.score - a.score || compareIds(a.regionId, b.regionId));
  const primary = candidates[0];
  if (!primary) {
    return null;
  }
  const stagingRegionId = findNearestStagingRegion(
    primary.regionId,
    friendly.borderRegionIds,
    frontScope,
    neighborsById,
  );
  if (!stagingRegionId) {
    return null;
  }
  const settings = WORLD_BALANCE.war.landFront.offensiveOperation;
  const supportingTargetRegionIds = candidates
    .slice(1)
    .filter(
      (candidate) =>
        getBoundedGraphDistance(
          primary.regionId,
          candidate.regionId,
          settings.supportingTargetRadius,
          frontScope,
          neighborsById,
        ) !== null,
    )
    .slice(0, settings.supportingTargetCount)
    .map((candidate) => candidate.regionId);
  return {
    primaryTargetRegionId: primary.regionId,
    supportingTargetRegionIds,
    stagingRegionId,
    nearbyEnemyStrength: primary.nearbyEnemyStrength,
  };
}

function scoreOperationTarget(
  world: WorldState,
  regionId: MesoRegionId,
  plan: NationFrontPlan,
  units: UnitState[],
  enemyNationId: NationId,
  enemyBorderSet: ReadonlySet<MesoRegionId>,
  borderDistance: number,
): number {
  const settings = WORLD_BALANCE.war.landFront.offensiveOperation.targetScore;
  const meso = getMesoById(world).get(regionId);
  const buildingScore =
    meso?.building === "capital"
      ? settings.capital
      : meso?.building === "city"
        ? settings.city
        : 0;
  const borderScore = enemyBorderSet.has(regionId) ? settings.border : 0;
  const averageDistance = averageCenterDistance(units, regionId, world);
  const enemyStrength = getNearbyEnemyStrength(world, regionId, enemyNationId);
  return (
    buildingScore +
    borderScore +
    plan.priority * 0.2 -
    borderDistance * 5 -
    (averageDistance / 50) * settings.distance -
    enemyStrength * settings.enemyStrength
  );
}

function selectOperationUnits(
  units: UnitState[],
  stagingRegionId: MesoRegionId,
  world: WorldState,
): UnitState[] {
  const settings = WORLD_BALANCE.war.landFront.offensiveOperation;
  const desiredCount = clamp(
    Math.ceil(units.length * settings.forceFraction),
    2,
    Math.max(2, units.length - 1),
  );
  const stagingCenter = getMesoById(world).get(stagingRegionId)?.center;
  return [...units]
    .sort((a, b) => {
      const scoreA = scoreOperationUnit(a, stagingCenter, world);
      const scoreB = scoreOperationUnit(b, stagingCenter, world);
      return scoreA - scoreB || compareIds(a.id, b.id);
    })
    .slice(0, desiredCount);
}

function scoreOperationUnit(
  unit: UnitState,
  stagingCenter: MesoRegion["center"] | undefined,
  world: WorldState,
): number {
  const unitCenter = getMesoById(world).get(unit.regionId)?.center;
  const distance =
    stagingCenter && unitCenter
      ? Math.sqrt(distanceSq(stagingCenter, unitCenter))
      : 0;
  return distance + (1 - clamp(unit.org, 0, 1)) * 80 - Math.log1p(finiteUnitStrength(unit)) * 4;
}

function refreshOperationUnitAssignment(
  world: WorldState,
  operation: OffensiveOperation,
  allocation: NationFrontAllocation,
): boolean {
  const unitById = new Map(world.units.map((unit) => [unit.id, unit]));
  const allocationUnits = allocation.unitIds
    .map((unitId) => unitById.get(unitId))
    .filter(isOperationalLandUnit);
  const allocationIds = new Set(allocationUnits.map((unit) => unit.id));
  const retainedIds = operation.assignedUnitIds.filter((unitId) =>
    allocationIds.has(unitId),
  );
  const retainedSet = new Set(retainedIds);
  const settings = WORLD_BALANCE.war.landFront.offensiveOperation;
  const desiredCount = clamp(
    Math.ceil(allocationUnits.length * settings.forceFraction),
    Math.min(2, allocationUnits.length),
    Math.max(0, allocationUnits.length - 1),
  );
  const candidates = selectOperationUnits(
    allocationUnits.filter((unit) => !retainedSet.has(unit.id)),
    operation.stagingRegionId,
    world,
  );
  const addedIds = candidates
    .slice(0, Math.max(0, desiredCount - retainedIds.length))
    .map((unit) => unit.id);
  const nextIds = [...retainedIds, ...addedIds].sort(compareIds);
  const changed = !arraysEqual(operation.assignedUnitIds, nextIds);
  if (addedIds.length > 0) {
    world.offensiveOperations.unitAssignmentCount += addedIds.length;
    world.instrumentation?.incrementCounter(
      "offensiveOperation.unitAssignments",
      addedIds.length,
    );
  }
  operation.assignedUnitIds = nextIds;
  operation.assignedStrength = sumUnitStrength(
    nextIds
      .map((unitId) => unitById.get(unitId))
      .filter((unit): unit is UnitState => !!unit),
  );
  for (const unitId of [...operation.unitTargetRegionIds.keys()]) {
    if (!nextIds.includes(unitId)) {
      operation.unitTargetRegionIds.delete(unitId);
    }
  }
  if (operation.phase === "attacking") {
    assignStableOperationTargets(operation);
  }
  return changed;
}

function transitionToAttacking(
  world: WorldState,
  operation: OffensiveOperation,
): void {
  const now = world.time.fastTick;
  const preparingTicks = Math.max(0, now - operation.phaseStartedAtTick);
  world.offensiveOperations.preparingDurationTicks += preparingTicks;
  world.instrumentation?.incrementCounter(
    "offensiveOperation.preparingTicks",
    preparingTicks,
  );
  operation.phase = "attacking";
  operation.phaseStartedAtTick = now;
  operation.minimumCommitUntilTick =
    now + WORLD_BALANCE.war.landFront.offensiveOperation.minimumCommitTicks;
  operation.expiresAtTick =
    now + WORLD_BALANCE.war.landFront.offensiveOperation.attackTimeoutTicks;
  assignStableOperationTargets(operation);
  world.offensiveOperations.phaseTransitionCount += 1;
  world.instrumentation?.incrementCounter("offensiveOperation.phaseTransitions");
  recordEvent(world, operation, "phase-transition", "preparing->attacking");
}

function finishOperation(
  world: WorldState,
  operation: OffensiveOperation,
  outcome: OffensiveOperationOutcome,
  completionReason: OffensiveOperationCompletionReason,
): void {
  const now = world.time.fastTick;
  const duration = Math.max(0, now - operation.phaseStartedAtTick);
  if (operation.phase === "preparing") {
    world.offensiveOperations.preparingDurationTicks += duration;
    world.instrumentation?.incrementCounter(
      "offensiveOperation.preparingTicks",
      duration,
    );
  } else if (operation.phase === "attacking") {
    world.offensiveOperations.attackingDurationTicks += duration;
    world.instrumentation?.incrementCounter(
      "offensiveOperation.attackingTicks",
      duration,
    );
  }
  operation.phase = "recovering";
  operation.phaseStartedAtTick = now;
  operation.expiresAtTick =
    now + WORLD_BALANCE.war.landFront.offensiveOperation.recoveryTicks;
  operation.outcome = outcome;
  operation.completionReason = completionReason;
  operation.completedAtTick = now;
  world.offensiveOperations.phaseTransitionCount += 1;
  world.instrumentation?.incrementCounter("offensiveOperation.phaseTransitions");
  if (outcome === "success") {
    world.offensiveOperations.completedCount += 1;
    world.instrumentation?.incrementCounter("offensiveOperation.completed");
    recordEvent(world, operation, "success", completionReason);
  } else if (outcome === "failure") {
    world.offensiveOperations.failedCount += 1;
    world.instrumentation?.incrementCounter("offensiveOperation.failed");
    recordEvent(world, operation, "failure", completionReason);
  } else {
    world.offensiveOperations.cancelledCount += 1;
    world.instrumentation?.incrementCounter("offensiveOperation.cancelled");
    recordEvent(world, operation, "cancelled", completionReason);
  }
}

function assignStableOperationTargets(operation: OffensiveOperation): void {
  const targets = [
    operation.primaryTargetRegionId,
    ...operation.supportingTargetRegionIds,
  ];
  const validExisting = new Map<UnitId, MesoRegionId>();
  for (const unitId of operation.assignedUnitIds) {
    const targetId = operation.unitTargetRegionIds.get(unitId);
    if (targetId && targets.includes(targetId)) {
      validExisting.set(unitId, targetId);
    }
  }
  const desiredCounts = distributeCounts(
    operation.assignedUnitIds.length,
    targets.length,
    WORLD_BALANCE.war.landFront.offensiveOperation.targetFractions,
  );
  const counts = new Map<MesoRegionId, number>();
  for (const targetId of validExisting.values()) {
    counts.set(targetId, (counts.get(targetId) ?? 0) + 1);
  }
  for (const unitId of operation.assignedUnitIds) {
    if (validExisting.has(unitId)) {
      continue;
    }
    let bestIndex = 0;
    let bestNeed = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < targets.length; index += 1) {
      const targetId = targets[index];
      const need = desiredCounts[index] - (counts.get(targetId) ?? 0);
      if (need > bestNeed) {
        bestIndex = index;
        bestNeed = need;
      }
    }
    const targetId = targets[bestIndex];
    operation.unitTargetRegionIds.set(unitId, targetId);
    counts.set(targetId, (counts.get(targetId) ?? 0) + 1);
  }
}

function distributeCounts(
  total: number,
  targetCount: number,
  configuredFractions: readonly number[],
): number[] {
  if (targetCount <= 0) {
    return [];
  }
  if (targetCount === 1) {
    return [total];
  }
  const fractions = configuredFractions.slice(0, targetCount);
  const fractionTotal = fractions.reduce((sum, value) => sum + value, 0) || 1;
  const raw = fractions.map((fraction) => (total * fraction) / fractionTotal);
  const counts = raw.map((value) => Math.floor(value));
  let remaining = total - counts.reduce((sum, value) => sum + value, 0);
  const remainderOrder = raw
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let index = 0; index < remainderOrder.length && remaining > 0; index += 1) {
    counts[remainderOrder[index].index] += 1;
    remaining -= 1;
  }
  return counts;
}

function getStagedUnitRatio(
  world: WorldState,
  operation: OffensiveOperation,
): number {
  if (operation.assignedUnitIds.length === 0) {
    return 0;
  }
  const unitById = new Map(world.units.map((unit) => [unit.id, unit]));
  const neighborsById = getNeighborsById(world);
  const radius = WORLD_BALANCE.war.landFront.offensiveOperation.stagingRadius;
  let staged = 0;
  for (const unitId of operation.assignedUnitIds) {
    const unit = unitById.get(unitId);
    if (
      unit &&
      getBoundedGraphDistance(
        unit.regionId,
        operation.stagingRegionId,
        radius,
        undefined,
        neighborsById,
      ) !== null
    ) {
      staged += 1;
    }
  }
  return staged / operation.assignedUnitIds.length;
}

function isTargetReachableWithinFront(
  world: WorldState,
  operation: OffensiveOperation,
  front: PhysicalFront,
): boolean {
  const friendly = getFrontSide(front, operation.nationId);
  const enemy = getOpposingFrontSide(front, operation.nationId);
  if (!friendly || !enemy) {
    return false;
  }
  const scope = new Set([
    ...friendly.influenceRegionIds,
    ...enemy.influenceRegionIds,
  ]);
  return (
    getBoundedGraphDistance(
      operation.stagingRegionId,
      operation.primaryTargetRegionId,
      scope.size,
      scope,
      getNeighborsById(world),
    ) !== null
  );
}

function hasOccupiedSupportingMajority(
  world: WorldState,
  operation: OffensiveOperation,
): boolean {
  if (operation.supportingTargetRegionIds.length === 0) {
    return false;
  }
  const occupied = operation.supportingTargetRegionIds.filter((regionId) =>
    isRegionControlledBy(world, regionId, operation.nationId),
  ).length;
  return occupied > operation.supportingTargetRegionIds.length / 2;
}

function collectOperationReasons(
  world: WorldState,
  plan: NationFrontPlan,
  front: PhysicalFront,
  targets: OperationTargetSelection,
  strengthRatio: number,
): OffensiveOperationReason[] {
  const reasons: OffensiveOperationReason[] = [];
  const settings = WORLD_BALANCE.war.landFront.offensiveOperation;
  const target = targets.primaryTargetRegionId;
  const targetBuilding = getMesoById(world).get(target)?.building;
  if (strengthRatio > 1.4) {
    reasons.push("front-superiority");
  }
  if (targetBuilding === "capital") {
    reasons.push("enemy-capital-opportunity");
  } else if (targetBuilding === "city") {
    reasons.push("enemy-city-opportunity");
  }
  if (plan.priority >= settings.highPriorityThreshold) {
    reasons.push("high-front-priority");
  }
  if (targets.nearbyEnemyStrength < Math.max(1, frontSideStrength(front, plan.nationId))) {
    reasons.push("weak-enemy-presence");
  }
  return reasons.length > 0 ? reasons : ["high-front-priority"];
}

function sampleOperationMetrics(world: WorldState): void {
  const state = world.offensiveOperations;
  const active = state.operations.filter((operation) => operation.phase !== "recovering");
  world.instrumentation?.incrementCounter(
    "offensiveOperation.activeSamples",
    active.length,
  );
  world.instrumentation?.incrementCounter("offensiveOperation.activeSampleCount");
  world.instrumentation?.incrementCounter(
    "offensiveOperation.targetChanges",
    0,
  );
  for (const operation of active) {
    if (operation.phase !== "attacking") {
      continue;
    }
    const targetCounts = new Map<MesoRegionId, number>();
    for (const targetId of operation.unitTargetRegionIds.values()) {
      targetCounts.set(targetId, (targetCounts.get(targetId) ?? 0) + 1);
    }
    const concentration = Math.max(0, ...targetCounts.values());
    world.instrumentation?.incrementCounter(
      "offensiveOperation.targetConcentrationTotal",
      concentration,
    );
    world.instrumentation?.incrementCounter(
      "offensiveOperation.targetConcentrationSamples",
    );
    if (concentration > state.maxTargetConcentration) {
      const increase = concentration - state.maxTargetConcentration;
      state.maxTargetConcentration = concentration;
      world.instrumentation?.incrementCounter(
        "offensiveOperation.targetConcentrationMax",
        increase,
      );
    }
  }
}

function rebuildOperationIndexes(state: OffensiveOperationState): void {
  state.operations.sort(compareOperations);
  state.operationsById = new Map(
    state.operations.map((operation) => [operation.id, operation]),
  );
  state.operationsByNationId = new Map();
  state.operationsByFrontNation = new Map();
  state.operationIdByUnitId = new Map();
  for (const operation of state.operations) {
    const byNation = state.operationsByNationId.get(operation.nationId);
    if (byNation) {
      byNation.push(operation);
    } else {
      state.operationsByNationId.set(operation.nationId, [operation]);
    }
    state.operationsByFrontNation.set(
      createFrontNationKey(operation.frontId, operation.nationId),
      operation,
    );
    if (operation.phase === "recovering") {
      continue;
    }
    for (const unitId of operation.assignedUnitIds) {
      if (!state.operationIdByUnitId.has(unitId)) {
        state.operationIdByUnitId.set(unitId, operation.id);
      }
    }
  }
}

function archiveOperation(world: WorldState, operation: OffensiveOperation): void {
  const state = world.offensiveOperations;
  state.history.push(cloneOperation(operation));
  const limit = WORLD_BALANCE.war.landFront.offensiveOperation.historyLimit;
  if (state.history.length > limit) {
    state.history.splice(0, state.history.length - limit);
  }
}

function recordEvent(
  world: WorldState,
  operation: OffensiveOperation,
  type: OffensiveOperationEventType,
  detail: string,
): void {
  const timeline = world.offensiveOperations.timeline;
  timeline.push({
    tick: world.time.fastTick,
    operationId: operation.id,
    nationId: operation.nationId,
    frontId: operation.frontId,
    type,
    phase: operation.phase,
    detail,
  });
  const limit = WORLD_BALANCE.war.landFront.offensiveOperation.timelineLimit;
  if (timeline.length > limit) {
    timeline.splice(0, timeline.length - limit);
  }
}

function cloneOperation(operation: OffensiveOperation): OffensiveOperation {
  return {
    ...operation,
    supportingTargetRegionIds: [...operation.supportingTargetRegionIds],
    assignedUnitIds: [...operation.assignedUnitIds],
    initialAssignedUnitIds: [...operation.initialAssignedUnitIds],
    unitTargetRegionIds: new Map(operation.unitTargetRegionIds),
    reasonFlags: [...operation.reasonFlags],
  };
}

function buildBoundedDistanceField(
  sourceIds: MesoRegionId[],
  scope: ReadonlySet<MesoRegionId>,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
): Map<MesoRegionId, number> {
  const distances = new Map<MesoRegionId, number>();
  const queue: MesoRegionId[] = [];
  for (const sourceId of [...sourceIds].sort(compareIds)) {
    if (!scope.has(sourceId) || distances.has(sourceId)) {
      continue;
    }
    distances.set(sourceId, 0);
    queue.push(sourceId);
  }
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    const distance = distances.get(current) ?? 0;
    for (const neighborId of neighborsById.get(current) ?? []) {
      if (!scope.has(neighborId) || distances.has(neighborId)) {
        continue;
      }
      distances.set(neighborId, distance + 1);
      queue.push(neighborId);
    }
  }
  return distances;
}

function findNearestStagingRegion(
  targetId: MesoRegionId,
  stagingCandidates: MesoRegionId[],
  scope: ReadonlySet<MesoRegionId>,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
): MesoRegionId | null {
  const candidateSet = new Set(stagingCandidates);
  const queue: MesoRegionId[] = [targetId];
  const visited = new Set<MesoRegionId>([targetId]);
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    if (candidateSet.has(current)) {
      return current;
    }
    for (const neighborId of [...(neighborsById.get(current) ?? [])].sort(compareIds)) {
      if (!scope.has(neighborId) || visited.has(neighborId)) {
        continue;
      }
      visited.add(neighborId);
      queue.push(neighborId);
    }
  }
  return null;
}

function getBoundedGraphDistance(
  startId: MesoRegionId,
  targetId: MesoRegionId,
  maxDistance: number,
  scope: ReadonlySet<MesoRegionId> | undefined,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
): number | null {
  if (startId === targetId) {
    return 0;
  }
  const queue: Array<{ id: MesoRegionId; distance: number }> = [
    { id: startId, distance: 0 },
  ];
  const visited = new Set<MesoRegionId>([startId]);
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    if (current.distance >= maxDistance) {
      continue;
    }
    for (const neighborId of neighborsById.get(current.id) ?? []) {
      if (visited.has(neighborId) || (scope && !scope.has(neighborId))) {
        continue;
      }
      if (neighborId === targetId) {
        return current.distance + 1;
      }
      visited.add(neighborId);
      queue.push({ id: neighborId, distance: current.distance + 1 });
    }
  }
  return null;
}

function getNearbyEnemyStrength(
  world: WorldState,
  targetId: MesoRegionId,
  enemyNationId: NationId,
): number {
  const regionIds = new Set([
    targetId,
    ...(getNeighborsById(world).get(targetId) ?? []),
  ]);
  let strength = 0;
  for (const unit of world.units) {
    if (
      unit.domain === "land" &&
      unit.nationId === enemyNationId &&
      regionIds.has(unit.regionId)
    ) {
      strength += finiteUnitStrength(unit);
    }
  }
  return finiteNumber(strength);
}

function averageCenterDistance(
  units: UnitState[],
  targetId: MesoRegionId,
  world: WorldState,
): number {
  const mesoById = getMesoById(world);
  const targetCenter = mesoById.get(targetId)?.center;
  if (!targetCenter || units.length === 0) {
    return 0;
  }
  let total = 0;
  let count = 0;
  for (const unit of units) {
    const center = mesoById.get(unit.regionId)?.center;
    if (!center) {
      continue;
    }
    total += Math.sqrt(distanceSq(center, targetCenter));
    count += 1;
  }
  return count > 0 ? total / count : 0;
}

function isRegionControlledBy(
  world: WorldState,
  regionId: MesoRegionId,
  nationId: NationId,
): boolean {
  const owner = getOwnerByMesoId(world).get(regionId);
  const occupier = world.occupation.mesoById.get(regionId);
  return (occupier ?? owner) === nationId;
}

function frontSideStrength(front: PhysicalFront, nationId: NationId): number {
  return finiteNumber(getFrontSide(front, nationId)?.strength ?? 0);
}

function getStrengthRatio(friendlyStrength: number, enemyStrength: number): number {
  const friendly = finiteNumber(friendlyStrength);
  const enemy = finiteNumber(enemyStrength);
  if (enemy <= 0) {
    return friendly > 0 ? 100 : 1;
  }
  return Math.min(100, friendly / enemy);
}

function isOperationalLandUnit(unit: UnitState | undefined): unit is UnitState {
  return (
    !!unit &&
    unit.domain === "land" &&
    Number.isFinite(unit.moveTicksPerRegion) &&
    unit.moveTicksPerRegion > 0 &&
    unit.org > 0 &&
    getUnitCombatStrength(unit) > 0
  );
}

function sumUnitStrength(units: UnitState[]): number {
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

function createOperationId(index: number): OperationId {
  return `operation-${index}` as OperationId;
}

function createFrontNationKey(frontId: FrontId, nationId: NationId): string {
  return `${frontId}::${nationId}`;
}

function compareOperationCandidatePlans(
  a: NationFrontPlan,
  b: NationFrontPlan,
): number {
  return b.priority - a.priority || compareIds(a.frontId, b.frontId);
}

function compareOperations(
  a: OffensiveOperation,
  b: OffensiveOperation,
): number {
  return compareIds(a.nationId, b.nationId) || compareIds(a.id, b.id);
}

function areAssignmentMapsEqual(
  a: Map<UnitId, OperationId>,
  b: Map<UnitId, OperationId>,
): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const [unitId, operationId] of a.entries()) {
    if (b.get(unitId) !== operationId) {
      return false;
    }
  }
  return true;
}

function arraysEqual<T>(a: T[], b: T[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function distanceSq(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
