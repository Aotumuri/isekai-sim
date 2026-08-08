import { WORLD_BALANCE } from "../data/balance";
import type { NationId } from "../worldgen/nation";
import {
  getCapitalDefenseAssessment,
  type CapitalThreatLevel,
} from "./capital-defense";
import {
  getFrontSide,
  getOpposingFrontSide,
  type FrontId,
  type OperationalSector,
  type PhysicalFrontSide,
} from "./land-fronts";
import { getFrontAllocation } from "./nation-front-allocations";
import type { WorldState } from "./world-state";

export type FrontPosture = "attack" | "hold" | "reinforce" | "retreat";

export type FrontPlanReason =
  | "strength-superiority"
  | "forces-balanced"
  | "strength-disadvantage"
  | "capital-threatened"
  | "cities-threatened"
  | "enemy-capital-nearby"
  | "enemy-cities-nearby"
  | "low-strategic-value"
  | "posture-maintained";

/** Nation-owned intent. Objective geometry and metrics remain on PhysicalFront. */
export interface NationFrontPlan {
  /** Operational-sector identifier. Kept as frontId for API compatibility. */
  frontId: FrontId;
  physicalFrontId: FrontId;
  nationId: NationId;
  posture: FrontPosture;
  /** 0-100 allocation priority; 100 is most urgent or valuable. */
  priority: number;
  /** Combat-strength units, using the same scale as PhysicalFrontSide.strength. */
  desiredStrength: number;
  reasonFlags: FrontPlanReason[];
  evaluatedAtTick: number;
}

/** Preferred name for the post-sector hierarchy. */
export type NationSectorPlan = NationFrontPlan;

export interface NationFrontPlanState {
  plans: NationFrontPlan[];
  plansByNationId: Map<NationId, NationFrontPlan[]>;
  plansByFrontNation: Map<string, NationFrontPlan>;
  version: number;
  physicalFrontVersion: number;
  physicalFrontMetricsVersion: number;
  capitalDefenseVersion: number;
}

export function createNationFrontPlanState(): NationFrontPlanState {
  return {
    plans: [],
    plansByNationId: new Map(),
    plansByFrontNation: new Map(),
    version: 0,
    physicalFrontVersion: -1,
    physicalFrontMetricsVersion: -1,
    capitalDefenseVersion: -1,
  };
}

export function updateNationFrontPlans(world: WorldState): void {
  const state = world.frontPlans;
  if (
    state.physicalFrontVersion === world.landFronts.version &&
    state.physicalFrontMetricsVersion === world.landFronts.metricsVersion &&
    state.capitalDefenseVersion === world.capitalDefense.version
  ) {
    return;
  }

  const startedAt = world.instrumentation ? performance.now() : 0;
  const previousPlans = state.plansByFrontNation;
  const plans: NationFrontPlan[] = [];
  for (const front of world.landFronts.operationalSectors) {
    plans.push(
      evaluateNationFrontPlan(
        world,
        front,
        front.nationAId,
        previousPlans.get(createPlanKey(front.id, front.nationAId)),
        world.time.fastTick,
      ),
      evaluateNationFrontPlan(
        world,
        front,
        front.nationBId,
        previousPlans.get(createPlanKey(front.id, front.nationBId)),
        world.time.fastTick,
      ),
    );
  }
  plans.sort(comparePlans);

  state.plans = plans;
  state.plansByNationId = indexPlansByNation(plans);
  state.plansByFrontNation = new Map(
    plans.map((plan) => [createPlanKey(plan.frontId, plan.nationId), plan]),
  );
  state.version += 1;
  state.physicalFrontVersion = world.landFronts.version;
  state.physicalFrontMetricsVersion = world.landFronts.metricsVersion;
  state.capitalDefenseVersion = world.capitalDefense.version;

  if (world.instrumentation) {
    world.instrumentation.recordDuration(
      "landFront.planEvaluation",
      performance.now() - startedAt,
    );
    world.instrumentation.incrementCounter("landFront.planUpdates");
    world.instrumentation.incrementCounter("landFront.plansEvaluated", plans.length);
  }
}

export function getNationFrontPlans(
  world: WorldState,
  nationId?: NationId,
): readonly NationFrontPlan[] {
  return nationId === undefined
    ? world.frontPlans.plans
    : (world.frontPlans.plansByNationId.get(nationId) ?? []);
}

