import { WORLD_BALANCE } from "../data/balance";
import type { EquipmentKey } from "../data/equipment-catalog";
import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import { getCapitalDefenseAssessment } from "./capital-defense";
import { isNationActive } from "./nation-active";
import { releaseUnitFromFrontAllocation } from "./nation-front-allocations";
import {
  assignUnitToStrategicReserve,
  getNationReserveState,
  releaseStrategicReserveUnit,
} from "./strategic-reserves";
import type { UnitId, UnitState } from "./unit";
import { getUnitCombatStrength } from "./unit-strength";
import { buildWarAdjacency, isAtWar } from "./war-state";
import type { WorldState } from "./world-state";
import { getMesoById, getNeighborsById, getOwnerByMesoId } from "./world-cache";

export type ReorganizationPlanId = string & {
  __brand: "ReorganizationPlanId";
};

export type ReorganizationPhase = "moving-to-rear" | "reorganizing" | "ready";

export type ReorganizationReason =
  | "retreat-survivor"
  | "strategic-reserve"
  | "offensive-operation"
  | "capital-defense"
  | "organization-depleted"
  | "manpower-depleted"
  | "equipment-depleted";

export type ReorganizationOutcome =
  | "returned-to-front"
  | "returned-to-reserve"
  | "emergency-deployed"
  | "cancelled";

export type ReorganizationEventType =
  | "created"
  | "arrived"
  | "progress"
  | "ready"
  | "returned"
  | "interrupted"
  | "cancelled";

export interface ReorganizationPlan {
  id: ReorganizationPlanId;
  nationId: NationId;
  unitId: UnitId;
  locationRegionId: MesoRegionId;
  phase: ReorganizationPhase;
  startedAtTick: number;
  phaseStartedAtTick: number;
  targetTerritoryVersion: number;
  targetOccupationVersion: number;
  targetFrontVersion: number;
  initialManpowerRatio: number;
  initialEquipmentRatio: number;
  initialOrganizationRatio: number;
  reasonFlags: ReorganizationReason[];
  equipmentTargetRatioByKey: Map<EquipmentKey, number>;
  organizationRecovered: number;
  manpowerReinforced: number;
  equipmentReinforced: number;
  equipmentReinforcedByKey: Map<EquipmentKey, number>;
  manpowerResourceConsumed: number;
  equipmentStockConsumed: number;
  interruptionCount: number;
  waitingForManpower: boolean;
  waitingForEquipment: boolean;
  outcome: ReorganizationOutcome | null;
  completedAtTick: number | null;
}

export interface ReorganizationEvent {
  tick: number;
  planId: ReorganizationPlanId;
  nationId: NationId;
  unitId: UnitId;
  type: ReorganizationEventType;
  phase: ReorganizationPhase;
  detail: string;
}

interface ReturnObservation {
  planId: ReorganizationPlanId;
  nationId: NationId;
  unitId: UnitId;
  releasedAtTick: number;
  fromRetreat: boolean;
  fromReserve: boolean;
}

export interface ReorganizationState {
  enabled: boolean;
  plans: ReorganizationPlan[];
  plansById: Map<ReorganizationPlanId, ReorganizationPlan>;
  planIdByUnitId: Map<UnitId, ReorganizationPlanId>;
  plansByNationId: Map<NationId, ReorganizationPlan[]>;
  history: ReorganizationPlan[];
  timeline: ReorganizationEvent[];
  awaitingFrontReturn: ReturnObservation[];
  observedUnitBirthTickById: Map<UnitId, number>;
  observedActiveNationIds: Set<NationId>;
  version: number;
  membershipVersion: number;
  nextPlanNumber: number;
  createdCount: number;
  completedCount: number;
  cancelledCount: number;
  interruptedCount: number;
  organizationRecovered: number;
  manpowerReinforced: number;
  equipmentReinforced: number;
  manpowerResourceConsumed: number;
  equipmentStockConsumed: number;
  totalDurationTicks: number;
  returnedToFrontCount: number;
  returnedToReserveCount: number;
  retreatSurvivorsReturnedCount: number;
  reserveSurvivorsReturnedCount: number;
  emergencyEarlyDeploymentCount: number;
  resourceShortageCount: number;
  unitsWaitingForManpower: number;
  unitsWaitingForEquipment: number;
  destroyedUnitCount: number;
  destroyedUnitLifetimeTicks: number;
  nationEliminationCount: number;
  firstNationEliminationTick: number | null;
}

interface RearAreaContext {
  nationId: NationId;
  controlledRegionIds: Set<MesoRegionId>;
  safeRegionIds: Set<MesoRegionId>;
  componentByRegionId: Map<MesoRegionId, number>;
  candidatesByComponent: Map<number, MesoRegionId[]>;
  priorityByRegionId: Map<MesoRegionId, number>;
}

interface RecoveryResult {
  organization: number;
  manpower: number;
  equipment: number;
  waitingForManpower: boolean;
  waitingForEquipment: boolean;
}

interface RecentSourceReasons {
  retreatUnitIds: Set<UnitId>;
  operationUnitIds: Set<UnitId>;
}

interface CompletedReturn {
  plan: ReorganizationPlan;
  destination: "front" | "reserve";
}

export function createReorganizationState(enabled = true): ReorganizationState {
  return {
    enabled,
    plans: [],
    plansById: new Map(),
    planIdByUnitId: new Map(),
    plansByNationId: new Map(),
    history: [],
    timeline: [],
    awaitingFrontReturn: [],
    observedUnitBirthTickById: new Map(),
    observedActiveNationIds: new Set(),
    version: 0,
    membershipVersion: 0,
    nextPlanNumber: 0,
    createdCount: 0,
    completedCount: 0,
    cancelledCount: 0,
    interruptedCount: 0,
    organizationRecovered: 0,
    manpowerReinforced: 0,
    equipmentReinforced: 0,
    manpowerResourceConsumed: 0,
    equipmentStockConsumed: 0,
    totalDurationTicks: 0,
    returnedToFrontCount: 0,
    returnedToReserveCount: 0,
    retreatSurvivorsReturnedCount: 0,
    reserveSurvivorsReturnedCount: 0,
    emergencyEarlyDeploymentCount: 0,
    resourceShortageCount: 0,
    unitsWaitingForManpower: 0,
    unitsWaitingForEquipment: 0,
    destroyedUnitCount: 0,
    destroyedUnitLifetimeTicks: 0,
    nationEliminationCount: 0,
    firstNationEliminationTick: null,
  };
}

