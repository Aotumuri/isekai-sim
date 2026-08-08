import { WORLD_BALANCE } from "../data/balance";
import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import { getFrontDistanceField } from "./ai-geography";
import {
  getCapitalDefenseAssessment,
  recordCapitalDefenseReallocation,
} from "./capital-defense";
import {
  getFrontSide,
  getOpposingFrontSide,
  type FrontId,
  type OperationalSector,
  type PhysicalFrontSide,
} from "./land-fronts";
import type { FrontPosture, NationFrontPlan } from "./nation-front-plans";
import { isNationActive } from "./nation-active";
import type { UnitId, UnitState } from "./unit";
import { getUnitCombatStrength } from "./unit-strength";
import type { WorldState } from "./world-state";

export interface NationFrontAllocation {
  nationId: NationId;
  frontId: FrontId;
  unitIds: UnitId[];
  allocatedStrength: number;
  desiredStrength: number;
  deficit: number;
  surplus: number;
  priority: number;
  posture: FrontPosture;
}

export interface NationFrontAllocationState {
  allocations: NationFrontAllocation[];
  allocationsByNationId: Map<NationId, NationFrontAllocation[]>;
  allocationsByFrontNation: Map<string, NationFrontAllocation>;
  frontIdByUnitId: Map<UnitId, FrontId>;
  unassignedUnitIdsByNationId: Map<NationId, UnitId[]>;
  version: number;
  membershipVersion: number;
  sourcePlanVersion: number;
  sourceRetreatMembershipVersion: number;
  sourceReserveMembershipVersion: number;
  sourceReorganizationMembershipVersion: number;
  unitsReference: UnitState[] | null;
  unitIdCounter: number;
  landUnitCount: number;
  lastUnitSwitchCount: number;
  lastFrontTransferCount: number;
  lastUnassignedUnitCount: number;
  frontGeometryById: Map<FrontId, FrontGeometrySnapshot>;
}

interface FrontGeometrySnapshot {
  nationAId: NationId;
  nationBId: NationId;
  regionIds: Set<MesoRegionId>;
}

interface FrontAllocationContext {
  plan: NationFrontPlan;
  front: OperationalSector;
  friendlySide: PhysicalFrontSide;
  distanceByRegionId: Map<MesoRegionId, number>;
}

interface MutableAllocation {
  context: FrontAllocationContext;
  units: UnitState[];
  allocatedStrength: number;
}

export function createNationFrontAllocationState(): NationFrontAllocationState {
  return {
    allocations: [],
    allocationsByNationId: new Map(),
    allocationsByFrontNation: new Map(),
    frontIdByUnitId: new Map(),
    unassignedUnitIdsByNationId: new Map(),
    version: 0,
    membershipVersion: 0,
    sourcePlanVersion: -1,
    sourceRetreatMembershipVersion: -1,
    sourceReserveMembershipVersion: -1,
    sourceReorganizationMembershipVersion: -1,
    unitsReference: null,
    unitIdCounter: -1,
    landUnitCount: -1,
    lastUnitSwitchCount: 0,
    lastFrontTransferCount: 0,
    lastUnassignedUnitCount: 0,
    frontGeometryById: new Map(),
  };
}