export function getNationSectorPlans(
  world: WorldState,
  nationId?: NationId,
): readonly NationSectorPlan[] {
  return getNationFrontPlans(world, nationId);
}

export function getFrontPlan(
  world: WorldState,
  frontId: FrontId,
  nationId: NationId,
): NationFrontPlan | undefined {
  const exact = world.frontPlans.plansByFrontNation.get(
    createPlanKey(frontId, nationId),
  );
  if (exact) return exact;
  return (world.landFronts.operationalSectorsByFrontId.get(frontId) ?? [])
    .map((sector) =>
      world.frontPlans.plansByFrontNation.get(createPlanKey(sector.id, nationId)),
    )
    .filter((plan): plan is NationFrontPlan => !!plan)
    .sort((a, b) => b.priority - a.priority || compareIds(a.frontId, b.frontId))[0];
}

export function getSectorPlan(
  world: WorldState,
  sectorId: FrontId,
  nationId: NationId,
): NationSectorPlan | undefined {
  return world.frontPlans.plansByFrontNation.get(createPlanKey(sectorId, nationId));
}

export function formatNationFrontPlanSummary(world: WorldState): string {
  const lines: string[] = [];
  for (const plan of world.frontPlans.plans) {
    const front = world.landFronts.operationalSectorsById.get(plan.frontId);
    if (!front) {
      continue;
    }
    const friendly = getFrontSide(front, plan.nationId);
    const enemy = getOpposingFrontSide(front, plan.nationId);
    if (!friendly || !enemy) {
      continue;
    }
    const allocation = getFrontAllocation(world, plan.frontId, plan.nationId);
    lines.push(
      `${plan.nationId} vs ${enemy.nationId}`,
      `Front: ${front.id}`,
      `strength: ${friendly.strength.toFixed(1)} vs ${enemy.strength.toFixed(1)}`,
      `ratio: ${getStrengthRatio(friendly.strength, enemy.strength).toFixed(2)}`,
      `posture: ${plan.posture}`,
      `priority: ${plan.priority.toFixed(1)}`,
      `desiredStrength: ${plan.desiredStrength.toFixed(1)}`,
      `reasons: ${plan.reasonFlags.join(", ")}`,
    );
    if (allocation) {
      lines.push(
        "allocation:",
        `  units: ${allocation.unitIds.length}`,
        `  strength: ${allocation.allocatedStrength.toFixed(1)}`,
        `  deficit: ${allocation.deficit.toFixed(1)}`,
        `  surplus: ${allocation.surplus.toFixed(1)}`,
      );
    }
  }
  return lines.join("\n");
}

function evaluateNationFrontPlan(
  world: WorldState,
  front: OperationalSector,
  nationId: NationId,
  previousPlan: NationFrontPlan | undefined,
  currentTick: number,
): NationFrontPlan {
  const friendly = getFrontSide(front, nationId);
  const enemy = getOpposingFrontSide(front, nationId);
  if (!friendly || !enemy) {
    throw new Error(`${nationId} is not a side of ${front.id}`);
  }

  const ratio = getStrengthRatio(friendly.strength, enemy.strength);
  const capitalDefense = getCapitalDefenseAssessment(world, nationId);
  const isCapitalDefenseFront =
    !!capitalDefense &&
    capitalDefense.threatLevel !== "none" &&
    capitalDefense.threatenedFrontIds.includes(front.id);
  const capitalThreatLevel = isCapitalDefenseFront
    ? capitalDefense?.threatLevel ?? "none"
    : "none";
  const basePosture = selectBasePosture(
    friendly,
    enemy,
    ratio,
    capitalThreatLevel,
  );
  const posture = stabilizePosture(
    basePosture,
    previousPlan?.posture,
    friendly,
    enemy,
    ratio,
    isCapitalDefenseFront,
  );
  const reasonFlags = collectReasonFlags(
    friendly,
    enemy,
    ratio,
    posture !== basePosture,
    isCapitalDefenseFront,
  );
  const priority = calculatePriority(
    friendly,
    enemy,
    ratio,
    posture,
    reasonFlags,
  );
  return {
    frontId: front.id,
    physicalFrontId: front.physicalFrontId,
    nationId,
    posture,
    priority: applyCapitalPriority(priority, capitalThreatLevel),
    desiredStrength: calculateDesiredStrength(
      friendly,
      enemy,
      posture,
      capitalDefense,
      front.id,
      isCapitalDefenseFront,
    ),
    reasonFlags,
    evaluatedAtTick: currentTick,
  };
}