export function updateReorganization(world: WorldState): void {
  const state = world.reorganization;
  const startedAt = world.instrumentation ? performance.now() : 0;
  observeUnitLifetimes(world);
  observeNationLifecycles(world);
  observeFrontReturns(world);

  if (!state.enabled) {
    if (state.plans.length > 0) {
      for (const plan of state.plans) {
        cancelPlan(world, plan, "system-disabled");
      }
      state.plans = [];
      rebuildIndexes(state);
      state.membershipVersion += 1;
      state.version += 1;
    }
    recordEvaluationDuration(world, startedAt);
    return;
  }

  const settings = WORLD_BALANCE.war.landFront.reorganization;
  if (
    settings.evaluationIntervalSlowTicks > 1 &&
    world.time.slowTick % settings.evaluationIntervalSlowTicks !== 0
  ) {
    recordEvaluationDuration(world, startedAt);
    return;
  }

  const previousMembership = new Map(state.planIdByUnitId);
  const unitById = new Map(world.units.map((unit) => [unit.id, unit]));
  const recentSources = collectRecentSourceReasons(world);
  const frontExtractionBudget = buildFrontExtractionBudget(world);
  const contextNationIds = new Set<NationId>();
  for (const plan of state.plans) {
    const unit = unitById.get(plan.unitId);
    if (!unit || rearTargetNeedsReevaluation(world, plan, unit)) {
      contextNationIds.add(plan.nationId);
    }
  }
  for (const unit of world.units) {
    if (
      !state.planIdByUnitId.has(unit.id) &&
      couldNeedReorganization(unit, recentSources) &&
      canStartReorganization(world, unit) &&
      hasFrontExtractionBudget(world, unit, frontExtractionBudget)
    ) {
      contextNationIds.add(unit.nationId);
    }
  }
  const rearContexts = buildRearAreaContexts(world, contextNationIds);
  const emergencyUnitIds = selectEmergencyEarlyDeployments(world, unitById);
  const retained: ReorganizationPlan[] = [];
  const resolvedUnitIds = new Set<UnitId>();
  const completedReturns: CompletedReturn[] = [];
  let waitingForManpower = 0;
  let waitingForEquipment = 0;
  const reinforcementStartedAt = world.instrumentation ? performance.now() : 0;

  for (const plan of [...state.plans].sort(comparePlanRecoveryPriority)) {
    const unit = unitById.get(plan.unitId);
    if (!isValidPlanUnit(unit, plan.nationId)) {
      cancelPlan(world, plan, "unit-invalid");
      resolvedUnitIds.add(plan.unitId);
      continue;
    }
    if (emergencyUnitIds.has(plan.unitId)) {
      completeEmergencyDeployment(world, plan);
      resolvedUnitIds.add(plan.unitId);
      continue;
    }

    const targetNeedsReevaluation = rearTargetNeedsReevaluation(
      world,
      plan,
      unit,
    );
    const context = rearContexts.get(plan.nationId);
    if (targetNeedsReevaluation && !context) {
      interruptOrCancelPlan(world, plan, unit, undefined);
      resolvedUnitIds.add(plan.unitId);
      continue;
    }
    if (context && !isPlanTargetSafeAndReachable(plan, unit, context)) {
      const replacement = selectRearRegion(world, unit, context);
      if (!replacement) {
        interruptOrCancelPlan(world, plan, unit, undefined);
        resolvedUnitIds.add(plan.unitId);
        continue;
      }
      if (replacement !== plan.locationRegionId) {
        interruptOrCancelPlan(world, plan, unit, replacement);
      }
    } else if (targetNeedsReevaluation && context) {
      plan.targetTerritoryVersion = world.territoryVersion;
      plan.targetOccupationVersion = world.occupation.version;
      plan.targetFrontVersion = world.landFronts.version;
    }

    if (unit.regionId !== plan.locationRegionId) {
      if (plan.phase !== "moving-to-rear") {
        plan.phase = "moving-to-rear";
        plan.phaseStartedAtTick = world.time.fastTick;
      }
      retained.push(plan);
      continue;
    }

    if (plan.phase === "moving-to-rear") {
      plan.phase = "reorganizing";
      plan.phaseStartedAtTick = world.time.fastTick;
      clearMovement(unit);
      recordEvent(world, plan, "arrived", plan.locationRegionId);
    }

    const recovery = recoverUnit(world, plan, unit);
    waitingForManpower += Number(recovery.waitingForManpower);
    waitingForEquipment += Number(recovery.waitingForEquipment);
    if (recovery.organization + recovery.manpower + recovery.equipment > 0) {
      recordEvent(
        world,
        plan,
        "progress",
        `org+${recovery.organization.toFixed(3)} manpower+${recovery.manpower.toFixed(1)} equipment+${recovery.equipment.toFixed(2)}`,
      );
    }

    if (isUnitReady(unit)) {
      plan.phase = "ready";
      plan.phaseStartedAtTick = world.time.fastTick;
      const destination = selectReturnDestination(world, plan, unit);
      completePlan(world, plan, destination);
      completedReturns.push({ plan, destination });
      resolvedUnitIds.add(plan.unitId);
      continue;
    }
    retained.push(plan);
  }

  if (world.instrumentation) {
    world.instrumentation.recordDuration(
      "reorganization.reinforcement",
      performance.now() - reinforcementStartedAt,
    );
  }

  state.plans = retained;
  rebuildIndexes(state);
  for (const completed of completedReturns) {
    handleCompletedReturn(world, completed.plan, completed.destination);
  }

  const candidates = world.units
    .filter((unit) => unit.domain === "land")
    .sort((a, b) => compareCandidateUnits(world, recentSources, a, b));
  for (const unit of candidates) {
    if (
      resolvedUnitIds.has(unit.id) ||
      state.planIdByUnitId.has(unit.id) ||
      !canStartReorganization(world, unit)
    ) {
      continue;
    }
    const reasons = collectCandidateReasons(world, unit, recentSources);
    if (reasons.length === 0) continue;
    if (!consumeFrontExtractionBudget(world, unit, frontExtractionBudget)) {
      continue;
    }
    const context = rearContexts.get(unit.nationId);
    const locationRegionId = context
      ? selectRearRegion(world, unit, context)
      : undefined;
    if (!locationRegionId) continue;

    releaseStrategicReserveUnit(world, unit.id);
    releaseUnitFromFrontAllocation(world, unit.id);
    const plan = createPlan(world, unit, locationRegionId, reasons);
    state.plans.push(plan);
    state.createdCount += 1;
    world.instrumentation?.incrementCounter("reorganization.created");
    recordEvent(world, plan, "created", reasons.join(","));
    state.planIdByUnitId.set(unit.id, plan.id);
  }

  state.unitsWaitingForManpower = waitingForManpower;
  state.unitsWaitingForEquipment = waitingForEquipment;
  world.instrumentation?.incrementCounter(
    "reorganization.waitingForManpower",
    waitingForManpower,
  );
  world.instrumentation?.incrementCounter(
    "reorganization.waitingForEquipment",
    waitingForEquipment,
  );

  state.plans.sort(comparePlans);
  rebuildIndexes(state);
  const membershipChanged = !assignmentMapsEqual(
    previousMembership,
    state.planIdByUnitId,
  );
  if (membershipChanged) state.membershipVersion += 1;
  state.version += 1;
  trimHistoryAndTimeline(state);
  recordEvaluationDuration(world, startedAt);
}

