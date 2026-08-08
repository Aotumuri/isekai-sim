import { WORLD_BALANCE } from "../data/balance";
import type { MesoRegion, MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import {
  getCapitalDefenseAssessment,
  recordCapitalFallbackSelection,
} from "./capital-defense";
import {
  getFrontSide,
  getOpposingFrontSide,
  type FrontId,
  type PhysicalFront,
} from "./land-fronts";
import {
  getFrontAllocation,
  getUnassignedLandUnitIds,
} from "./nation-front-allocations";
import type { NationFrontPlan } from "./nation-front-plans";
import { isNationActive } from "./nation-active";
import { cancelOffensiveOperationForRetreat } from "./offensive-operations";
import type { UnitId, UnitState } from "./unit";
import { getUnitCombatStrength } from "./unit-strength";
import { buildWarAdjacency, isAtWar, type WarAdjacency } from "./war-state";
import type { WorldState } from "./world-state";
import { getMesoById, getNeighborsById, getOwnerByMesoId } from "./world-cache";

export type RetreatPlanId = string & { __brand: "RetreatPlanId" };

export type RetreatPhase = "withdrawing" | "regrouping" | "completed";

export type RetreatOutcome = "success" | "cancelled";

export type RetreatReason =
  | "extreme-strength-disadvantage"
  | "front-collapse"
  | "preserve-army"
  | "capital-fallback"
  | "city-fallback"
  | "operation-failed";

export type RetreatCompletionReason =
  | "regroup-complete"
  | "regroup-complete-no-front"
  | "war-ended"
  | "nation-eliminated"
  | "fallback-invalid"
  | "force-destroyed";

export type RetreatEventType =
  | "created"
  | "phase-transition"
  | "front-remapped"
  | "fallback-remapped"
  | "completed"
  | "cancelled";

export interface RetreatPlan {
  id: RetreatPlanId;
  nationId: NationId;
  enemyNationId: NationId;
  frontId: FrontId;
  phase: RetreatPhase;
  rearguardUnitIds: UnitId[];
  retreatingUnitIds: UnitId[];
  initialRearguardUnitIds: UnitId[];
  initialRetreatingUnitIds: UnitId[];
  fallbackRegionIds: MesoRegionId[];
  capitalDefenseFallback: boolean;
  capitalEmergencyRetargetKey: string | null;
  unitTargetRegionIds: Map<UnitId, MesoRegionId>;
  createdAtTick: number;
  startedAtTick: number;
  phaseStartedAtTick: number;
  reasonFlags: RetreatReason[];
  initialUnitCount: number;
  initialRearguardUnitCount: number;
  initialRetreatingUnitCount: number;
  initialFriendlyStrength: number;
  initialEnemyStrength: number;
  initialRearguardStrength: number;
  initialRetreatingStrength: number;
  currentRetreatingStrength: number;
  arrivedUnitCount: number;
  arrivedStrength: number;
  outcome: RetreatOutcome | null;
  completionReason: RetreatCompletionReason | null;
  completedAtTick: number | null;
}

export interface RetreatPlanEvent {
  tick: number;
  retreatPlanId: RetreatPlanId;
  nationId: NationId;
  frontId: FrontId;
  type: RetreatEventType;
  phase: RetreatPhase;
  detail: string;
}

export interface RetreatPlanState {
  plans: RetreatPlan[];
  plansById: Map<RetreatPlanId, RetreatPlan>;
  plansByNationId: Map<NationId, RetreatPlan[]>;
  plansByFrontNation: Map<string, RetreatPlan>;
  retreatIdByUnitId: Map<UnitId, RetreatPlanId>;
  history: RetreatPlan[];
  timeline: RetreatPlanEvent[];
  retreatPostureSinceByFrontNation: Map<string, number>;
  lastResolvedAtByFrontNation: Map<string, number>;
  version: number;
  membershipVersion: number;
  nextRetreatNumber: number;
  createdCount: number;
  completedCount: number;
  cancelledCount: number;
  successfulCount: number;
  arrivedUnitCount: number;
  initialRetreatingUnitCount: number;
  initialRetreatingStrength: number;
  survivingRetreatingStrength: number;
  rearguardUnitCount: number;
  rearguardStrength: number;
  targetAssignmentCount: number;
  unitTargetSwitchCount: number;
  regroupedToDefensiveFrontCount: number;
  returnedToHoldOrReinforceCount: number;
  awaitingDefensivePosture: Array<{
    retreatPlanId: RetreatPlanId;
    nationId: NationId;
    enemyNationId: NationId;
  }>;
}

interface AdvanceResult {
  keep: boolean;
  changed: boolean;
}

interface FallbackCandidate {
  id: MesoRegionId;
  score: number;
  depth: number;
}

export function createRetreatPlanState(): RetreatPlanState {
  return {
    plans: [],
    plansById: new Map(),
    plansByNationId: new Map(),
    plansByFrontNation: new Map(),
    retreatIdByUnitId: new Map(),
    history: [],
    timeline: [],
    retreatPostureSinceByFrontNation: new Map(),
    lastResolvedAtByFrontNation: new Map(),
    version: 0,
    membershipVersion: 0,
    nextRetreatNumber: 0,
    createdCount: 0,
    completedCount: 0,
    cancelledCount: 0,
    successfulCount: 0,
    arrivedUnitCount: 0,
    initialRetreatingUnitCount: 0,
    initialRetreatingStrength: 0,
    survivingRetreatingStrength: 0,
    rearguardUnitCount: 0,
    rearguardStrength: 0,
    targetAssignmentCount: 0,
    unitTargetSwitchCount: 0,
    regroupedToDefensiveFrontCount: 0,
    returnedToHoldOrReinforceCount: 0,
    awaitingDefensivePosture: [],
  };
}

export function updateRetreatPlans(world: WorldState): void {
  const state = world.retreatPlans;
  const startedAt = world.instrumentation ? performance.now() : 0;
  const previousMembership = state.retreatIdByUnitId;
  let changed = false;
  const retained: RetreatPlan[] = [];

  for (const retreat of state.plans) {
    const result = advanceRetreatPlan(world, retreat);
    changed = changed || result.changed;
    if (result.keep) {
      retained.push(retreat);
    } else {
      archiveRetreatPlan(world, retreat);
    }
  }
  state.plans = retained;
  rebuildRetreatIndexes(state);
  updateRetreatPosturePersistence(world);

  const candidates = world.frontPlans.plans
    .filter((plan) => plan.posture === "retreat")
    .sort(compareRetreatCandidates);
  for (const plan of candidates) {
    const key = createFrontNationKey(plan.frontId, plan.nationId);
    if (state.plansByFrontNation.has(key) || !isRetreatStartReady(world, plan)) {
      continue;
    }
    const retreat = createRetreatPlan(world, plan);
    if (!retreat) {
      continue;
    }
    state.plans.push(retreat);
    state.createdCount += 1;
    state.initialRetreatingUnitCount += retreat.retreatingUnitIds.length;
    state.initialRetreatingStrength += retreat.initialRetreatingStrength;
    state.rearguardUnitCount += retreat.rearguardUnitIds.length;
    state.rearguardStrength += retreat.initialRearguardStrength;
    world.instrumentation?.incrementCounter("retreat.created");
    world.instrumentation?.incrementCounter(
      "retreat.rearguardUnits",
      retreat.rearguardUnitIds.length,
    );
    world.instrumentation?.incrementCounter(
      "retreat.withdrawingUnits",
      retreat.retreatingUnitIds.length,
    );
    recordEvent(world, retreat, "created", retreat.reasonFlags.join(","));
    changed = true;
    rebuildRetreatIndexes(state);
  }

  rebuildRetreatIndexes(state);
  const membershipChanged = !areAssignmentMapsEqual(
    previousMembership,
    state.retreatIdByUnitId,
  );
  if (membershipChanged) {
    state.membershipVersion += 1;
  }
  if (changed || membershipChanged) {
    state.version += 1;
  }
  sampleDefensivePostureReturns(world);
  if (world.instrumentation) {
    world.instrumentation.recordDuration(
      "retreat.evaluation",
      performance.now() - startedAt,
    );
  }
}

export function getRetreatPlans(
  world: WorldState,
  nationId?: NationId,
): readonly RetreatPlan[] {
  return nationId === undefined
    ? world.retreatPlans.plans
    : (world.retreatPlans.plansByNationId.get(nationId) ?? []);
}

export function getRetreatPlanForFront(
  world: WorldState,
  frontId: FrontId,
  nationId: NationId,
): RetreatPlan | undefined {
  return world.retreatPlans.plansByFrontNation.get(
    createFrontNationKey(frontId, nationId),
  );
}

export function getRetreatPlanForUnit(
  world: WorldState,
  unitId: UnitId,
): RetreatPlan | undefined {
  const retreatId = world.retreatPlans.retreatIdByUnitId.get(unitId);
  return retreatId ? world.retreatPlans.plansById.get(retreatId) : undefined;
}

export function formatRetreatPlanSummary(world: WorldState): string {
  return world.retreatPlans.plans
    .map(
      (retreat) =>
        [
          `${retreat.id} ${retreat.nationId} vs ${retreat.enemyNationId}`,
          `  Front: ${retreat.frontId}`,
          `  phase: ${retreat.phase}`,
          `  rearguard: ${retreat.rearguardUnitIds.length}/${retreat.initialRearguardUnitCount} (${retreat.initialRearguardStrength.toFixed(1)})`,
          `  withdrawing: ${retreat.retreatingUnitIds.length}/${retreat.initialRetreatingUnitCount} (${retreat.currentRetreatingStrength.toFixed(1)})`,
          `  fallback: ${retreat.fallbackRegionIds.join(", ")}`,
          `  arrived: ${retreat.arrivedUnitCount}/${retreat.retreatingUnitIds.length}`,
          `  reasons: ${retreat.reasonFlags.join(", ")}`,
        ].join("\n"),
    )
    .join("\n");
}

function advanceRetreatPlan(
  world: WorldState,
  retreat: RetreatPlan,
): AdvanceResult {
  const now = world.time.fastTick;
  const nation = world.nations.find((candidate) => candidate.id === retreat.nationId);
  if (!nation || !isNationActive(nation)) {
    retreat.currentRetreatingStrength = currentRetreatingStrength(world, retreat);
    cancelRetreat(world, retreat, "nation-eliminated");
    return { keep: false, changed: true };
  }
  const warAdjacency = buildWarAdjacency(world.wars);
  if (!isAtWar(retreat.nationId, retreat.enemyNationId, warAdjacency)) {
    retreat.currentRetreatingStrength = currentRetreatingStrength(world, retreat);
    cancelRetreat(world, retreat, "war-ended");
    return { keep: false, changed: true };
  }

  const unitById = new Map(world.units.map((unit) => [unit.id, unit]));
  const previousRearguard = retreat.rearguardUnitIds;
  const previousRetreating = retreat.retreatingUnitIds;
  retreat.rearguardUnitIds = previousRearguard.filter((unitId) =>
    isRetreatLandUnit(unitById.get(unitId), retreat.nationId),
  );
  retreat.retreatingUnitIds = previousRetreating.filter((unitId) =>
    isRetreatLandUnit(unitById.get(unitId), retreat.nationId),
  );
  if (retreat.retreatingUnitIds.length === 0) {
    retreat.currentRetreatingStrength = 0;
    cancelRetreat(world, retreat, "force-destroyed");
    return { keep: false, changed: true };
  }

  let changed =
    previousRearguard.length !== retreat.rearguardUnitIds.length ||
    previousRetreating.length !== retreat.retreatingUnitIds.length;
  const remappedFront = remapRetreatFront(world, retreat);
  changed = changed || remappedFront;

  const capitalAssessment = getCapitalDefenseAssessment(world, retreat.nationId);
  const capitalEmergencyRetargetKey =
    capitalAssessment && capitalAssessment.threatLevel !== "none"
      ? `${capitalAssessment.emergencyStartedAtTick ?? now}:${capitalAssessment.threatLevel}`
      : null;
  if (
    capitalEmergencyRetargetKey &&
    capitalEmergencyRetargetKey !== retreat.capitalEmergencyRetargetKey
  ) {
    const retreatingUnits = retreat.retreatingUnitIds
      .map((unitId) => unitById.get(unitId))
      .filter((unit): unit is UnitState => !!unit);
    const replacements = selectFallbackRegions(
      world,
      retreat.nationId,
      retreat.enemyNationId,
      retreat.frontId,
      retreatingUnits,
    );
    retreat.capitalEmergencyRetargetKey = capitalEmergencyRetargetKey;
    if (
      replacements.length > 0 &&
      isCapitalDefenseFallback(world, retreat.nationId, replacements)
    ) {
      const previousFallback = retreat.fallbackRegionIds.join(",");
      retreat.fallbackRegionIds = replacements;
      retreat.capitalDefenseFallback = true;
      retreat.unitTargetRegionIds = assignFallbackTargets(
        world,
        retreat.nationId,
        retreatingUnits,
        replacements,
      );
      if (!retreat.reasonFlags.includes("capital-fallback")) {
        retreat.reasonFlags.push("capital-fallback");
      }
      recordEvent(
        world,
        retreat,
        "fallback-remapped",
        `${previousFallback}->${replacements.join(",")}:capital-emergency`,
      );
      changed = true;
    }
  }

  const validFallback = retreat.fallbackRegionIds.filter((regionId) =>
    isValidFallbackRegion(world, regionId, retreat.nationId, warAdjacency),
  );
  if (validFallback.length !== retreat.fallbackRegionIds.length) {
    const retreatingUnits = retreat.retreatingUnitIds
      .map((unitId) => unitById.get(unitId))
      .filter((unit): unit is UnitState => !!unit);
    const replacements = selectFallbackRegions(
      world,
      retreat.nationId,
      retreat.enemyNationId,
      retreat.frontId,
      retreatingUnits,
    );
    if (replacements.length === 0) {
      cancelRetreat(world, retreat, "fallback-invalid");
      return { keep: false, changed: true };
    }
    const previousFallback = retreat.fallbackRegionIds.join(",");
    retreat.fallbackRegionIds = replacements;
    retreat.unitTargetRegionIds = assignFallbackTargets(
      world,
      retreat.nationId,
      retreatingUnits,
      replacements,
    );
    recordEvent(
      world,
      retreat,
      "fallback-remapped",
      `${previousFallback}->${replacements.join(",")}`,
    );
    changed = true;
  }

  const arrived = retreat.retreatingUnitIds
    .map((unitId) => unitById.get(unitId))
    .filter(
      (unit): unit is UnitState =>
        !!unit && retreat.fallbackRegionIds.includes(unit.regionId),
    );
  retreat.arrivedUnitCount = arrived.length;
  retreat.arrivedStrength = sumUnitStrength(arrived);
  retreat.currentRetreatingStrength = sumUnitStrength(
    retreat.retreatingUnitIds
      .map((unitId) => unitById.get(unitId))
      .filter((unit): unit is UnitState => !!unit),
  );

  if (retreat.phase === "withdrawing") {
    const arrivalRatio =
      retreat.retreatingUnitIds.length > 0
        ? retreat.arrivedUnitCount / retreat.retreatingUnitIds.length
        : 0;
    if (arrivalRatio >= WORLD_BALANCE.war.landFront.retreat.arrivalRatio) {
      retreat.phase = "regrouping";
      retreat.phaseStartedAtTick = now;
      recordEvent(world, retreat, "phase-transition", "withdrawing->regrouping");
      world.instrumentation?.incrementCounter("retreat.phaseTransitions");
      return { keep: true, changed: true };
    }
    return { keep: true, changed };
  }

  const regroupDuration = now - retreat.phaseStartedAtTick;
  const settings = WORLD_BALANCE.war.landFront.retreat;
  const reconnected = hasDefensiveFrontNearFallback(world, retreat);
  if (
    regroupDuration >= settings.regroupTicks &&
    (reconnected || regroupDuration >= settings.maximumRegroupTicks)
  ) {
    completeRetreat(
      world,
      retreat,
      reconnected ? "regroup-complete" : "regroup-complete-no-front",
    );
    return { keep: false, changed: true };
  }
  return { keep: true, changed };
}

function currentRetreatingStrength(
  world: WorldState,
  retreat: RetreatPlan,
): number {
  const retreatingIds = new Set(retreat.retreatingUnitIds);
  return sumUnitStrength(
    world.units.filter(
      (unit) =>
        unit.domain === "land" &&
        unit.nationId === retreat.nationId &&
        retreatingIds.has(unit.id),
    ),
  );
}

function createRetreatPlan(
  world: WorldState,
  plan: NationFrontPlan,
): RetreatPlan | null {
  const front = world.landFronts.physicalFrontsById.get(plan.frontId);
  const allocation = getFrontAllocation(world, plan.frontId, plan.nationId);
  if (!front || !allocation) {
    return null;
  }
  const enemySide = getOpposingFrontSide(front, plan.nationId);
  const friendlySide = getFrontSide(front, plan.nationId);
  if (!enemySide || !friendlySide) {
    return null;
  }
  const alreadyCommitted = world.retreatPlans.retreatIdByUnitId;
  const relatedUnitIds = new Set<UnitId>([
    ...allocation.unitIds,
    ...collectRelatedUnassignedUnitIds(
      world,
      plan.nationId,
      friendlySide.influenceRegionIds,
    ),
  ]);
  const allocatedUnits = [...relatedUnitIds]
    .map((unitId) => world.units.find((unit) => unit.id === unitId))
    .filter(
      (unit): unit is UnitState =>
        isRetreatLandUnit(unit, plan.nationId) &&
        !alreadyCommitted.has(unit.id) &&
        !world.strategicReserves.reserveNationByUnitId.has(unit.id),
    );
  if (allocatedUnits.length < WORLD_BALANCE.war.landFront.retreat.minimumUnits) {
    return null;
  }

  const engagedUnitIds = collectEngagedUnitIds(world, plan.nationId);
  const capitalAssessment = getCapitalDefenseAssessment(world, plan.nationId);
  const isCapitalDefenseRetreat =
    !!capitalAssessment &&
    capitalAssessment.threatLevel !== "none" &&
    (capitalAssessment.threatLevel === "critical" ||
      capitalAssessment.threatenedFrontIds.includes(plan.frontId));
  const { rearguardUnits, retreatingUnits } = splitRetreatForce(
    allocatedUnits,
    engagedUnitIds,
    plan.desiredStrength,
    friendlySide.influenceRegionIds,
    isCapitalDefenseRetreat,
  );
  if (rearguardUnits.length === 0 || retreatingUnits.length === 0) {
    return null;
  }
  const fallbackRegionIds = selectFallbackRegions(
    world,
    plan.nationId,
    enemySide.nationId,
    plan.frontId,
    retreatingUnits,
  );
  if (fallbackRegionIds.length === 0) {
    return null;
  }
  const capitalDefenseFallback = isCapitalDefenseFallback(
    world,
    plan.nationId,
    fallbackRegionIds,
  );

  const operationCancelled = cancelOffensiveOperationForRetreat(
    world,
    plan.frontId,
    plan.nationId,
  );
  const now = world.time.fastTick;
  const friendlyStrength = finiteNumber(friendlySide.strength);
  const enemyStrength = finiteNumber(enemySide.strength);
  const reasons: RetreatReason[] = ["preserve-army"];
  const ratio = strengthRatio(friendlyStrength, enemyStrength);
  if (ratio <= WORLD_BALANCE.war.landFront.retreat.extremeDisadvantageRatio) {
    reasons.unshift("extreme-strength-disadvantage");
  }
  if (friendlyStrength <= 0 || enemyStrength >= friendlyStrength * 3) {
    reasons.push("front-collapse");
  }
  const mesoById = getMesoById(world);
  if (fallbackRegionIds.some((id) => mesoById.get(id)?.building === "capital")) {
    reasons.push("capital-fallback");
  } else if (fallbackRegionIds.some((id) => mesoById.get(id)?.building === "city")) {
    reasons.push("city-fallback");
  }
  if (operationCancelled) {
    reasons.push("operation-failed");
  }

  return {
    id: createRetreatPlanId(world.retreatPlans.nextRetreatNumber++),
    nationId: plan.nationId,
    enemyNationId: enemySide.nationId,
    frontId: plan.frontId,
    phase: "withdrawing",
    rearguardUnitIds: rearguardUnits.map((unit) => unit.id).sort(compareIds),
    retreatingUnitIds: retreatingUnits.map((unit) => unit.id).sort(compareIds),
    initialRearguardUnitIds: rearguardUnits.map((unit) => unit.id).sort(compareIds),
    initialRetreatingUnitIds: retreatingUnits.map((unit) => unit.id).sort(compareIds),
    fallbackRegionIds,
    capitalDefenseFallback,
    capitalEmergencyRetargetKey:
      capitalAssessment && capitalAssessment.threatLevel !== "none"
        ? `${capitalAssessment.emergencyStartedAtTick ?? now}:${capitalAssessment.threatLevel}`
        : null,
    unitTargetRegionIds: assignFallbackTargets(
      world,
      plan.nationId,
      retreatingUnits,
      fallbackRegionIds,
    ),
    createdAtTick: now,
    startedAtTick: now,
    phaseStartedAtTick: now,
    reasonFlags: reasons,
    initialUnitCount: allocatedUnits.length,
    initialRearguardUnitCount: rearguardUnits.length,
    initialRetreatingUnitCount: retreatingUnits.length,
    initialFriendlyStrength: friendlyStrength,
    initialEnemyStrength: enemyStrength,
    initialRearguardStrength: sumUnitStrength(rearguardUnits),
    initialRetreatingStrength: sumUnitStrength(retreatingUnits),
    currentRetreatingStrength: sumUnitStrength(retreatingUnits),
    arrivedUnitCount: 0,
    arrivedStrength: 0,
    outcome: null,
    completionReason: null,
    completedAtTick: null,
  };
}

function collectRelatedUnassignedUnitIds(
  world: WorldState,
  nationId: NationId,
  frontRegionIds: MesoRegionId[],
): UnitId[] {
  const distances = buildControlledDistances(
    frontRegionIds,
    nationId,
    getMesoById(world),
    getNeighborsById(world),
    getOwnerByMesoId(world),
    world.occupation.mesoById,
  );
  const unitById = new Map(world.units.map((unit) => [unit.id, unit]));
  return getUnassignedLandUnitIds(world, nationId).filter((unitId) => {
    const unit = unitById.get(unitId);
    const distance = unit ? distances.get(unit.regionId) : undefined;
    return (
      isRetreatLandUnit(unit, nationId) && distance !== undefined && distance <= 4
    );
  });
}

function updateRetreatPosturePersistence(world: WorldState): void {
  const state = world.retreatPlans;
  const activeKeys = new Set<string>();
  for (const plan of world.frontPlans.plans) {
    const key = createFrontNationKey(plan.frontId, plan.nationId);
    if (plan.posture !== "retreat") {
      state.retreatPostureSinceByFrontNation.delete(key);
      continue;
    }
    activeKeys.add(key);
    if (!state.retreatPostureSinceByFrontNation.has(key)) {
      state.retreatPostureSinceByFrontNation.set(key, world.time.fastTick);
    }
  }
  for (const key of state.retreatPostureSinceByFrontNation.keys()) {
    if (!activeKeys.has(key)) {
      state.retreatPostureSinceByFrontNation.delete(key);
    }
  }
}

function isRetreatStartReady(world: WorldState, plan: NationFrontPlan): boolean {
  const front = world.landFronts.physicalFrontsById.get(plan.frontId);
  const friendly = front ? getFrontSide(front, plan.nationId) : undefined;
  const enemy = front ? getOpposingFrontSide(front, plan.nationId) : undefined;
  if (!front || !friendly || !enemy) {
    return false;
  }
  const nation = world.nations.find((candidate) => candidate.id === plan.nationId);
  const warAdjacency = buildWarAdjacency(world.wars);
  if (
    !nation ||
    !isNationActive(nation) ||
    !isAtWar(plan.nationId, enemy.nationId, warAdjacency)
  ) {
    return false;
  }
  const key = createFrontNationKey(plan.frontId, plan.nationId);
  const lastResolved = world.retreatPlans.lastResolvedAtByFrontNation.get(key);
  if (
    lastResolved !== undefined &&
    world.time.fastTick - lastResolved <
      WORLD_BALANCE.war.landFront.retreat.restartCooldownTicks
  ) {
    return false;
  }
  if (
    strengthRatio(friendly.strength, enemy.strength) <=
    WORLD_BALANCE.war.landFront.retreat.extremeDisadvantageRatio
  ) {
    return true;
  }
  const since = world.retreatPlans.retreatPostureSinceByFrontNation.get(
    key,
  );
  return (
    since !== undefined &&
    world.time.fastTick - since >= WORLD_BALANCE.war.landFront.retreat.persistenceTicks
  );
}

function splitRetreatForce(
  units: UnitState[],
  engagedUnitIds: Set<UnitId>,
  desiredStrength: number,
  frontRegionIds: MesoRegionId[],
  capitalDefense: boolean,
): { rearguardUnits: UnitState[]; retreatingUnits: UnitState[] } {
  const settings = WORLD_BALANCE.war.landFront.retreat;
  const capitalSettings = WORLD_BALANCE.war.landFront.capitalDefense;
  const totalStrength = sumUnitStrength(units);
  const targetFraction = capitalDefense
    ? capitalSettings.criticalRearguardStrengthFraction
    : settings.rearguardStrengthFraction;
  const minimumFraction = capitalDefense
    ? capitalSettings.criticalMinimumRearguardStrengthFraction
    : settings.minimumRearguardStrengthFraction;
  const maximumFraction = capitalDefense
    ? capitalSettings.criticalMaximumRearguardStrengthFraction
    : settings.maximumRearguardStrengthFraction;
  const targetStrength = clamp(
    capitalDefense
      ? Math.max(desiredStrength, totalStrength * targetFraction)
      : desiredStrength > 0
        ? desiredStrength
        : totalStrength * targetFraction,
    totalStrength * minimumFraction,
    totalStrength * maximumFraction,
  );
  const frontRegions = new Set(frontRegionIds);
  const ordered = [...units].sort((a, b) => {
    const engaged = Number(engagedUnitIds.has(b.id)) - Number(engagedUnitIds.has(a.id));
    if (engaged !== 0) return engaged;
    const onFront = Number(frontRegions.has(b.regionId)) - Number(frontRegions.has(a.regionId));
    if (onFront !== 0) return onFront;
    return (
      finiteUnitStrength(b) - finiteUnitStrength(a) ||
      b.org - a.org ||
      equipmentFulfillment(b) - equipmentFulfillment(a) ||
      compareIds(a.id, b.id)
    );
  });
  const rearguardUnits: UnitState[] = [];
  let rearguardStrength = 0;
  for (const unit of ordered) {
    const mustRemain = engagedUnitIds.has(unit.id);
    const unitStrength = finiteUnitStrength(unit);
    if (
      !mustRemain &&
      rearguardUnits.length > 0 &&
      rearguardStrength >= targetStrength
    ) {
      continue;
    }
    if (!mustRemain && rearguardUnits.length >= units.length - 1) {
      continue;
    }
    if (
      !mustRemain &&
      rearguardUnits.length > 0 &&
      rearguardStrength >=
        totalStrength * minimumFraction &&
      rearguardStrength + unitStrength > targetStrength &&
      targetStrength - rearguardStrength <=
        rearguardStrength + unitStrength - targetStrength
    ) {
      continue;
    }
    rearguardUnits.push(unit);
    rearguardStrength += unitStrength;
  }
  const rearguardIds = new Set(rearguardUnits.map((unit) => unit.id));
  const retreatingUnits = units
    .filter((unit) => !rearguardIds.has(unit.id))
    .sort(compareRetreatingUnits);
  return { rearguardUnits, retreatingUnits };
}

function selectFallbackRegions(
  world: WorldState,
  nationId: NationId,
  enemyNationId: NationId,
  frontId: FrontId,
  retreatingUnits: UnitState[],
): MesoRegionId[] {
  const mesoById = getMesoById(world);
  const neighborsById = getNeighborsById(world);
  const ownerByMesoId = getOwnerByMesoId(world);
  const warAdjacency = buildWarAdjacency(world.wars);
  const enemyUnitsByRegion = indexEnemyUnitsByRegion(world, nationId, warAdjacency);
  const reachable = collectReachableControlledRegions(
    retreatingUnits.map((unit) => unit.regionId),
    nationId,
    mesoById,
    neighborsById,
    ownerByMesoId,
    world.occupation.mesoById,
  );
  if (reachable.size === 0) {
    return [];
  }
  const frontSources = collectFallbackFrontSources(
    world,
    frontId,
    nationId,
    enemyNationId,
  );
  const depthByRegion = buildControlledDistances(
    frontSources,
    nationId,
    mesoById,
    neighborsById,
    ownerByMesoId,
    world.occupation.mesoById,
  );
  const nation = world.nations.find((candidate) => candidate.id === nationId);
  const candidates: FallbackCandidate[] = [];
  for (const regionId of reachable) {
    const meso = mesoById.get(regionId);
    if (!meso || meso.type === "sea" || enemyUnitsByRegion.has(regionId)) {
      continue;
    }
    const depth = depthByRegion.get(regionId) ?? 0;
    let enemyDirections = 0;
    let adjacentEnemyStrength = 0;
    let controlledNeighborCount = 0;
    for (const neighborId of neighborsById.get(regionId) ?? []) {
      if (
        isEffectivelyControlledBy(
          neighborId,
          nationId,
          ownerByMesoId,
          world.occupation.mesoById,
        )
      ) {
        controlledNeighborCount += 1;
      } else {
        const controller = effectiveController(
          neighborId,
          ownerByMesoId,
          world.occupation.mesoById,
        );
        if (controller && isAtWar(nationId, controller, warAdjacency)) {
          enemyDirections += 1;
        }
      }
      adjacentEnemyStrength += enemyUnitsByRegion.get(neighborId) ?? 0;
    }
    const isCapital = regionId === nation?.capitalMesoId || meso.building === "capital";
    const isCity = meso.building === "city";
    let score = depth * 12 + controlledNeighborCount * 3;
    if (isCapital) score += 180;
    else if (isCity) score += 100;
    score -= enemyDirections * 90;
    score -= adjacentEnemyStrength * 0.002;
    candidates.push({ id: regionId, score, depth });
  }
  if (candidates.length === 0) {
    return [];
  }
  const minimumDepth = WORLD_BALANCE.war.landFront.retreat.minimumFallbackDepth;
  const deepCandidates = candidates.filter((candidate) => {
    const building = mesoById.get(candidate.id)?.building;
    return (
      candidate.depth >= minimumDepth ||
      building === "capital" ||
      building === "city"
    );
  });
  const ranked = (deepCandidates.length > 0 ? deepCandidates : candidates).sort(
    (a, b) => b.score - a.score || b.depth - a.depth || compareIds(a.id, b.id),
  );
  const capitalAssessment = getCapitalDefenseAssessment(world, nationId);
  const useCapitalDefense =
    !!capitalAssessment &&
    capitalAssessment.threatLevel !== "none" &&
    (capitalAssessment.threatLevel === "critical" ||
      capitalAssessment.threatenedFrontIds.includes(frontId));
  const capitalDefenseIds = new Set(capitalAssessment?.defenseRegionIds ?? []);
  const capitalRanked = useCapitalDefense
    ? ranked
        .filter((candidate) => capitalDefenseIds.has(candidate.id))
        .sort((a, b) => {
          const aIsCapital = Number(a.id === capitalAssessment?.capitalRegionId);
          const bIsCapital = Number(b.id === capitalAssessment?.capitalRegionId);
          return bIsCapital - aIsCapital || b.score - a.score || compareIds(a.id, b.id);
        })
    : [];
  const selectedRanking = capitalRanked.length > 0 ? capitalRanked : ranked;
  if (capitalRanked.length > 0) {
    recordCapitalFallbackSelection(world);
  }
  const anchor = selectedRanking[0];
  if (!anchor) {
    return [];
  }
  const clusterLimit = Math.min(
    WORLD_BALANCE.war.landFront.retreat.fallbackClusterSize,
    Math.max(1, Math.ceil(retreatingUnits.length / 4)),
  );
  const clustered = selectedRanking.filter(
    (candidate) =>
      candidate.id === anchor.id ||
      graphDistanceWithin(anchor.id, candidate.id, neighborsById, 2),
  );
  return clustered
    .slice(0, clusterLimit)
    .map((candidate) => candidate.id)
    .sort(compareIds);
}

function isCapitalDefenseFallback(
  world: WorldState,
  nationId: NationId,
  fallbackRegionIds: MesoRegionId[],
): boolean {
  const assessment = getCapitalDefenseAssessment(world, nationId);
  if (!assessment || assessment.threatLevel === "none") return false;
  const defenseRegionIds = new Set(assessment.defenseRegionIds);
  return fallbackRegionIds.some((regionId) => defenseRegionIds.has(regionId));
}

function assignFallbackTargets(
  world: WorldState,
  nationId: NationId,
  units: UnitState[],
  fallbackRegionIds: MesoRegionId[],
): Map<UnitId, MesoRegionId> {
  const startedAt = world.instrumentation ? performance.now() : 0;
  const neighborsById = getNeighborsById(world);
  const mesoById = getMesoById(world);
  const ownerByMesoId = getOwnerByMesoId(world);
  const distancesByFallback = new Map<MesoRegionId, Map<MesoRegionId, number>>();
  for (const fallbackId of fallbackRegionIds) {
    distancesByFallback.set(
      fallbackId,
      buildControlledDistances(
        [fallbackId],
        nationId,
        mesoById,
        neighborsById,
        ownerByMesoId,
        world.occupation.mesoById,
      ),
    );
  }
  const targets = new Map<UnitId, MesoRegionId>();
  for (const unit of [...units].sort(compareRetreatingUnits)) {
    const target = fallbackRegionIds.reduce<MesoRegionId | null>((best, candidate) => {
      if (!best) return candidate;
      const candidateDistance =
        distancesByFallback.get(candidate)?.get(unit.regionId) ??
        Number.POSITIVE_INFINITY;
      const bestDistance =
        distancesByFallback.get(best)?.get(unit.regionId) ?? Number.POSITIVE_INFINITY;
      return candidateDistance < bestDistance ||
        (candidateDistance === bestDistance && compareIds(candidate, best) < 0)
        ? candidate
        : best;
    }, null);
    if (target) {
      targets.set(unit.id, target);
    }
  }
  world.retreatPlans.targetAssignmentCount += targets.size;
  world.instrumentation?.incrementCounter("retreat.targetAssignments", targets.size);
  if (world.instrumentation) {
    world.instrumentation.recordDuration(
      "retreat.targetAssignment",
      performance.now() - startedAt,
    );
  }
  return targets;
}

function remapRetreatFront(world: WorldState, retreat: RetreatPlan): boolean {
  if (world.landFronts.physicalFrontsById.has(retreat.frontId)) {
    return false;
  }
  const candidates = world.landFronts.physicalFronts.filter((front) =>
    isSameNationPair(front, retreat.nationId, retreat.enemyNationId),
  );
  if (candidates.length === 0) {
    return false;
  }
  const neighborsById = getNeighborsById(world);
  candidates.sort((a, b) => {
    const distanceA = frontFallbackDistance(a, retreat, neighborsById);
    const distanceB = frontFallbackDistance(b, retreat, neighborsById);
    return distanceA - distanceB || compareIds(a.id, b.id);
  });
  const replacement = candidates[0];
  if (!replacement) {
    return false;
  }
  const previous = retreat.frontId;
  retreat.frontId = replacement.id;
  recordEvent(world, retreat, "front-remapped", `${previous}->${replacement.id}`);
  return true;
}

function hasDefensiveFrontNearFallback(
  world: WorldState,
  retreat: RetreatPlan,
): boolean {
  const neighborsById = getNeighborsById(world);
  return world.landFronts.physicalFronts.some((front) => {
    if (!isSameNationPair(front, retreat.nationId, retreat.enemyNationId)) {
      return false;
    }
    const side = getFrontSide(front, retreat.nationId);
    if (!side) {
      return false;
    }
    return retreat.fallbackRegionIds.some((fallbackId) =>
      side.influenceRegionIds.some(
        (frontRegionId) =>
          frontRegionId === fallbackId ||
          graphDistanceWithin(fallbackId, frontRegionId, neighborsById, 3),
      ),
    );
  });
}

function completeRetreat(
  world: WorldState,
  retreat: RetreatPlan,
  reason: RetreatCompletionReason,
): void {
  retreat.phase = "completed";
  retreat.outcome = "success";
  retreat.completionReason = reason;
  retreat.completedAtTick = world.time.fastTick;
  const state = world.retreatPlans;
  state.completedCount += 1;
  state.successfulCount += 1;
  state.arrivedUnitCount += retreat.arrivedUnitCount;
  state.survivingRetreatingStrength += retreat.currentRetreatingStrength;
  state.lastResolvedAtByFrontNation.set(
    createFrontNationKey(retreat.frontId, retreat.nationId),
    world.time.fastTick,
  );
  if (reason === "regroup-complete") {
    state.regroupedToDefensiveFrontCount += 1;
    state.awaitingDefensivePosture.push({
      retreatPlanId: retreat.id,
      nationId: retreat.nationId,
      enemyNationId: retreat.enemyNationId,
    });
  }
  world.instrumentation?.incrementCounter("retreat.completed");
  world.instrumentation?.incrementCounter(
    "retreat.arrivedUnits",
    retreat.arrivedUnitCount,
  );
  world.instrumentation?.incrementCounter(
    "retreat.regroupedToFront",
    reason === "regroup-complete" ? 1 : 0,
  );
  recordEvent(world, retreat, "completed", reason);
}

function sampleDefensivePostureReturns(world: WorldState): void {
  const state = world.retreatPlans;
  const retained: typeof state.awaitingDefensivePosture = [];
  const activeNationIds = new Set(
    world.nations.filter(isNationActive).map((nation) => nation.id),
  );
  const warAdjacency = buildWarAdjacency(world.wars);
  for (const pending of state.awaitingDefensivePosture) {
    if (
      !activeNationIds.has(pending.nationId) ||
      !isAtWar(pending.nationId, pending.enemyNationId, warAdjacency)
    ) {
      continue;
    }
    const returned = world.frontPlans.plans.some((plan) => {
      if (
        plan.nationId !== pending.nationId ||
        (plan.posture !== "hold" && plan.posture !== "reinforce")
      ) {
        return false;
      }
      const front = world.landFronts.physicalFrontsById.get(plan.frontId);
      return (
        !!front &&
        isSameNationPair(front, pending.nationId, pending.enemyNationId)
      );
    });
    if (returned) {
      state.returnedToHoldOrReinforceCount += 1;
      world.instrumentation?.incrementCounter("retreat.returnedToDefense");
    } else {
      retained.push(pending);
    }
  }
  state.awaitingDefensivePosture = retained;
}

function cancelRetreat(
  world: WorldState,
  retreat: RetreatPlan,
  reason: RetreatCompletionReason,
): void {
  retreat.outcome = "cancelled";
  retreat.completionReason = reason;
  retreat.completedAtTick = world.time.fastTick;
  world.retreatPlans.cancelledCount += 1;
  world.retreatPlans.survivingRetreatingStrength +=
    retreat.currentRetreatingStrength;
  world.retreatPlans.lastResolvedAtByFrontNation.set(
    createFrontNationKey(retreat.frontId, retreat.nationId),
    world.time.fastTick,
  );
  world.instrumentation?.incrementCounter("retreat.cancelled");
  recordEvent(world, retreat, "cancelled", reason);
}

function rebuildRetreatIndexes(state: RetreatPlanState): void {
  state.plans.sort(compareRetreatPlans);
  state.plansById = new Map(state.plans.map((plan) => [plan.id, plan]));
  state.plansByNationId = new Map();
  state.plansByFrontNation = new Map();
  state.retreatIdByUnitId = new Map();
  for (const retreat of state.plans) {
    const byNation = state.plansByNationId.get(retreat.nationId);
    if (byNation) byNation.push(retreat);
    else state.plansByNationId.set(retreat.nationId, [retreat]);
    state.plansByFrontNation.set(
      createFrontNationKey(retreat.frontId, retreat.nationId),
      retreat,
    );
    for (const unitId of [
      ...retreat.rearguardUnitIds,
      ...retreat.retreatingUnitIds,
    ]) {
      if (!state.retreatIdByUnitId.has(unitId)) {
        state.retreatIdByUnitId.set(unitId, retreat.id);
      }
    }
  }
}

function archiveRetreatPlan(world: WorldState, retreat: RetreatPlan): void {
  const clone: RetreatPlan = {
    ...retreat,
    rearguardUnitIds: [...retreat.rearguardUnitIds],
    retreatingUnitIds: [...retreat.retreatingUnitIds],
    initialRearguardUnitIds: [...retreat.initialRearguardUnitIds],
    initialRetreatingUnitIds: [...retreat.initialRetreatingUnitIds],
    fallbackRegionIds: [...retreat.fallbackRegionIds],
    unitTargetRegionIds: new Map(retreat.unitTargetRegionIds),
    reasonFlags: [...retreat.reasonFlags],
  };
  world.retreatPlans.history.push(clone);
  const limit = WORLD_BALANCE.war.landFront.retreat.historyLimit;
  if (world.retreatPlans.history.length > limit) {
    world.retreatPlans.history.splice(
      0,
      world.retreatPlans.history.length - limit,
    );
  }
}

function recordEvent(
  world: WorldState,
  retreat: RetreatPlan,
  type: RetreatEventType,
  detail: string,
): void {
  world.retreatPlans.timeline.push({
    tick: world.time.fastTick,
    retreatPlanId: retreat.id,
    nationId: retreat.nationId,
    frontId: retreat.frontId,
    type,
    phase: retreat.phase,
    detail,
  });
  const limit = WORLD_BALANCE.war.landFront.retreat.timelineLimit;
  if (world.retreatPlans.timeline.length > limit) {
    world.retreatPlans.timeline.splice(
      0,
      world.retreatPlans.timeline.length - limit,
    );
  }
}

function collectEngagedUnitIds(world: WorldState, nationId: NationId): Set<UnitId> {
  const battleRegionIds = new Set(world.battles.map((battle) => battle.mesoId));
  const engaged = new Set<UnitId>();
  for (const unit of world.units) {
    if (unit.domain !== "land" || unit.nationId !== nationId) continue;
    if (
      battleRegionIds.has(unit.regionId) ||
      (!!unit.moveToId && battleRegionIds.has(unit.moveToId))
    ) {
      engaged.add(unit.id);
    }
  }
  return engaged;
}

function collectFallbackFrontSources(
  world: WorldState,
  frontId: FrontId,
  nationId: NationId,
  enemyNationId: NationId,
): MesoRegionId[] {
  const exact = world.landFronts.physicalFrontsById.get(frontId);
  const sources = exact ? getFrontSide(exact, nationId)?.borderRegionIds ?? [] : [];
  if (sources.length > 0) return [...sources];
  return world.landFronts.physicalFronts
    .filter((front) => isSameNationPair(front, nationId, enemyNationId))
    .flatMap((front) => getFrontSide(front, nationId)?.borderRegionIds ?? []);
}

function collectReachableControlledRegions(
  sourceIds: MesoRegionId[],
  nationId: NationId,
  mesoById: Map<MesoRegionId, MesoRegion>,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  occupationByMesoId: Map<MesoRegionId, NationId>,
): Set<MesoRegionId> {
  return new Set(
    buildControlledDistances(
      sourceIds,
      nationId,
      mesoById,
      neighborsById,
      ownerByMesoId,
      occupationByMesoId,
    ).keys(),
  );
}

function buildControlledDistances(
  sourceIds: MesoRegionId[],
  nationId: NationId,
  mesoById: Map<MesoRegionId, MesoRegion>,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  occupationByMesoId: Map<MesoRegionId, NationId>,
): Map<MesoRegionId, number> {
  const distanceByRegion = new Map<MesoRegionId, number>();
  const queue: MesoRegionId[] = [];
  for (const sourceId of sourceIds) {
    const source = mesoById.get(sourceId);
    if (
      !source ||
      source.type === "sea" ||
      !isEffectivelyControlledBy(sourceId, nationId, ownerByMesoId, occupationByMesoId)
    ) {
      continue;
    }
    if (!distanceByRegion.has(sourceId)) {
      distanceByRegion.set(sourceId, 0);
      queue.push(sourceId);
    }
  }
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    const distance = distanceByRegion.get(current) ?? 0;
    for (const neighborId of neighborsById.get(current) ?? []) {
      const neighbor = mesoById.get(neighborId);
      if (
        !neighbor ||
        neighbor.type === "sea" ||
        distanceByRegion.has(neighborId) ||
        !isEffectivelyControlledBy(
          neighborId,
          nationId,
          ownerByMesoId,
          occupationByMesoId,
        )
      ) {
        continue;
      }
      distanceByRegion.set(neighborId, distance + 1);
      queue.push(neighborId);
    }
  }
  return distanceByRegion;
}