export function updateNationFrontAllocations(world: WorldState): void {
  const state = world.frontAllocations;
  const landUnits = world.units.filter((unit) => unit.domain === "land");
  const unitsChanged =
    state.unitsReference !== world.units ||
    state.unitIdCounter !== world.unitIdCounter ||
    state.landUnitCount !== landUnits.length;
  if (
    state.sourcePlanVersion === world.frontPlans.version &&
    state.sourceRetreatMembershipVersion === world.retreatPlans.membershipVersion &&
    state.sourceReserveMembershipVersion ===
      world.strategicReserves.membershipVersion &&
    state.sourceReorganizationMembershipVersion ===
      world.reorganization.membershipVersion &&
    !unitsChanged
  ) {
    return;
  }

  const startedAt = world.instrumentation ? performance.now() : 0;
  const currentFrontIdByPreviousFrontId = matchPreviousFrontsToCurrent(
    state.frontGeometryById,
    world,
  );
  const previousFrontIdByUnitId = remapPreviousAssignmentsToCurrentFronts(
    state.frontIdByUnitId,
    currentFrontIdByPreviousFrontId,
    false,
  );
  const previousForChangeCounting = remapPreviousAssignmentsToCurrentFronts(
    state.frontIdByUnitId,
    currentFrontIdByPreviousFrontId,
    true,
  );
  const unitsByNationId = indexLandUnitsByNation(landUnits);
  const nextFrontIdByUnitId = new Map<UnitId, FrontId>();
  const allocations: NationFrontAllocation[] = [];
  const unassignedUnitIdsByNationId = new Map<NationId, UnitId[]>();
  const activeNationIds = new Set(
    world.nations.filter(isNationActive).map((nation) => nation.id),
  );

  for (const [nationId, plans] of world.frontPlans.plansByNationId.entries()) {
    if (!activeNationIds.has(nationId)) {
      continue;
    }
    const units = (unitsByNationId.get(nationId) ?? []).filter(
      (unit) =>
        !world.retreatPlans.retreatIdByUnitId.has(unit.id) &&
        !world.strategicReserves.reserveNationByUnitId.has(unit.id) &&
        !world.reorganization.planIdByUnitId.has(unit.id),
    );
    const result = allocateNationUnits(
      world,
      nationId,
      plans,
      units,
      previousFrontIdByUnitId,
    );
    allocations.push(...result.allocations);
    for (const allocation of result.allocations) {
      for (const unitId of allocation.unitIds) {
        nextFrontIdByUnitId.set(unitId, allocation.frontId);
      }
    }
    if (result.unassignedUnitIds.length > 0) {
      unassignedUnitIdsByNationId.set(nationId, result.unassignedUnitIds);
    }
  }

  allocations.sort(compareAllocations);
  const { switchCount, frontTransferCount } = countMembershipChanges(
    previousForChangeCounting,
    nextFrontIdByUnitId,
  );
  recordCapitalDefenseReallocation(
    world,
    countCapitalDefenseReallocations(
      world,
      previousForChangeCounting,
      nextFrontIdByUnitId,
    ),
  );
  const membershipChanged = !areAssignmentMapsEqual(
    previousForChangeCounting,
    nextFrontIdByUnitId,
  );
  const unassignedUnitCount = sumMapArrayLengths(unassignedUnitIdsByNationId);

  state.allocations = allocations;
  state.allocationsByNationId = indexAllocationsByNation(allocations);
  state.allocationsByFrontNation = new Map(
    allocations.map((allocation) => [
      createAllocationKey(allocation.frontId, allocation.nationId),
      allocation,
    ]),
  );
  state.frontIdByUnitId = nextFrontIdByUnitId;
  state.unassignedUnitIdsByNationId = unassignedUnitIdsByNationId;
  state.version += 1;
  if (membershipChanged) {
    state.membershipVersion += 1;
  }
  state.sourcePlanVersion = world.frontPlans.version;
  state.sourceRetreatMembershipVersion = world.retreatPlans.membershipVersion;
  state.sourceReserveMembershipVersion =
    world.strategicReserves.membershipVersion;
  state.sourceReorganizationMembershipVersion =
    world.reorganization.membershipVersion;
  state.unitsReference = world.units;
  state.unitIdCounter = world.unitIdCounter;
  state.landUnitCount = landUnits.length;
  state.lastUnitSwitchCount = switchCount;
  state.lastFrontTransferCount = frontTransferCount;
  state.lastUnassignedUnitCount = unassignedUnitCount;
  state.frontGeometryById = captureFrontGeometry(world);

  if (world.instrumentation) {
    world.instrumentation.recordDuration(
      "landFront.allocation",
      performance.now() - startedAt,
    );
    world.instrumentation.incrementCounter("landFront.allocationRebuilds");
    world.instrumentation.incrementCounter(
      "landFront.allocationUnitSwitches",
      switchCount,
    );
    world.instrumentation.incrementCounter(
      "landFront.allocationFrontTransfers",
      frontTransferCount,
    );
    world.instrumentation.incrementCounter(
      "landFront.allocationUnassignedUnits",
      unassignedUnitCount,
    );
  }
}