function couldNeedReorganization(
  unit: UnitState,
  sources: RecentSourceReasons,
): boolean {
  if (unit.domain !== "land" || unit.manpower <= 0 || unit.org <= 0) return false;
  const settings = WORLD_BALANCE.war.landFront.reorganization;
  const retreat = sources.retreatUnitIds.has(unit.id);
  return (
    unit.org <
      (retreat
        ? settings.retreatOrganizationStartRatio
        : settings.organizationStartRatio) ||
    getUnitManpowerRatio(unit) <
      (retreat ? settings.retreatManpowerStartRatio : settings.manpowerStartRatio) ||
    getUnitEquipmentFulfillment(unit) <
      (retreat
        ? settings.retreatEquipmentStartRatio
        : settings.equipmentStartRatio)
  );
}

function buildFrontExtractionBudget(world: WorldState): Map<string, number> {
  const settings = WORLD_BALANCE.war.landFront.reorganization;
  return new Map(
    world.frontAllocations.allocations.map((allocation) => {
      const maximumByShare =
        allocation.allocatedStrength *
        settings.maximumFrontExtractionStrengthFraction;
      const maximumByDesiredFloor = Math.max(
        0,
        allocation.allocatedStrength -
          allocation.desiredStrength * settings.frontExtractionDesiredFloorRatio,
      );
      return [
        `${allocation.frontId}::${allocation.nationId}`,
        Math.min(maximumByShare, maximumByDesiredFloor),
      ];
    }),
  );
}

function consumeFrontExtractionBudget(
  world: WorldState,
  unit: UnitState,
  budgetByFrontNation: Map<string, number>,
): boolean {
  const frontId = world.frontAllocations.frontIdByUnitId.get(unit.id);
  if (!frontId) return true;
  const allocation = world.frontAllocations.allocationsByFrontNation.get(
    `${frontId}::${unit.nationId}`,
  );
  if (!allocation) return true;
  const settings = WORLD_BALANCE.war.landFront.reorganization;
  if (
    allocation.unitIds.length <= settings.minimumFrontUnitsAfterExtraction
  ) {
    return false;
  }
  const key = `${frontId}::${unit.nationId}`;
  const budget = budgetByFrontNation.get(key) ?? 0;
  const strength = finiteUnitStrength(unit);
  if (strength > budget + 1e-9) return false;
  budgetByFrontNation.set(key, Math.max(0, budget - strength));
  return true;
}

function hasFrontExtractionBudget(
  world: WorldState,
  unit: UnitState,
  budgetByFrontNation: ReadonlyMap<string, number>,
): boolean {
  const frontId = world.frontAllocations.frontIdByUnitId.get(unit.id);
  if (!frontId) return true;
  const allocation = world.frontAllocations.allocationsByFrontNation.get(
    `${frontId}::${unit.nationId}`,
  );
  if (!allocation) return true;
  const settings = WORLD_BALANCE.war.landFront.reorganization;
  if (allocation.unitIds.length <= settings.minimumFrontUnitsAfterExtraction) {
    return false;
  }
  return (
    finiteUnitStrength(unit) <=
    (budgetByFrontNation.get(`${frontId}::${unit.nationId}`) ?? 0) + 1e-9
  );
}

export function getReorganizationPlans(
  world: WorldState,
  nationId?: NationId,
): readonly ReorganizationPlan[] {
  return nationId === undefined
    ? world.reorganization.plans
    : (world.reorganization.plansByNationId.get(nationId) ?? []);
}

export function getReorganizationPlanForUnit(
  world: WorldState,
  unitId: UnitId,
): ReorganizationPlan | undefined {
  const planId = world.reorganization.planIdByUnitId.get(unitId);
  return planId ? world.reorganization.plansById.get(planId) : undefined;
}

export function isReorganizingUnit(world: WorldState, unitId: UnitId): boolean {
  return world.reorganization.planIdByUnitId.has(unitId);
}

export function getReorganizationTargetForUnit(
  world: WorldState,
  unitId: UnitId,
): MesoRegionId | undefined {
  return getReorganizationPlanForUnit(world, unitId)?.locationRegionId;
}

export function getUnitManpowerRatio(unit: UnitState): number {
  const maximum = getMaximumManpower(unit);
  return maximum > 0 ? clamp(finiteNumber(unit.manpower) / maximum, 0, 1) : 1;
}

/** Equipment slots are the existing model mix; their fills sum to fulfillment. */
export function getUnitEquipmentFulfillment(unit: UnitState): number {
  if (unit.domain !== "land" || unit.equipment.length === 0) return 1;
  return clamp(
    unit.equipment.reduce((total, slot) => total + finiteNumber(slot.fill), 0),
    0,
    1,
  );
}

export function formatReorganizationSummary(world: WorldState): string {
  return world.reorganization.plans
    .map((plan) => {
      const unit = world.units.find((candidate) => candidate.id === plan.unitId);
      const nation = world.nations.find((candidate) => candidate.id === plan.nationId);
      const equipmentLines = unit
        ? unit.equipment.map((slot) => {
            const reinforced = plan.equipmentReinforcedByKey.get(slot.equipmentKey) ?? 0;
            return `    ${slot.equipmentKey}: fill ${(slot.fill * 100).toFixed(1)}%, reinforced +${reinforced.toFixed(2)}`;
          })
        : [];
      return [
        `Nation ${plan.nationId} Reorganization`,
        `  Unit ${plan.unitId}`,
        `  location: ${plan.locationRegionId}`,
        `  phase: ${plan.phase}`,
        `  organization: ${(plan.initialOrganizationRatio * 100).toFixed(1)}% -> ${((unit?.org ?? 0) * 100).toFixed(1)}%`,
        `  manpower: ${unit?.manpower.toFixed(1) ?? "missing"} / ${unit ? getMaximumManpower(unit).toFixed(1) : "missing"}`,
        `  manpower reinforced: +${plan.manpowerReinforced.toFixed(1)}`,
        "  equipment:",
        ...equipmentLines,
        `  resources consumed: manpower ${plan.manpowerResourceConsumed.toFixed(1)}, weapons ${plan.equipmentStockConsumed.toFixed(2)}`,
        `  nation stocks: manpower ${nation?.resources.manpower.toFixed(1) ?? "missing"}, weapons ${nation?.resources.weapons.toFixed(2) ?? "missing"}`,
      ].join("\n");
    })
    .join("\n");
}