function indexEnemyUnitsByRegion(
  world: WorldState,
  nationId: NationId,
  warAdjacency: WarAdjacency,
): Map<MesoRegionId, number> {
  const result = new Map<MesoRegionId, number>();
  for (const unit of world.units) {
    if (
      unit.domain !== "land" ||
      unit.nationId === nationId ||
      !isAtWar(nationId, unit.nationId, warAdjacency)
    ) {
      continue;
    }
    result.set(
      unit.regionId,
      (result.get(unit.regionId) ?? 0) + finiteUnitStrength(unit),
    );
  }
  return result;
}

function isValidFallbackRegion(
  world: WorldState,
  regionId: MesoRegionId,
  nationId: NationId,
  warAdjacency: WarAdjacency,
): boolean {
  const meso = getMesoById(world).get(regionId);
  if (!meso || meso.type === "sea") return false;
  if (
    !isEffectivelyControlledBy(
      regionId,
      nationId,
      getOwnerByMesoId(world),
      world.occupation.mesoById,
    )
  ) {
    return false;
  }
  return !world.units.some(
    (unit) =>
      unit.domain === "land" &&
      unit.regionId === regionId &&
      isAtWar(nationId, unit.nationId, warAdjacency),
  );
}

function effectiveController(
  regionId: MesoRegionId,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  occupationByMesoId: Map<MesoRegionId, NationId>,
): NationId | undefined {
  return occupationByMesoId.get(regionId) ?? ownerByMesoId.get(regionId);
}