/** Immediately releases a unit before Reorganization claims exclusive ownership. */
export function releaseUnitFromFrontAllocation(
  world: WorldState,
  unitId: UnitId,
): boolean {
  const state = world.frontAllocations;
  const frontId = state.frontIdByUnitId.get(unitId);
  if (!frontId) return false;
  const unit = world.units.find((candidate) => candidate.id === unitId);
  const allocation = unit
    ? state.allocationsByFrontNation.get(
        createAllocationKey(frontId, unit.nationId),
      )
    : undefined;
  if (allocation) {
    allocation.unitIds = allocation.unitIds.filter((id) => id !== unitId);
    allocation.allocatedStrength = Math.max(
      0,
      allocation.allocatedStrength - (unit ? finiteUnitStrength(unit) : 0),
    );
    allocation.deficit = Math.max(
      0,
      allocation.desiredStrength - allocation.allocatedStrength,
    );
    allocation.surplus = Math.max(
      0,
      allocation.allocatedStrength - allocation.desiredStrength,
    );
  }
  state.frontIdByUnitId.delete(unitId);
  state.membershipVersion += 1;
  state.version += 1;
  return true;
}

export function getNationFrontAllocations(
  world: WorldState,
  nationId?: NationId,
): readonly NationFrontAllocation[] {
  return nationId === undefined
    ? world.frontAllocations.allocations
    : (world.frontAllocations.allocationsByNationId.get(nationId) ?? []);
}

export function getFrontAllocation(
  world: WorldState,
  frontId: FrontId,
  nationId: NationId,
): NationFrontAllocation | undefined {
  return world.frontAllocations.allocationsByFrontNation.get(
    createAllocationKey(frontId, nationId),
  );
}

export function getAllocatedFrontId(
  world: WorldState,
  unitId: UnitId,
): FrontId | undefined {
  return world.frontAllocations.frontIdByUnitId.get(unitId);
}

export function getUnassignedLandUnitIds(
  world: WorldState,
  nationId: NationId,
): readonly UnitId[] {
  return world.frontAllocations.unassignedUnitIdsByNationId.get(nationId) ?? [];
}

export function formatNationFrontAllocationSummary(world: WorldState): string {
  const lines: string[] = [];
  const nationIds = [...world.frontAllocations.allocationsByNationId.keys()].sort(
    compareIds,
  );
  for (const nationId of nationIds) {
    lines.push(`Nation ${nationId}`);
    for (const allocation of getNationFrontAllocations(world, nationId)) {
      lines.push(
        `  Front ${allocation.frontId}`,
        `    posture: ${allocation.posture}`,
        `    priority: ${allocation.priority.toFixed(1)}`,
        `    units: ${allocation.unitIds.length}`,
        `    strength: ${allocation.allocatedStrength.toFixed(1)}`,
        `    desired: ${allocation.desiredStrength.toFixed(1)}`,
        `    deficit: ${allocation.deficit.toFixed(1)}`,
        `    surplus: ${allocation.surplus.toFixed(1)}`,
      );
    }
    lines.push(
      `  unassigned: ${getUnassignedLandUnitIds(world, nationId).length}`,
    );
  }
  return lines.join("\n");
}