function createPlan(
  world: WorldState,
  unit: UnitState,
  locationRegionId: MesoRegionId,
  reasonFlags: ReorganizationReason[],
): ReorganizationPlan {
  const now = world.time.fastTick;
  const phase: ReorganizationPhase =
    unit.regionId === locationRegionId ? "reorganizing" : "moving-to-rear";
  clearMovement(unit);
  return {
    id: `reorganization-${world.reorganization.nextPlanNumber++}` as ReorganizationPlanId,
    nationId: unit.nationId,
    unitId: unit.id,
    locationRegionId,
    phase,
    startedAtTick: now,
    phaseStartedAtTick: now,
    targetTerritoryVersion: world.territoryVersion,
    targetOccupationVersion: world.occupation.version,
    targetFrontVersion: world.landFronts.version,
    initialManpowerRatio: getUnitManpowerRatio(unit),
    initialEquipmentRatio: getUnitEquipmentFulfillment(unit),
    initialOrganizationRatio: clamp(finiteNumber(unit.org), 0, 1),
    reasonFlags: [...reasonFlags].sort(compareIds),
    equipmentTargetRatioByKey: captureEquipmentMix(unit),
    organizationRecovered: 0,
    manpowerReinforced: 0,
    equipmentReinforced: 0,
    equipmentReinforcedByKey: new Map(),
    manpowerResourceConsumed: 0,
    equipmentStockConsumed: 0,
    interruptionCount: 0,
    waitingForManpower: false,
    waitingForEquipment: false,
    outcome: null,
    completedAtTick: null,
  };
}

function recoverUnit(
  world: WorldState,
  plan: ReorganizationPlan,
  unit: UnitState,
): RecoveryResult {
  const settings = WORLD_BALANCE.war.landFront.reorganization;
  const nation = world.nations.find((candidate) => candidate.id === plan.nationId);
  if (!nation) {
    return {
      organization: 0,
      manpower: 0,
      equipment: 0,
      waitingForManpower: false,
      waitingForEquipment: false,
    };
  }
  const resourceStartedAt = world.instrumentation ? performance.now() : 0;
  const multiplier = getFacilityMultiplier(world, plan.locationRegionId);
  const organization = Math.min(
    Math.max(0, 1 - finiteNumber(unit.org)),
    settings.organizationRecoveryPerSlowTick * multiplier,
  );
  unit.org = clamp(finiteNumber(unit.org) + organization, 0, 1);

  const maximumManpower = getMaximumManpower(unit);
  const manpowerDeficit = Math.max(0, maximumManpower - finiteNumber(unit.manpower));
  const manpower = Math.min(
    manpowerDeficit,
    settings.manpowerPerSlowTick * multiplier,
    finiteNumber(nation.resources.manpower),
  );
  if (manpower > 0) {
    unit.manpower = Math.min(maximumManpower, finiteNumber(unit.manpower) + manpower);
    consumeNationResource(world, nation, "manpower", manpower);
  }
  const waitingForManpower = manpowerDeficit > 0 && manpower <= 0;

  const weaponCost = getMaximumEquipmentStock(unit);
  const fulfillment = getUnitEquipmentFulfillment(unit);
  const equipmentDeficit = Math.max(0, (1 - fulfillment) * weaponCost);
  const equipment =
    weaponCost > 0
      ? Math.min(
          equipmentDeficit,
          settings.equipmentStockPerSlowTick * multiplier,
          finiteNumber(nation.resources.weapons),
        )
      : 0;
  if (equipment > 0) {
    const reinforcedByKey = applyEquipmentReinforcement(
      unit,
      plan.equipmentTargetRatioByKey,
      equipment / weaponCost,
      equipment,
    );
    for (const [key, amount] of reinforcedByKey) {
      plan.equipmentReinforcedByKey.set(
        key,
        (plan.equipmentReinforcedByKey.get(key) ?? 0) + amount,
      );
    }
    consumeNationResource(world, nation, "weapons", equipment);
  }
  const waitingForEquipment = equipmentDeficit > 0 && equipment <= 0;

  plan.organizationRecovered += organization;
  plan.manpowerReinforced += manpower;
  plan.equipmentReinforced += equipment;
  plan.manpowerResourceConsumed += manpower;
  plan.equipmentStockConsumed += equipment;
  plan.waitingForManpower = waitingForManpower;
  plan.waitingForEquipment = waitingForEquipment;
  const state = world.reorganization;
  state.organizationRecovered += organization;
  state.manpowerReinforced += manpower;
  state.equipmentReinforced += equipment;
  state.manpowerResourceConsumed += manpower;
  state.equipmentStockConsumed += equipment;
  world.instrumentation?.incrementCounter(
    "reorganization.organizationRecovered",
    organization,
  );
  world.instrumentation?.incrementCounter(
    "reorganization.manpowerReinforced",
    manpower,
  );
  world.instrumentation?.incrementCounter(
    "reorganization.equipmentReinforced",
    equipment,
  );
  world.instrumentation?.incrementCounter(
    "reorganization.manpowerConsumed",
    manpower,
  );
  world.instrumentation?.incrementCounter(
    "reorganization.equipmentConsumed",
    equipment,
  );
  if (waitingForManpower || waitingForEquipment) {
    const shortages = Number(waitingForManpower) + Number(waitingForEquipment);
    state.resourceShortageCount += shortages;
    world.instrumentation?.incrementCounter(
      "reorganization.resourceShortages",
      shortages,
    );
  }
  if (world.instrumentation) {
    world.instrumentation.recordDuration(
      "reorganization.resourceUpdates",
      performance.now() - resourceStartedAt,
    );
  }
  return {
    organization,
    manpower,
    equipment,
    waitingForManpower,
    waitingForEquipment,
  };
}

function consumeNationResource(
  world: WorldState,
  nation: WorldState["nations"][number],
  resource: "manpower" | "weapons",
  amount: number,
): void {
  const consumed = Math.min(finiteNumber(nation.resources[resource]), finiteNumber(amount));
  nation.resources[resource] = Math.max(0, nation.resources[resource] - consumed);
  nation.resourceFlow.usage[resource] += consumed;
  nation.resourceFlow.delta[resource] -= consumed;
}

function applyEquipmentReinforcement(
  unit: UnitState,
  targetRatioByKey: Map<EquipmentKey, number>,
  fulfillmentIncrease: number,
  stockConsumed: number,
): Map<EquipmentKey, number> {
  const before = getUnitEquipmentFulfillment(unit);
  const after = clamp(before + fulfillmentIncrease, 0, 1);
  const reinforced = new Map<EquipmentKey, number>();
  for (const slot of unit.equipment) {
    const share = targetRatioByKey.get(slot.equipmentKey) ?? 0;
    slot.fill = clamp(after * share, 0, 1);
    reinforced.set(slot.equipmentKey, stockConsumed * share);
  }
  return reinforced;
}

function captureEquipmentMix(unit: UnitState): Map<EquipmentKey, number> {
  if (unit.equipment.length === 0) return new Map();
  const total = unit.equipment.reduce(
    (sum, slot) => sum + finiteNumber(slot.fill),
    0,
  );
  if (total <= 0) {
    const equal = 1 / unit.equipment.length;
    return new Map(unit.equipment.map((slot) => [slot.equipmentKey, equal]));
  }
  return new Map(
    unit.equipment.map((slot) => [
      slot.equipmentKey,
      finiteNumber(slot.fill) / total,
    ]),
  );
}