function selectBasePosture(
  friendly: PhysicalFrontSide,
  enemy: PhysicalFrontSide,
  ratio: number,
  capitalThreatLevel: CapitalThreatLevel,
): FrontPosture {
  const settings = WORLD_BALANCE.war.landFront.plan;
  const capitalSettings = WORLD_BALANCE.war.landFront.capitalDefense;
  if (enemy.strength <= 0) {
    return friendly.strength > 0 ? "attack" : "hold";
  }
  if (ratio >= settings.attackEnterRatio) {
    return "attack";
  }
  if (
    ratio >= settings.attackOpportunityRatio &&
    (enemy.hasNearbyCapital || enemy.nearbyCityCount > 0)
  ) {
    return "attack";
  }
  if (ratio >= settings.reinforceEnterRatio) {
    return "hold";
  }
  if (ratio >= settings.retreatEnterRatio) {
    return "reinforce";
  }
  if (
    capitalThreatLevel === "critical" &&
    ratio > capitalSettings.criticalRetreatBelowRatio
  ) {
    return "reinforce";
  }
  if (
    capitalThreatLevel === "threatened" &&
    ratio >= capitalSettings.threatenedRetreatBelowRatio
  ) {
    return "reinforce";
  }
  if (
    ratio >= settings.capitalRetreatFloorRatio &&
    (friendly.hasNearbyCapital || friendly.nearbyCityCount > 0)
  ) {
    return "reinforce";
  }
  return "retreat";
}

function stabilizePosture(
  candidate: FrontPosture,
  previous: FrontPosture | undefined,
  friendly: PhysicalFrontSide,
  enemy: PhysicalFrontSide,
  ratio: number,
  isCapitalDefenseFront: boolean,
): FrontPosture {
  if (!previous || previous === candidate || enemy.strength <= 0) {
    return candidate;
  }
  const settings = WORLD_BALANCE.war.landFront.plan;
  if (previous === "attack" && candidate === "hold") {
    return ratio >= settings.attackContinueRatio ? "attack" : candidate;
  }
  if (previous === "reinforce" && candidate === "hold") {
    return ratio < settings.reinforceContinueRatio ? "reinforce" : candidate;
  }
  if (
    previous === "retreat" &&
    candidate === "reinforce" &&
    !isCapitalDefenseFront &&
    !friendly.hasNearbyCapital &&
    friendly.nearbyCityCount === 0
  ) {
    return ratio < settings.retreatContinueRatio ? "retreat" : candidate;
  }
  return candidate;
}

function collectReasonFlags(
  friendly: PhysicalFrontSide,
  enemy: PhysicalFrontSide,
  ratio: number,
  postureMaintained: boolean,
  isCapitalDefenseFront: boolean,
): FrontPlanReason[] {
  const reasons: FrontPlanReason[] = [];
  if (enemy.strength <= 0 && friendly.strength > 0) {
    reasons.push("strength-superiority");
  } else if (ratio >= 1.25) {
    reasons.push("strength-superiority");
  } else if (enemy.strength > 0 && ratio < 0.8) {
    reasons.push("strength-disadvantage");
  } else {
    reasons.push("forces-balanced");
  }
  if ((friendly.hasNearbyCapital || isCapitalDefenseFront) && enemy.strength > 0) {
    reasons.push("capital-threatened");
  }
  if (friendly.nearbyCityCount > 0 && enemy.strength > 0) {
    reasons.push("cities-threatened");
  }
  if (enemy.hasNearbyCapital) {
    reasons.push("enemy-capital-nearby");
  }
  if (enemy.nearbyCityCount > 0) {
    reasons.push("enemy-cities-nearby");
  }
  if (
    friendly.strength + enemy.strength < 1 &&
    !friendly.hasNearbyCapital &&
    friendly.nearbyCityCount === 0 &&
    !enemy.hasNearbyCapital &&
    enemy.nearbyCityCount === 0
  ) {
    reasons.push("low-strategic-value");
  }
  if (postureMaintained) {
    reasons.push("posture-maintained");
  }
  return reasons;
}