function allocateNationUnits(
  world: WorldState,
  nationId: NationId,
  plans: NationFrontPlan[],
  units: UnitState[],
  previousFrontIdByUnitId: Map<UnitId, FrontId>,
): { allocations: NationFrontAllocation[]; unassignedUnitIds: UnitId[] } {
  const contexts = createAllocationContexts(world, nationId, plans);
  if (contexts.length === 0) {
    return { allocations: [], unassignedUnitIds: [] };
  }
  contexts.sort(compareAllocationContexts);
  const mutableByFrontId = new Map<FrontId, MutableAllocation>();
  for (const context of contexts) {
    mutableByFrontId.set(context.front.id, {
      context,
      units: [],
      allocatedStrength: 0,
    });
  }

  const unitStrengthById = new Map<UnitId, number>();
  for (const unit of units) {
    unitStrengthById.set(unit.id, finiteUnitStrength(unit));
  }
  const pool = [...units].sort(compareUnits);
  const settings = WORLD_BALANCE.war.landFront.allocation;
  const capitalDefense = getCapitalDefenseAssessment(world, nationId);
  const criticalCapitalFrontIds =
    capitalDefense?.threatLevel === "critical" &&
    capitalDefense.threatenedFrontIds.length > 0
      ? new Set(capitalDefense.threatenedFrontIds)
      : null;

  // Coverage pass prevents low-priority fronts from being completely starved.
  for (const context of contexts) {
    const minimumUnits = criticalCapitalFrontIds?.has(context.front.id)
      ? settings.minimumUnitsPerFront
      : criticalCapitalFrontIds
        ? 0
        : context.plan.posture === "retreat"
          ? settings.retreatMinimumUnits
          : settings.minimumUnitsPerFront;
    const mutable = mutableByFrontId.get(context.front.id);
    if (!mutable) {
      continue;
    }
    while (mutable.units.length < minimumUnits && pool.length > 0) {
      if (
        !assignBestUnit(
          pool,
          mutable,
          previousFrontIdByUnitId,
          unitStrengthById,
          Math.max(1, context.plan.desiredStrength - mutable.allocatedStrength),
        )
      ) {
        break;
      }
    }
  }

  // Desired-strength pass. Recompute urgency after each unit so two similarly
  // important fronts share a limited army instead of the first consuming it all.
  const unreachableFrontIds = new Set<FrontId>();
  while (pool.length > 0) {
    const mutable = selectMostUrgentDeficitAllocation(
      contexts,
      mutableByFrontId,
      unreachableFrontIds,
    );
    if (!mutable) {
      break;
    }
    if (
      !assignBestUnit(
        pool,
        mutable,
        previousFrontIdByUnitId,
        unitStrengthById,
        mutable.context.plan.desiredStrength - mutable.allocatedStrength,
      )
    ) {
      unreachableFrontIds.add(mutable.context.front.id);
    }
  }

  // Surplus land units remain useful: distribute them across non-retreat fronts
  // using priority, current load, distance, and a penalty for changing fronts.
  const surplusContexts = contexts.filter(
    (context) => context.plan.posture !== "retreat",
  );
  const unreachableSurplusUnits: UnitState[] = [];
  while (pool.length > 0 && surplusContexts.length > 0) {
    const unit = pool.shift();
    if (!unit) {
      break;
    }
    const context = selectSurplusFront(
      unit,
      surplusContexts,
      mutableByFrontId,
      previousFrontIdByUnitId,
    );
    if (!context) {
      unreachableSurplusUnits.push(unit);
      continue;
    }
    const mutable = mutableByFrontId.get(context.front.id);
    if (!mutable) {
      continue;
    }
    mutable.units.push(unit);
    mutable.allocatedStrength += unitStrengthById.get(unit.id) ?? 0;
  }
  pool.push(...unreachableSurplusUnits);

  const allocations = contexts.map((context) => {
    const mutable = mutableByFrontId.get(context.front.id);
    const allocatedStrength = finiteNumber(mutable?.allocatedStrength ?? 0);
    const desiredStrength = finiteNumber(context.plan.desiredStrength);
    return {
      nationId,
      frontId: context.front.id,
      unitIds: (mutable?.units ?? []).map((unit) => unit.id).sort(compareIds),
      allocatedStrength,
      desiredStrength,
      deficit: Math.max(0, desiredStrength - allocatedStrength),
      surplus: Math.max(0, allocatedStrength - desiredStrength),
      priority: finiteNumber(context.plan.priority),
      posture: context.plan.posture,
    } satisfies NationFrontAllocation;
  });

  return {
    allocations,
    unassignedUnitIds: pool.map((unit) => unit.id).sort(compareIds),
  };
}