function collectCandidateReasons(
  world: WorldState,
  unit: UnitState,
  sources: RecentSourceReasons,
): ReorganizationReason[] {
  const settings = WORLD_BALANCE.war.landFront.reorganization;
  const retreatSurvivor = sources.retreatUnitIds.has(unit.id);
  const reasons: ReorganizationReason[] = [];
  if (retreatSurvivor) reasons.push("retreat-survivor");
  if (world.strategicReserves.reserveNationByUnitId.has(unit.id)) {
    reasons.push("strategic-reserve");
  }
  if (sources.operationUnitIds.has(unit.id)) reasons.push("offensive-operation");
  if (isCapitalDefenseRelated(world, unit)) reasons.push("capital-defense");

  const organizationThreshold = retreatSurvivor
    ? settings.retreatOrganizationStartRatio
    : settings.organizationStartRatio;
  const manpowerThreshold = retreatSurvivor
    ? settings.retreatManpowerStartRatio
    : settings.manpowerStartRatio;
  const equipmentThreshold = retreatSurvivor
    ? settings.retreatEquipmentStartRatio
    : settings.equipmentStartRatio;
  if (clamp(finiteNumber(unit.org), 0, 1) < organizationThreshold) {
    reasons.push("organization-depleted");
  }
  if (getUnitManpowerRatio(unit) < manpowerThreshold) {
    reasons.push("manpower-depleted");
  }
  if (getUnitEquipmentFulfillment(unit) < equipmentThreshold) {
    reasons.push("equipment-depleted");
  }

  const damaged = reasons.some(
    (reason) =>
      reason === "organization-depleted" ||
      reason === "manpower-depleted" ||
      reason === "equipment-depleted",
  );
  return damaged ? [...new Set(reasons)].sort(compareIds) : [];
}

function canStartReorganization(world: WorldState, unit: UnitState): boolean {
  if (!isValidPlanUnit(unit, unit.nationId)) return false;
  if (world.retreatPlans.retreatIdByUnitId.has(unit.id)) return false;
  if (world.offensiveOperations.operationIdByUnitId.has(unit.id)) return false;
  if (isUnitInActiveBattle(world, unit)) return false;
  const reserve = getNationReserveState(world, unit.nationId);
  if (reserve?.unitIds.includes(unit.id)) {
    const deployment = reserve.deployment;
    if (deployment && deployment.status !== "returning") return false;
  }
  const capital = getCapitalDefenseAssessment(world, unit.nationId);
  if (
    capital?.threatLevel === "critical" &&
    capital.friendlyUnitIds.includes(unit.id)
  ) {
    return false;
  }
  return true;
}

function collectRecentSourceReasons(world: WorldState): RecentSourceReasons {
  const settings = WORLD_BALANCE.war.landFront.reorganization;
  const now = world.time.fastTick;
  const retreatUnitIds = new Set<UnitId>();
  for (const retreat of world.retreatPlans.history) {
    if (
      retreat.outcome !== "success" ||
      retreat.completedAtTick === null ||
      now - retreat.completedAtTick > settings.retreatHandoffWindowTicks
    ) {
      continue;
    }
    for (const unitId of [
      ...retreat.initialRearguardUnitIds,
      ...retreat.initialRetreatingUnitIds,
    ]) {
      retreatUnitIds.add(unitId);
    }
  }

  const operationUnitIds = new Set<UnitId>();
  for (const operation of [
    ...world.offensiveOperations.operations,
    ...world.offensiveOperations.history,
  ]) {
    if (
      operation.phase !== "recovering" ||
      operation.completedAtTick === null ||
      now - operation.completedAtTick > settings.operationHandoffWindowTicks
    ) {
      continue;
    }
    for (const unitId of operation.initialAssignedUnitIds) {
      operationUnitIds.add(unitId);
    }
  }
  return { retreatUnitIds, operationUnitIds };
}

function buildRearAreaContexts(
  world: WorldState,
  nationIds: ReadonlySet<NationId>,
): Map<NationId, RearAreaContext> {
  const result = new Map<NationId, RearAreaContext>();
  for (const nation of world.nations
    .filter((candidate) => nationIds.has(candidate.id) && isNationActive(candidate))
    .sort(compareNations)) {
    result.set(nation.id, buildRearAreaContext(world, nation.id));
  }
  return result;
}

function buildRearAreaContext(
  world: WorldState,
  nationId: NationId,
): RearAreaContext {
  const mesoById = getMesoById(world);
  const neighborsById = getNeighborsById(world);
  const ownerByMesoId = getOwnerByMesoId(world);
  const controlledRegionIds = new Set<MesoRegionId>();
  for (const region of world.mesoRegions) {
    if (
      region.type !== "sea" &&
      effectiveController(region.id, ownerByMesoId, world.occupation.mesoById) ===
        nationId
    ) {
      controlledRegionIds.add(region.id);
    }
  }

  const componentByRegionId = new Map<MesoRegionId, number>();
  let component = 0;
  for (const source of [...controlledRegionIds].sort(compareIds)) {
    if (componentByRegionId.has(source)) continue;
    const queue = [source];
    componentByRegionId.set(source, component);
    for (let head = 0; head < queue.length; head += 1) {
      for (const neighborId of neighborsById.get(queue[head]) ?? []) {
        if (
          !controlledRegionIds.has(neighborId) ||
          componentByRegionId.has(neighborId)
        ) {
          continue;
        }
        componentByRegionId.set(neighborId, component);
        queue.push(neighborId);
      }
    }
    component += 1;
  }

  const frontSources = (
    world.landFronts.physicalFrontsByNationId.get(nationId) ?? []
  ).flatMap((front) => {
    if (front.sideA.nationId === nationId) return front.sideA.borderRegionIds;
    if (front.sideB.nationId === nationId) return front.sideB.borderRegionIds;
    return [];
  });
  const frontDistance = buildControlledDistanceField(
    frontSources,
    controlledRegionIds,
    neighborsById,
  );
  const warAdjacency = buildWarAdjacency(world.wars);
  const enemyRegionIds = new Set(
    world.units
      .filter(
        (unit) =>
          unit.domain === "land" &&
          isAtWar(nationId, unit.nationId, warAdjacency),
      )
      .map((unit) => unit.regionId),
  );
  const battleRegionIds = new Set(world.battles.map((battle) => battle.mesoId));
  const safeRegionIds = new Set<MesoRegionId>();
  const minimumDistance =
    WORLD_BALANCE.war.landFront.reorganization.minimumEnemyFrontDistance;
  for (const regionId of controlledRegionIds) {
    const distance = frontSources.length > 0 ? frontDistance.get(regionId) : Infinity;
    if (
      distance !== undefined &&
      distance >= minimumDistance &&
      !enemyRegionIds.has(regionId) &&
      !battleRegionIds.has(regionId)
    ) {
      safeRegionIds.add(regionId);
    }
  }

  const nation = world.nations.find((candidate) => candidate.id === nationId);
  const reserveStaging = new Set(
    getNationReserveState(world, nationId)?.stagingRegionIds ?? [],
  );
  const retreatFallback = new Set(
    world.retreatPlans.plans
      .filter((plan) => plan.nationId === nationId)
      .flatMap((plan) => plan.fallbackRegionIds),
  );
  const priorityByRegionId = new Map<MesoRegionId, number>();
  const candidatesByComponent = new Map<number, MesoRegionId[]>();
  for (const regionId of safeRegionIds) {
    const region = mesoById.get(regionId);
    const priority =
      regionId === nation?.capitalMesoId || region?.building === "capital"
        ? 0
        : region?.building === "city"
          ? 1
          : reserveStaging.has(regionId)
            ? 2
            : retreatFallback.has(regionId)
              ? 3
              : 4;
    priorityByRegionId.set(regionId, priority);
    const componentId = componentByRegionId.get(regionId);
    if (componentId === undefined) continue;
    const list = candidatesByComponent.get(componentId);
    if (list) list.push(regionId);
    else candidatesByComponent.set(componentId, [regionId]);
  }
  for (const list of candidatesByComponent.values()) {
    list.sort(
      (a, b) =>
        (priorityByRegionId.get(a) ?? 4) -
          (priorityByRegionId.get(b) ?? 4) ||
        compareIds(a, b),
    );
  }
  return {
    nationId,
    controlledRegionIds,
    safeRegionIds,
    componentByRegionId,
    candidatesByComponent,
    priorityByRegionId,
  };
}