function calculatePriority(
  friendly: PhysicalFrontSide,
  enemy: PhysicalFrontSide,
  ratio: number,
  posture: FrontPosture,
  reasons: FrontPlanReason[],
): number {
  if (reasons.includes("low-strategic-value")) {
    return 5;
  }
  const totalStrength = friendly.strength + enemy.strength;
  const enemyThreatShare =
    totalStrength > 0 ? enemy.strength / totalStrength : 0;
  const strengthImbalance =
    totalStrength > 0
      ? Math.abs(friendly.strength - enemy.strength) / totalStrength
      : 0;
  let priority = 10;
  if (totalStrength > 0) {
    priority += 10;
  }
  priority += enemyThreatShare * 20;
  priority += strengthImbalance * 10;
  if (friendly.hasNearbyCapital) {
    priority += 25;
  }
  priority += Math.min(15, friendly.nearbyCityCount * 5);
  if (enemy.hasNearbyCapital) {
    priority += ratio >= 1 ? 15 : 7;
  }
  priority += Math.min(
    12,
    enemy.nearbyCityCount * (ratio >= 1 ? 4 : 2),
  );
  if (posture === "reinforce") {
    priority += 8;
  } else if (posture === "retreat") {
    priority += 6;
  } else if (posture === "attack") {
    priority += 4;
  }
  return roundTo(clamp(priority, 0, 100), 2);
}

function calculateDesiredStrength(
  friendly: PhysicalFrontSide,
  enemy: PhysicalFrontSide,
  posture: FrontPosture,
  capitalDefense: ReturnType<typeof getCapitalDefenseAssessment>,
  frontId: FrontId,
  isCapitalDefenseFront: boolean,
): number {
  const multipliers = WORLD_BALANCE.war.landFront.plan.desiredStrengthMultiplier;
  let multiplier: number = multipliers[posture];
  // Retreat desired strength is a covering/rearguard force. Strategic-site
  // minimums apply only while the plan still intends to contest the front.
  if (posture !== "retreat") {
    if (friendly.hasNearbyCapital) {
      multiplier = Math.max(multiplier, 1.35);
    }
    multiplier += Math.min(0.2, friendly.nearbyCityCount * 0.05);
  }
  if (posture === "attack" && enemy.hasNearbyCapital) {
    multiplier += 0.15;
  }
  if (posture === "attack") {
    multiplier += Math.min(0.15, enemy.nearbyCityCount * 0.03);
  }

  let desiredStrength = enemy.strength * multiplier;
  if (enemy.strength <= 0 && posture === "attack") {
    desiredStrength = friendly.strength * 0.6;
  }
  if (isCapitalDefenseFront && capitalDefense) {
    const capitalSettings = WORLD_BALANCE.war.landFront.capitalDefense;
    desiredStrength = Math.max(
      desiredStrength,
      enemy.strength * capitalSettings.enemyStrengthMultiplier,
    );
    if (capitalDefense.primaryFrontId === frontId) {
      desiredStrength = Math.max(
        desiredStrength,
        capitalDefense.minimumDefenseStrength,
      );
    }
  }
  return Number.isFinite(desiredStrength)
    ? roundTo(Math.max(0, desiredStrength), 2)
    : 0;
}

function applyCapitalPriority(
  priority: number,
  threatLevel: CapitalThreatLevel,
): number {
  if (threatLevel === "none") return priority;
  const settings = WORLD_BALANCE.war.landFront.capitalDefense;
  const raised = priority + settings.priorityBonus;
  return roundTo(
    clamp(
      threatLevel === "critical"
        ? Math.max(raised, settings.criticalPriorityFloor)
        : raised,
      0,
      100,
    ),
    2,
  );
}

export function getStrengthRatio(friendlyStrength: number, enemyStrength: number): number {
  const ratio = friendlyStrength / Math.max(1, enemyStrength);
  return Number.isFinite(ratio) ? Math.max(0, ratio) : 0;
}

function indexPlansByNation(
  plans: NationFrontPlan[],
): Map<NationId, NationFrontPlan[]> {
  const result = new Map<NationId, NationFrontPlan[]>();
  for (const plan of plans) {
    const list = result.get(plan.nationId);
    if (list) {
      list.push(plan);
    } else {
      result.set(plan.nationId, [plan]);
    }
  }
  return result;
}

function createPlanKey(frontId: FrontId, nationId: NationId): string {
  return `${frontId}::${nationId}`;
}

function comparePlans(a: NationFrontPlan, b: NationFrontPlan): number {
  const frontCompare = compareIds(a.frontId, b.frontId);
  return frontCompare !== 0 ? frontCompare : compareIds(a.nationId, b.nationId);
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