function isEffectivelyControlledBy(
  regionId: MesoRegionId,
  nationId: NationId,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  occupationByMesoId: Map<MesoRegionId, NationId>,
): boolean {
  return effectiveController(regionId, ownerByMesoId, occupationByMesoId) === nationId;
}

function frontFallbackDistance(
  front: PhysicalFront,
  retreat: RetreatPlan,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
): number {
  const side = getFrontSide(front, retreat.nationId);
  if (!side) return Number.POSITIVE_INFINITY;
  let best = Number.POSITIVE_INFINITY;
  for (const fallbackId of retreat.fallbackRegionIds) {
    for (const frontRegionId of side.influenceRegionIds) {
      if (fallbackId === frontRegionId) return 0;
      for (let distance = 1; distance <= 8; distance += 1) {
        if (graphDistanceWithin(fallbackId, frontRegionId, neighborsById, distance)) {
          best = Math.min(best, distance);
          break;
        }
      }
    }
  }
  return best;
}

function graphDistanceWithin(
  startId: MesoRegionId,
  targetId: MesoRegionId,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  maxDistance: number,
): boolean {
  if (startId === targetId) return true;
  const queue: Array<{ id: MesoRegionId; distance: number }> = [
    { id: startId, distance: 0 },
  ];
  const visited = new Set<MesoRegionId>([startId]);
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    if (current.distance >= maxDistance) continue;
    for (const neighborId of neighborsById.get(current.id) ?? []) {
      if (visited.has(neighborId)) continue;
      if (neighborId === targetId) return true;
      visited.add(neighborId);
      queue.push({ id: neighborId, distance: current.distance + 1 });
    }
  }
  return false;
}