function selectRearRegion(
  world: WorldState,
  unit: UnitState,
  context: RearAreaContext,
): MesoRegionId | undefined {
  const componentId = context.componentByRegionId.get(unit.regionId);
  if (componentId === undefined) return undefined;
  const candidates = context.candidatesByComponent.get(componentId) ?? [];
  if (candidates.length === 0) return undefined;
  const bestPriority = context.priorityByRegionId.get(candidates[0]) ?? 4;
  const mesoById = getMesoById(world);
  const unitCenter = mesoById.get(unit.regionId)?.center;
  return candidates
    .filter(
      (regionId) =>
        (context.priorityByRegionId.get(regionId) ?? 4) === bestPriority,
    )
    .sort((a, b) => {
      const centerA = mesoById.get(a)?.center;
      const centerB = mesoById.get(b)?.center;
      const distanceA = unitCenter && centerA ? distanceSquared(unitCenter, centerA) : 0;
      const distanceB = unitCenter && centerB ? distanceSquared(unitCenter, centerB) : 0;
      return distanceA - distanceB || compareIds(a, b);
    })[0];
}

function buildControlledDistanceField(
  sources: MesoRegionId[],
  controlledRegionIds: ReadonlySet<MesoRegionId>,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
): Map<MesoRegionId, number> {
  const distances = new Map<MesoRegionId, number>();
  const queue: MesoRegionId[] = [];
  for (const source of [...new Set(sources)].sort(compareIds)) {
    if (!controlledRegionIds.has(source) || distances.has(source)) continue;
    distances.set(source, 0);
    queue.push(source);
  }
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    const distance = distances.get(current) ?? 0;
    for (const neighborId of neighborsById.get(current) ?? []) {
      if (!controlledRegionIds.has(neighborId) || distances.has(neighborId)) {
        continue;
      }
      distances.set(neighborId, distance + 1);
      queue.push(neighborId);
    }
  }
  return distances;
}

function isPlanTargetSafeAndReachable(
  plan: ReorganizationPlan,
  unit: UnitState,
  context: RearAreaContext,
): boolean {
  return (
    context.safeRegionIds.has(plan.locationRegionId) &&
    context.componentByRegionId.get(unit.regionId) !== undefined &&
    context.componentByRegionId.get(unit.regionId) ===
      context.componentByRegionId.get(plan.locationRegionId)
  );
}

function rearTargetNeedsReevaluation(
  world: WorldState,
  plan: ReorganizationPlan,
  unit: UnitState,
): boolean {
  if (
    plan.targetTerritoryVersion !== world.territoryVersion ||
    plan.targetOccupationVersion !== world.occupation.version ||
    plan.targetFrontVersion !== world.landFronts.version
  ) {
    return true;
  }
  const target = getMesoById(world).get(plan.locationRegionId);
  if (!target || target.type === "sea") return true;
  const ownerByMesoId = getOwnerByMesoId(world);
  if (
    effectiveController(
      plan.locationRegionId,
      ownerByMesoId,
      world.occupation.mesoById,
    ) !== plan.nationId ||
    effectiveController(
      unit.regionId,
      ownerByMesoId,
      world.occupation.mesoById,
    ) !== plan.nationId
  ) {
    return true;
  }
  if (world.battles.some((battle) => battle.mesoId === plan.locationRegionId)) {
    return true;
  }
  const warAdjacency = buildWarAdjacency(world.wars);
  return world.units.some(
    (candidate) =>
      candidate.domain === "land" &&
      candidate.regionId === plan.locationRegionId &&
      isAtWar(plan.nationId, candidate.nationId, warAdjacency),
  );
}

function selectEmergencyEarlyDeployments(
  world: WorldState,
  unitById: Map<UnitId, UnitState>,
): Set<UnitId> {
  const settings = WORLD_BALANCE.war.landFront.reorganization;
  const selected = new Set<UnitId>();
  for (const [nationId, plans] of world.reorganization.plansByNationId) {
    if (getCapitalDefenseAssessment(world, nationId)?.threatLevel !== "critical") {
      continue;
    }
    const eligible = plans
      .map((plan) => ({ plan, unit: unitById.get(plan.unitId) }))
      .filter(
        (entry): entry is { plan: ReorganizationPlan; unit: UnitState } =>
          !!entry.unit &&
          entry.plan.phase === "reorganizing" &&
          entry.unit.org >= settings.emergencyMinimumOrganizationRatio &&
          combatReadinessRatio(entry.unit) >=
            settings.emergencyMinimumCombatReadinessRatio,
      )
      .sort(
        (a, b) =>
          combatReadinessRatio(b.unit) - combatReadinessRatio(a.unit) ||
          compareIds(a.unit.id, b.unit.id),
      );
    const count = Math.min(
      eligible.length,
      Math.max(1, Math.ceil(plans.length * settings.emergencyMaximumReleaseFraction)),
    );
    for (const entry of eligible.slice(0, count)) selected.add(entry.unit.id);
  }
  return selected;
}

function selectReturnDestination(
  world: WorldState,
  plan: ReorganizationPlan,
  unit: UnitState,
): "front" | "reserve" {
  if (getCapitalDefenseAssessment(world, plan.nationId)?.threatLevel === "critical") {
    return "front";
  }
  const reserveSettings = WORLD_BALANCE.war.landFront.strategicReserve;
  const severeDeficit = world.frontAllocations.allocations.some(
    (allocation) =>
      allocation.nationId === plan.nationId &&
      allocation.posture === "reinforce" &&
      allocation.desiredStrength > 0 &&
      allocation.deficit / allocation.desiredStrength >=
        reserveSettings.severeDeficitRatio,
  );
  if (severeDeficit) return "front";
  const reserve = getNationReserveState(world, plan.nationId);
  if (
    reserve &&
    reserve.stagingRegionIds.length > 0 &&
    reserve.totalStrength + finiteUnitStrength(unit) <=
      reserve.desiredReserveStrength * 1.1
  ) {
    return "reserve";
  }
  return "front";
}