function countCapitalDefenseReallocations(
  world: WorldState,
  previousFrontIdByUnitId: Map<UnitId, FrontId>,
  nextFrontIdByUnitId: Map<UnitId, FrontId>,
): number {
  const unitById = new Map(world.units.map((unit) => [unit.id, unit]));
  let count = 0;
  for (const [unitId, nextFrontId] of nextFrontIdByUnitId) {
    const previousFrontId = previousFrontIdByUnitId.get(unitId);
    if (!previousFrontId || previousFrontId === nextFrontId) continue;
    const unit = unitById.get(unitId);
    if (!unit || unit.domain !== "land") continue;
    const assessment = getCapitalDefenseAssessment(world, unit.nationId);
    if (
      !assessment ||
      assessment.threatLevel === "none" ||
      !assessment.threatenedFrontIds.includes(nextFrontId) ||
      assessment.threatenedFrontIds.includes(previousFrontId)
    ) {
      continue;
    }
    count += 1;
  }
  return count;
}

function createAllocationContexts(
  world: WorldState,
  nationId: NationId,
  plans: NationFrontPlan[],
): FrontAllocationContext[] {
  const contexts: FrontAllocationContext[] = [];
  for (const plan of plans) {
    const front = world.landFronts.operationalSectorsById.get(plan.frontId);
    if (!front) {
      continue;
    }
    const friendlySide = getFrontSide(front, nationId);
    const enemySide = getOpposingFrontSide(front, nationId);
    if (!friendlySide || !enemySide) {
      continue;
    }
    contexts.push({
      plan,
      front,
      friendlySide,
      distanceByRegionId:
        getFrontDistanceField(world, front.id, nationId)?.distanceByRegionId ??
        new Map(),
    });
  }
  return contexts;
}

function assignBestUnit(
  pool: UnitState[],
  allocation: MutableAllocation,
  previousFrontIdByUnitId: Map<UnitId, FrontId>,
  unitStrengthById: Map<UnitId, number>,
  deficit: number,
): boolean {
  let bestIndex = -1;
  let bestCost = Number.POSITIVE_INFINITY;
  for (let index = 0; index < pool.length; index += 1) {
    const unit = pool[index];
    const distance = allocation.context.distanceByRegionId.get(unit.regionId);
    if (distance === undefined) {
      continue;
    }
    const strength = unitStrengthById.get(unit.id) ?? 0;
    const strengthFitPenalty =
      deficit > 0 ? (Math.max(0, deficit - strength) / deficit) * 4 : 0;
    const previousFrontId = previousFrontIdByUnitId.get(unit.id);
    const settings = WORLD_BALANCE.war.landFront.allocation;
    const switchCost =
      previousFrontId === allocation.context.front.id
        ? -settings.sameFrontBonusDistance
        : previousFrontId
          ? settings.switchPenaltyDistance
          : 0;
    const cost = distance + strengthFitPenalty + switchCost;
    if (
      cost < bestCost ||
      (cost === bestCost &&
        (bestIndex < 0 || compareIds(unit.id, pool[bestIndex].id) < 0))
    ) {
      bestCost = cost;
      bestIndex = index;
    }
  }
  if (bestIndex < 0) {
    return false;
  }
  const [unit] = pool.splice(bestIndex, 1);
  if (!unit) {
    return false;
  }
  allocation.units.push(unit);
  allocation.allocatedStrength += unitStrengthById.get(unit.id) ?? 0;
  return true;
}