function isSameNationPair(
  front: PhysicalFront,
  nationId: NationId,
  enemyNationId: NationId,
): boolean {
  return (
    (front.nationAId === nationId && front.nationBId === enemyNationId) ||
    (front.nationBId === nationId && front.nationAId === enemyNationId)
  );
}

function isRetreatLandUnit(
  unit: UnitState | undefined,
  nationId: NationId,
): unit is UnitState {
  return (
    !!unit &&
    unit.domain === "land" &&
    unit.nationId === nationId &&
    unit.org > 0 &&
    unit.manpower > 0 &&
    Number.isFinite(unit.moveTicksPerRegion) &&
    unit.moveTicksPerRegion > 0
  );
}

function compareRetreatCandidates(a: NationFrontPlan, b: NationFrontPlan): number {
  return b.priority - a.priority || compareIds(a.frontId, b.frontId) || compareIds(a.nationId, b.nationId);
}

function compareRetreatPlans(a: RetreatPlan, b: RetreatPlan): number {
  return compareIds(a.nationId, b.nationId) || compareIds(a.id, b.id);
}

function compareRetreatingUnits(a: UnitState, b: UnitState): number {
  return (
    a.org - b.org ||
    equipmentFulfillment(a) - equipmentFulfillment(b) ||
    finiteUnitStrength(a) - finiteUnitStrength(b) ||
    compareIds(a.id, b.id)
  );
}

function equipmentFulfillment(unit: UnitState): number {
  if (unit.equipment.length === 0) return 1;
  return finiteNumber(
    unit.equipment.reduce((total, slot) => total + slot.fill, 0) /
      unit.equipment.length,
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

function strengthRatio(friendly: number, enemy: number): number {
  const safeFriendly = finiteNumber(friendly);
  const safeEnemy = finiteNumber(enemy);
  return safeEnemy > 0 ? safeFriendly / safeEnemy : safeFriendly > 0 ? 100 : 1;
}

function createRetreatPlanId(index: number): RetreatPlanId {
  return `retreat-${index}` as RetreatPlanId;
}

function createFrontNationKey(frontId: FrontId, nationId: NationId): string {
  return `${frontId}::${nationId}`;
}

function areAssignmentMapsEqual(
  a: Map<UnitId, RetreatPlanId>,
  b: Map<UnitId, RetreatPlanId>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [unitId, retreatId] of a) {
    if (b.get(unitId) !== retreatId) return false;
  }
  return true;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