function handleCompletedReturn(
  world: WorldState,
  plan: ReorganizationPlan,
  destination: "front" | "reserve",
): void {
  if (destination === "reserve" && assignUnitToStrategicReserve(world, plan.unitId)) {
    world.reorganization.returnedToReserveCount += 1;
    if (plan.reasonFlags.includes("retreat-survivor")) {
      world.reorganization.retreatSurvivorsReturnedCount += 1;
    }
    if (plan.reasonFlags.includes("strategic-reserve")) {
      world.reorganization.reserveSurvivorsReturnedCount += 1;
    }
    world.instrumentation?.incrementCounter("reorganization.returnedToReserve");
    recordEvent(world, plan, "returned", "strategic-reserve");
    return;
  }
  world.reorganization.awaitingFrontReturn.push({
    planId: plan.id,
    nationId: plan.nationId,
    unitId: plan.unitId,
    releasedAtTick: world.time.fastTick,
    fromRetreat: plan.reasonFlags.includes("retreat-survivor"),
    fromReserve: plan.reasonFlags.includes("strategic-reserve"),
  });
}

function observeFrontReturns(world: WorldState): void {
  const settings = WORLD_BALANCE.war.landFront.reorganization;
  const retained: ReturnObservation[] = [];
  const unitIds = new Set(world.units.map((unit) => unit.id));
  for (const observation of world.reorganization.awaitingFrontReturn) {
    if (!unitIds.has(observation.unitId)) continue;
    if (world.frontAllocations.frontIdByUnitId.has(observation.unitId)) {
      world.reorganization.returnedToFrontCount += 1;
      if (observation.fromRetreat) {
        world.reorganization.retreatSurvivorsReturnedCount += 1;
      }
      if (observation.fromReserve) {
        world.reorganization.reserveSurvivorsReturnedCount += 1;
      }
      world.instrumentation?.incrementCounter("reorganization.returnedToFront");
      world.reorganization.timeline.push({
        tick: world.time.fastTick,
        planId: observation.planId,
        nationId: observation.nationId,
        unitId: observation.unitId,
        type: "returned",
        phase: "ready",
        detail: "front-allocation",
      });
      continue;
    }
    if (world.strategicReserves.reserveNationByUnitId.has(observation.unitId)) {
      world.reorganization.returnedToReserveCount += 1;
      if (observation.fromRetreat) {
        world.reorganization.retreatSurvivorsReturnedCount += 1;
      }
      if (observation.fromReserve) {
        world.reorganization.reserveSurvivorsReturnedCount += 1;
      }
      world.instrumentation?.incrementCounter("reorganization.returnedToReserve");
      world.reorganization.timeline.push({
        tick: world.time.fastTick,
        planId: observation.planId,
        nationId: observation.nationId,
        unitId: observation.unitId,
        type: "returned",
        phase: "ready",
        detail: "strategic-reserve",
      });
      continue;
    }
    if (
      world.time.fastTick - observation.releasedAtTick <=
      settings.returnObservationTicks
    ) {
      retained.push(observation);
    }
  }
  world.reorganization.awaitingFrontReturn = retained;
}

function completePlan(
  world: WorldState,
  plan: ReorganizationPlan,
  destination: "front" | "reserve",
): void {
  plan.outcome =
    destination === "reserve" ? "returned-to-reserve" : "returned-to-front";
  plan.completedAtTick = world.time.fastTick;
  const duration = Math.max(0, world.time.fastTick - plan.startedAtTick);
  world.reorganization.completedCount += 1;
  world.reorganization.totalDurationTicks += duration;
  world.instrumentation?.incrementCounter("reorganization.completed");
  world.instrumentation?.incrementCounter("reorganization.durationTicks", duration);
  recordEvent(world, plan, "ready", destination);
  archivePlan(world, plan);
}

function completeEmergencyDeployment(
  world: WorldState,
  plan: ReorganizationPlan,
): void {
  plan.outcome = "emergency-deployed";
  plan.completedAtTick = world.time.fastTick;
  const duration = Math.max(0, world.time.fastTick - plan.startedAtTick);
  world.reorganization.completedCount += 1;
  world.reorganization.emergencyEarlyDeploymentCount += 1;
  world.reorganization.totalDurationTicks += duration;
  world.instrumentation?.incrementCounter("reorganization.completed");
  world.instrumentation?.incrementCounter("reorganization.durationTicks", duration);
  world.instrumentation?.incrementCounter("reorganization.emergencyDeployments");
  recordEvent(world, plan, "returned", "capital-emergency-early-deployment");
  archivePlan(world, plan);
}

function interruptOrCancelPlan(
  world: WorldState,
  plan: ReorganizationPlan,
  unit: UnitState,
  replacement: MesoRegionId | undefined,
): void {
  plan.interruptionCount += 1;
  world.reorganization.interruptedCount += 1;
  world.instrumentation?.incrementCounter("reorganization.interrupted");
  if (!replacement) {
    cancelPlan(world, plan, "no-safe-rear-area");
    return;
  }
  const previous = plan.locationRegionId;
  plan.locationRegionId = replacement;
  plan.targetTerritoryVersion = world.territoryVersion;
  plan.targetOccupationVersion = world.occupation.version;
  plan.targetFrontVersion = world.landFronts.version;
  plan.phase = unit.regionId === replacement ? "reorganizing" : "moving-to-rear";
  plan.phaseStartedAtTick = world.time.fastTick;
  clearMovement(unit);
  recordEvent(world, plan, "interrupted", `${previous}->${replacement}`);
}

function cancelPlan(
  world: WorldState,
  plan: ReorganizationPlan,
  reason: string,
): void {
  plan.outcome = "cancelled";
  plan.completedAtTick = world.time.fastTick;
  world.reorganization.cancelledCount += 1;
  world.instrumentation?.incrementCounter("reorganization.cancelled");
  recordEvent(world, plan, "cancelled", reason);
  archivePlan(world, plan);
}

function archivePlan(world: WorldState, plan: ReorganizationPlan): void {
  world.reorganization.history.push({
    ...plan,
    reasonFlags: [...plan.reasonFlags],
    equipmentTargetRatioByKey: new Map(plan.equipmentTargetRatioByKey),
    equipmentReinforcedByKey: new Map(plan.equipmentReinforcedByKey),
  });
}

function observeUnitLifetimes(world: WorldState): void {
  const state = world.reorganization;
  const current = new Set(world.units.map((unit) => unit.id));
  const initialUnitCount = world.nations.reduce(
    (total, nation) => total + nation.initialUnitCount,
    0,
  );
  for (const unit of world.units) {
    if (!state.observedUnitBirthTickById.has(unit.id)) {
      const numericId = Number(unit.id.slice("unit-".length));
      const existedAtStart =
        Number.isInteger(numericId) && numericId >= 0 && numericId < initialUnitCount;
      state.observedUnitBirthTickById.set(
        unit.id,
        existedAtStart ? 0 : world.time.fastTick,
      );
    }
  }
  for (const [unitId, birthTick] of state.observedUnitBirthTickById) {
    if (current.has(unitId)) continue;
    state.destroyedUnitCount += 1;
    state.destroyedUnitLifetimeTicks += Math.max(0, world.time.fastTick - birthTick);
    state.observedUnitBirthTickById.delete(unitId);
  }
}