function selectSurplusFront(
  unit: UnitState,
  contexts: FrontAllocationContext[],
  mutableByFrontId: Map<FrontId, MutableAllocation>,
  previousFrontIdByUnitId: Map<UnitId, FrontId>,
): FrontAllocationContext | undefined {
  const settings = WORLD_BALANCE.war.landFront.allocation;
  const previousFrontId = previousFrontIdByUnitId.get(unit.id);
  let best: FrontAllocationContext | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const context of contexts) {
    const mutable = mutableByFrontId.get(context.front.id);
    const distance = context.distanceByRegionId.get(unit.regionId);
    if (distance === undefined) {
      continue;
    }
    const loadRatio =
      (mutable?.allocatedStrength ?? 0) / Math.max(1, context.plan.desiredStrength);
    const stability =
      previousFrontId === context.front.id
        ? settings.sameFrontBonusDistance
        : previousFrontId
          ? -settings.switchPenaltyDistance
          : 0;
    const score =
      context.plan.priority -
      distance * settings.surplusDistanceWeight -
      loadRatio * settings.surplusLoadPenalty +
      stability;
    if (
      score > bestScore ||
      (score === bestScore &&
        best &&
        compareIds(context.front.id, best.front.id) < 0)
    ) {
      best = context;
      bestScore = score;
    }
  }
  return best;
}

function selectMostUrgentDeficitAllocation(
  contexts: FrontAllocationContext[],
  mutableByFrontId: Map<FrontId, MutableAllocation>,
  excludedFrontIds: ReadonlySet<FrontId>,
): MutableAllocation | undefined {
  let best: MutableAllocation | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const context of contexts) {
    if (
      excludedFrontIds.has(context.front.id) ||
      context.plan.posture === "retreat" ||
      context.plan.desiredStrength <= 0
    ) {
      continue;
    }
    const mutable = mutableByFrontId.get(context.front.id);
    if (!mutable) {
      continue;
    }
    const deficit = context.plan.desiredStrength - mutable.allocatedStrength;
    if (deficit <= 0) {
      continue;
    }
    const deficitRatio = deficit / context.plan.desiredStrength;
    const score = context.plan.priority * deficitRatio;
    if (
      score > bestScore ||
      (score === bestScore &&
        best &&
        compareIds(context.front.id, best.context.front.id) < 0)
    ) {
      best = mutable;
      bestScore = score;
    }
  }
  return best;
}

function captureFrontGeometry(
  world: WorldState,
): Map<FrontId, FrontGeometrySnapshot> {
  const result = new Map<FrontId, FrontGeometrySnapshot>();
  for (const front of world.landFronts.operationalSectors) {
    result.set(front.id, {
      nationAId: front.nationAId,
      nationBId: front.nationBId,
      regionIds: new Set([
        ...front.sideA.borderRegionIds,
        ...front.sideB.borderRegionIds,
        ...front.sideA.influenceRegionIds,
        ...front.sideB.influenceRegionIds,
      ]),
    });
  }
  return result;
}

function matchPreviousFrontsToCurrent(
  previousGeometryById: Map<FrontId, FrontGeometrySnapshot>,
  world: WorldState,
): Map<FrontId, FrontId> {
  const result = new Map<FrontId, FrontId>();
  for (const [previousFrontId, previous] of previousGeometryById.entries()) {
    if (world.landFronts.operationalSectorsById.has(previousFrontId)) {
      result.set(previousFrontId, previousFrontId);
      continue;
    }
    const candidates = world.landFronts.operationalSectors.filter(
      (front) =>
        front.nationAId === previous.nationAId &&
        front.nationBId === previous.nationBId,
    );
    let best: OperationalSector | undefined;
    let bestOverlap = 0;
    for (const candidate of candidates) {
      const overlap = countFrontRegionOverlap(previous.regionIds, candidate);
      if (
        overlap > bestOverlap ||
        (overlap === bestOverlap &&
          overlap > 0 &&
          best &&
          compareIds(candidate.id, best.id) < 0)
      ) {
        best = candidate;
        bestOverlap = overlap;
      }
    }
    if (best && bestOverlap > 0) {
      result.set(previousFrontId, best.id);
    } else if (candidates.length === 1) {
      // A single A-B component remains the same strategic front even if a fast
      // territorial advance replaced every former border region.
      result.set(previousFrontId, candidates[0].id);
    }
  }
  return result;
}