function observeNationLifecycles(world: WorldState): void {
  const state = world.reorganization;
  const current = new Set(
    world.nations.filter(isNationActive).map((nation) => nation.id),
  );
  if (state.observedActiveNationIds.size > 0) {
    for (const nationId of state.observedActiveNationIds) {
      if (current.has(nationId)) continue;
      state.nationEliminationCount += 1;
      if (state.firstNationEliminationTick === null) {
        state.firstNationEliminationTick = world.time.fastTick;
      }
    }
  }
  state.observedActiveNationIds = current;
}

function isUnitReady(unit: UnitState): boolean {
  const settings = WORLD_BALANCE.war.landFront.reorganization;
  return (
    unit.org >= settings.readyOrganizationRatio &&
    getUnitManpowerRatio(unit) >= settings.readyManpowerRatio &&
    getUnitEquipmentFulfillment(unit) >= settings.readyEquipmentRatio
  );
}

function isValidPlanUnit(
  unit: UnitState | undefined,
  nationId: NationId,
): unit is UnitState {
  return (
    !!unit &&
    unit.domain === "land" &&
    unit.nationId === nationId &&
    unit.manpower > 0 &&
    Number.isFinite(unit.org) &&
    unit.org > 0
  );
}

function isUnitInActiveBattle(world: WorldState, unit: UnitState): boolean {
  return world.battles.some(
    (battle) =>
      battle.mesoId === unit.regionId &&
      (battle.attackerNationId === unit.nationId ||
        battle.defenderNationId === unit.nationId),
  );
}

function isCapitalDefenseRelated(world: WorldState, unit: UnitState): boolean {
  const assessment = getCapitalDefenseAssessment(world, unit.nationId);
  if (!assessment || assessment.threatLevel === "none") return false;
  if (assessment.defenseRegionIds.includes(unit.regionId)) return true;
  const frontId = world.frontAllocations.frontIdByUnitId.get(unit.id);
  return !!frontId && assessment.threatenedFrontIds.includes(frontId);
}

function getFacilityMultiplier(
  world: WorldState,
  regionId: MesoRegionId,
): number {
  const building = getMesoById(world).get(regionId)?.building;
  const settings = WORLD_BALANCE.war.landFront.reorganization;
  return building === "capital"
    ? settings.capitalRecoveryMultiplier
    : building === "city"
      ? settings.cityRecoveryMultiplier
      : 1;
}

function getMaximumManpower(unit: UnitState): number {
  return finiteNumber(WORLD_BALANCE.unit.types[unit.type].manpower ?? 0);
}

function getMaximumEquipmentStock(unit: UnitState): number {
  return finiteNumber(WORLD_BALANCE.unit.types[unit.type].weaponCost ?? 0);
}

function combatReadinessRatio(unit: UnitState): number {
  return Math.min(
    clamp(finiteNumber(unit.org), 0, 1),
    getUnitManpowerRatio(unit),
    getUnitEquipmentFulfillment(unit),
  );
}

function effectiveController(
  regionId: MesoRegionId,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  occupationByMesoId: Map<MesoRegionId, NationId>,
): NationId | undefined {
  return occupationByMesoId.get(regionId) ?? ownerByMesoId.get(regionId);
}

function rebuildIndexes(state: ReorganizationState): void {
  state.plans.sort(comparePlans);
  state.plansById = new Map(state.plans.map((plan) => [plan.id, plan]));
  state.planIdByUnitId = new Map(
    state.plans.map((plan) => [plan.unitId, plan.id]),
  );
  state.plansByNationId = new Map();
  for (const plan of state.plans) {
    const list = state.plansByNationId.get(plan.nationId);
    if (list) list.push(plan);
    else state.plansByNationId.set(plan.nationId, [plan]);
  }
}

function recordEvent(
  world: WorldState,
  plan: ReorganizationPlan,
  type: ReorganizationEventType,
  detail: string,
): void {
  world.reorganization.timeline.push({
    tick: world.time.fastTick,
    planId: plan.id,
    nationId: plan.nationId,
    unitId: plan.unitId,
    type,
    phase: plan.phase,
    detail,
  });
}

function trimHistoryAndTimeline(state: ReorganizationState): void {
  const settings = WORLD_BALANCE.war.landFront.reorganization;
  if (state.history.length > settings.historyLimit) {
    state.history.splice(0, state.history.length - settings.historyLimit);
  }
  if (state.timeline.length > settings.timelineLimit) {
    state.timeline.splice(0, state.timeline.length - settings.timelineLimit);
  }
}

function recordEvaluationDuration(world: WorldState, startedAt: number): void {
  if (world.instrumentation) {
    world.instrumentation.recordDuration(
      "reorganization.evaluation",
      performance.now() - startedAt,
    );
  }
}

function clearMovement(unit: UnitState): void {
  unit.moveTargetId = null;
  unit.moveFromId = null;
  unit.moveToId = null;
  unit.moveProgressMs = 0;
}

function assignmentMapsEqual<K, V>(a: Map<K, V>, b: Map<K, V>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

function distanceSquared(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
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

function comparePlans(a: ReorganizationPlan, b: ReorganizationPlan): number {
  return compareIds(a.nationId, b.nationId) || compareIds(a.id, b.id);
}

function comparePlanRecoveryPriority(
  a: ReorganizationPlan,
  b: ReorganizationPlan,
): number {
  return (
    planPriority(b) - planPriority(a) ||
    compareIds(a.nationId, b.nationId) ||
    compareIds(a.id, b.id)
  );
}

function planPriority(plan: ReorganizationPlan): number {
  if (plan.reasonFlags.includes("capital-defense")) return 5;
  if (plan.reasonFlags.includes("strategic-reserve")) return 4;
  if (plan.reasonFlags.includes("retreat-survivor")) return 3;
  if (plan.reasonFlags.includes("offensive-operation")) return 2;
  return 1;
}

function compareCandidateUnits(
  world: WorldState,
  sources: RecentSourceReasons,
  a: UnitState,
  b: UnitState,
): number {
  return (
    candidatePriority(world, sources, b) - candidatePriority(world, sources, a) ||
    combatReadinessRatio(a) - combatReadinessRatio(b) ||
    compareIds(a.id, b.id)
  );
}

function candidatePriority(
  world: WorldState,
  sources: RecentSourceReasons,
  unit: UnitState,
): number {
  if (isCapitalDefenseRelated(world, unit)) return 500;
  if (world.strategicReserves.reserveNationByUnitId.has(unit.id)) return 400;
  if (sources.retreatUnitIds.has(unit.id)) return 300;
  if (sources.operationUnitIds.has(unit.id)) return 200;
  return unit.type === "Tank" ? 101 : 100;
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