function countFrontRegionOverlap(
  previousRegionIds: ReadonlySet<MesoRegionId>,
  current: OperationalSector,
): number {
  let overlap = 0;
  const currentRegionIds = new Set([
    ...current.sideA.borderRegionIds,
    ...current.sideB.borderRegionIds,
    ...current.sideA.influenceRegionIds,
    ...current.sideB.influenceRegionIds,
  ]);
  for (const regionId of currentRegionIds) {
    if (previousRegionIds.has(regionId)) {
      overlap += 1;
    }
  }
  return overlap;
}

function remapPreviousAssignmentsToCurrentFronts(
  previous: Map<UnitId, FrontId>,
  currentFrontIdByPreviousFrontId: Map<FrontId, FrontId>,
  preserveUnmatched: boolean,
): Map<UnitId, FrontId> {
  const result = new Map<UnitId, FrontId>();
  for (const [unitId, previousFrontId] of previous.entries()) {
    const currentFrontId = currentFrontIdByPreviousFrontId.get(previousFrontId);
    if (currentFrontId) {
      result.set(unitId, currentFrontId);
    } else if (preserveUnmatched) {
      result.set(unitId, previousFrontId);
    }
  }
  return result;
}

function indexLandUnitsByNation(units: UnitState[]): Map<NationId, UnitState[]> {
  const result = new Map<NationId, UnitState[]>();
  for (const unit of units) {
    const list = result.get(unit.nationId);
    if (list) {
      list.push(unit);
    } else {
      result.set(unit.nationId, [unit]);
    }
  }
  return result;
}

function indexAllocationsByNation(
  allocations: NationFrontAllocation[],
): Map<NationId, NationFrontAllocation[]> {
  const result = new Map<NationId, NationFrontAllocation[]>();
  for (const allocation of allocations) {
    const list = result.get(allocation.nationId);
    if (list) {
      list.push(allocation);
    } else {
      result.set(allocation.nationId, [allocation]);
    }
  }
  return result;
}

function countMembershipChanges(
  previous: Map<UnitId, FrontId>,
  next: Map<UnitId, FrontId>,
): { switchCount: number; frontTransferCount: number } {
  let switchCount = 0;
  let frontTransferCount = 0;
  const unitIds = new Set([...previous.keys(), ...next.keys()]);
  for (const unitId of unitIds) {
    const previousFrontId = previous.get(unitId);
    const nextFrontId = next.get(unitId);
    if (previousFrontId === nextFrontId) {
      continue;
    }
    switchCount += 1;
    if (previousFrontId && nextFrontId) {
      frontTransferCount += 1;
    }
  }
  return { switchCount, frontTransferCount };
}

function areAssignmentMapsEqual(
  a: Map<UnitId, FrontId>,
  b: Map<UnitId, FrontId>,
): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const [unitId, frontId] of a.entries()) {
    if (b.get(unitId) !== frontId) {
      return false;
    }
  }
  return true;
}

function sumMapArrayLengths(map: Map<NationId, UnitId[]>): number {
  let total = 0;
  for (const values of map.values()) {
    total += values.length;
  }
  return total;
}

function finiteUnitStrength(unit: UnitState): number {
  return finiteNumber(getUnitCombatStrength(unit));
}

function finiteNumber(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function createAllocationKey(frontId: FrontId, nationId: NationId): string {
  return `${frontId}::${nationId}`;
}

function compareAllocationContexts(
  a: FrontAllocationContext,
  b: FrontAllocationContext,
): number {
  if (a.plan.priority !== b.plan.priority) {
    return b.plan.priority - a.plan.priority;
  }
  return compareIds(a.front.id, b.front.id);
}

function compareAllocations(
  a: NationFrontAllocation,
  b: NationFrontAllocation,
): number {
  const nationCompare = compareIds(a.nationId, b.nationId);
  return nationCompare !== 0
    ? nationCompare
    : compareIds(a.frontId, b.frontId);
}

function compareUnits(a: UnitState, b: UnitState): number {
  return compareIds(a.id, b.id);
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
