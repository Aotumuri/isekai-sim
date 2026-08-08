import type { WorldState } from "../world-state";
import type { UnitState } from "../unit";
import { getMoveMsPerRegion } from "../movement";
import type {
  MesoRegion,
  MesoRegionBuilding,
  MesoRegionId,
} from "../../worldgen/meso-region";
import type { NationId } from "../../worldgen/nation";
import type { SeededRng } from "../../utils/seeded-rng";
import { buildWarAdjacency, isAtWar, type WarAdjacency } from "../war-state";
import {
  getBorderTargetsByNation,
  getMesoById,
  getNeighborsById,
  getOwnerByMesoId,
} from "../world-cache";
import type { SimulationInstrumentation } from "../instrumentation";
import {
  getNationFrontAllocations,
  getUnassignedLandUnitIds,
} from "../nation-front-allocations";
import { getFrontSide, getOpposingFrontSide } from "../land-fronts";
import {
  getOffensiveOperationForFront,
  type OffensiveOperation,
} from "../offensive-operations";
import { getRetreatPlans, type RetreatPlan } from "../retreat-plans";
import {
  getNationReserveState,
  getReserveTargetForUnit,
  type NationReserveState,
} from "../strategic-reserves";
import {
  getReorganizationPlans,
  getReorganizationTargetForUnit,
  type ReorganizationPlan,
} from "../reorganization";

const LAND_TARGET_REASSIGN_INTERVAL_TICKS = 10;
const MAX_SHARED_PATH_FIELDS = 256;

interface LandMovementGroup {
  nationId: NationId;
  units: UnitState[];
  controlledOnly?: boolean;
}

interface LandAiRuntime {
  lastAssignmentFastTick: number;
  territoryVersion: number;
  occupationVersion: number;
  buildingVersion: number;
  unitIdCounter: number;
  unitsReference: UnitState[] | null;
  landUnitCount: number;
  warsReference: WorldState["wars"] | null;
  warCount: number;
  frontAllocationMembershipVersion: number;
  offensiveOperationVersion: number;
  retreatPlanVersion: number;
  strategicReserveVersion: number;
  reorganizationVersion: number;
  warAdjacency: WarAdjacency;
  movementGroups: LandMovementGroup[];
  unitsExpectedToHaveTarget: Set<UnitState["id"]>;
  forceReassignment: boolean;
  sharedPathFields: Map<string, SharedPathField>;
  pathFieldMapVersion: number;
  pathFieldTerritoryVersion: number;
  pathFieldOccupationVersion: number;
  pathFieldOccupationByMesoId: Map<MesoRegionId, NationId>;
  pathFieldBuildingVersion: number;
  pathFieldWarsReference: WorldState["wars"] | null;
  pathFieldWarCount: number;
}

interface SharedPathField {
  targetId: MesoRegionId;
  // Keep only next hops learned from actual searches, not a full distance field.
  nextHopByRegion: Map<MesoRegionId, MesoRegionId>;
  unreachableRegions: Set<MesoRegionId>;
}

interface SharedPathContext {
  nationId: NationId;
  pathMode: "owned" | "war";
  sharedPathFields: Map<string, SharedPathField>;
  instrumentation?: SimulationInstrumentation;
}

const landAiRuntimeByWorld = new WeakMap<WorldState, LandAiRuntime>();

export function repositionUnits(world: WorldState, dtMs: number): void {
  if (world.units.length === 0 || world.mesoRegions.length === 0) {
    return;
  }
  const landUnits = world.units.filter((unit) => unit.domain === "land");
  if (landUnits.length === 0) {
    return;
  }
  const runtime = getLandAiRuntime(world);
  const instrumentation = world.instrumentation;
  invalidateSharedPathFields(runtime, world, instrumentation);

  let expectedTargetWasCleared = false;
  if (runtime.unitsExpectedToHaveTarget.size > 0) {
    for (const unit of landUnits) {
      if (
        runtime.unitsExpectedToHaveTarget.has(unit.id) &&
        !unit.moveTargetId
      ) {
        expectedTargetWasCleared = true;
        break;
      }
    }
  }

  const territoryChanged = runtime.territoryVersion !== world.territoryVersion;
  const occupationChanged = runtime.occupationVersion !== world.occupation.version;
  const buildingChanged = runtime.buildingVersion !== world.buildingVersion;
  const unitsChanged =
    runtime.unitsReference !== world.units ||
    runtime.unitIdCounter !== world.unitIdCounter ||
    runtime.landUnitCount !== landUnits.length;
  const warsChanged =
    runtime.warsReference !== world.wars || runtime.warCount !== world.wars.length;
  const frontAllocationChanged =
    runtime.frontAllocationMembershipVersion !==
    world.frontAllocations.membershipVersion;
  const offensiveOperationChanged =
    runtime.offensiveOperationVersion !== world.offensiveOperations.version;
  const retreatPlanChanged =
    runtime.retreatPlanVersion !== world.retreatPlans.version;
  const strategicReserveChanged =
    runtime.strategicReserveVersion !== world.strategicReserves.version;
  const reorganizationChanged =
    runtime.reorganizationVersion !== world.reorganization.version;
  const periodicReassignmentDue =
    world.time.fastTick - runtime.lastAssignmentFastTick >=
    LAND_TARGET_REASSIGN_INTERVAL_TICKS;
  const shouldReassign =
    runtime.forceReassignment ||
    expectedTargetWasCleared ||
    territoryChanged ||
    occupationChanged ||
    buildingChanged ||
    unitsChanged ||
    warsChanged ||
    frontAllocationChanged ||
    offensiveOperationChanged ||
    retreatPlanChanged ||
    strategicReserveChanged ||
    reorganizationChanged ||
    periodicReassignmentDue;

  const mesoById = getMesoById(world);
  const neighborsById = getNeighborsById(world);
  const ownerByMesoId = getOwnerByMesoId(world);

  if (warsChanged) {
    runtime.warAdjacency = buildWarAdjacency(world.wars);
  }
  const warAdjacency = runtime.warAdjacency;
  const occupationByMesoId = world.occupation.mesoById;

  // region -> nations that currently have land units there (fast enemy blocking checks)
  const nationsWithLandUnitsByMesoId = new Map<MesoRegionId, Set<NationId>>();
  for (const unit of landUnits) {
    let set = nationsWithLandUnitsByMesoId.get(unit.regionId);
    if (!set) {
      set = new Set<NationId>();
      nationsWithLandUnitsByMesoId.set(unit.regionId, set);
    }
    set.add(unit.nationId);
  }
  if (shouldReassign) {
    const assignmentStartedAt = instrumentation ? performance.now() : 0;
    instrumentation?.incrementCounter("target.reassignments");
    rebuildLandAssignments(
      world,
      runtime,
      landUnits,
      mesoById,
      neighborsById,
      ownerByMesoId,
      occupationByMesoId,
      warAdjacency,
      instrumentation,
    );
    if (instrumentation) {
      instrumentation.recordDuration(
        "assignment.rebuild",
        performance.now() - assignmentStartedAt,
      );
    }
    runtime.lastAssignmentFastTick = world.time.fastTick;
    runtime.territoryVersion = world.territoryVersion;
    runtime.occupationVersion = world.occupation.version;
    runtime.buildingVersion = world.buildingVersion;
    runtime.unitIdCounter = world.unitIdCounter;
    runtime.unitsReference = world.units;
    runtime.landUnitCount = landUnits.length;
    runtime.warsReference = world.wars;
    runtime.warCount = world.wars.length;
    runtime.frontAllocationMembershipVersion =
      world.frontAllocations.membershipVersion;
    runtime.offensiveOperationVersion = world.offensiveOperations.version;
    runtime.retreatPlanVersion = world.retreatPlans.version;
    runtime.strategicReserveVersion = world.strategicReserves.version;
    runtime.reorganizationVersion = world.reorganization.version;
    runtime.forceReassignment = false;
  }

  const movementStartedAt = instrumentation ? performance.now() : 0;
  for (const group of runtime.movementGroups) {
    const isBlockedByEnemy = (toId: MesoRegionId): boolean => {
      const present = nationsWithLandUnitsByMesoId.get(toId);
      if (!present || present.size === 0) {
        return false;
      }
      for (const otherNationId of present) {
        if (otherNationId === group.nationId) {
          continue;
        }
        if (isAtWar(group.nationId, otherNationId, warAdjacency)) {
          return true;
        }
      }
      return false;
    };
    const orderInvalidated = progressNationUnits(
      group.nationId,
      group.units,
      dtMs,
      runtime.sharedPathFields,
      mesoById,
      neighborsById,
      ownerByMesoId,
      occupationByMesoId,
      warAdjacency,
      isBlockedByEnemy,
      group.controlledOnly ?? false,
      instrumentation,
    );
    if (orderInvalidated) {
      runtime.forceReassignment = true;
    }
  }
  if (instrumentation) {
    instrumentation.recordDuration(
      "movement.progression",
      performance.now() - movementStartedAt,
    );
  }
}

function getLandAiRuntime(world: WorldState): LandAiRuntime {
  const existing = landAiRuntimeByWorld.get(world);
  if (existing) {
    return existing;
  }
  const created: LandAiRuntime = {
    lastAssignmentFastTick: Number.NEGATIVE_INFINITY,
    territoryVersion: -1,
    occupationVersion: -1,
    buildingVersion: -1,
    unitIdCounter: -1,
    unitsReference: null,
    landUnitCount: -1,
    warsReference: null,
    warCount: -1,
    frontAllocationMembershipVersion: -1,
    offensiveOperationVersion: -1,
    retreatPlanVersion: -1,
    strategicReserveVersion: -1,
    reorganizationVersion: -1,
    warAdjacency: new Map(),
    movementGroups: [],
    unitsExpectedToHaveTarget: new Set(),
    forceReassignment: true,
    sharedPathFields: new Map(),
    pathFieldMapVersion: -1,
    pathFieldTerritoryVersion: -1,
    pathFieldOccupationVersion: -1,
    pathFieldOccupationByMesoId: new Map(),
    pathFieldBuildingVersion: -1,
    pathFieldWarsReference: null,
    pathFieldWarCount: -1,
  };
  landAiRuntimeByWorld.set(world, created);
  return created;
}

function invalidateSharedPathFields(
  runtime: LandAiRuntime,
  world: WorldState,
  instrumentation?: SimulationInstrumentation,
): void {
  const mapChanged = runtime.pathFieldMapVersion !== world.mapVersion;
  const territoryChanged =
    runtime.pathFieldTerritoryVersion !== world.territoryVersion;
  const occupationChanged =
    runtime.pathFieldOccupationVersion !== world.occupation.version;
  const buildingChanged =
    runtime.pathFieldBuildingVersion !== world.buildingVersion;
  const warsChanged =
    runtime.pathFieldWarsReference !== world.wars ||
    runtime.pathFieldWarCount !== world.wars.length;

  if (mapChanged || territoryChanged || occupationChanged || buildingChanged || warsChanged) {
    instrumentation?.incrementCounter("pathfinding.shared.invalidations");
  }
  if (mapChanged) {
    instrumentation?.incrementCounter("pathfinding.shared.invalidation.map");
  }
  if (territoryChanged) {
    instrumentation?.incrementCounter("pathfinding.shared.invalidation.territory");
  }
  if (occupationChanged) {
    instrumentation?.incrementCounter("pathfinding.shared.invalidation.occupation");
  }
  if (buildingChanged) {
    instrumentation?.incrementCounter("pathfinding.shared.invalidation.building");
  }
  if (warsChanged) {
    instrumentation?.incrementCounter("pathfinding.shared.invalidation.wars");
  }

  if (occupationChanged) {
    // Occupation does not change graph passability. Only fields whose exact target
    // changed occupation need to be discarded.
    const changedOccupationTargets = new Set<MesoRegionId>();
    for (const [mesoId, occupier] of runtime.pathFieldOccupationByMesoId.entries()) {
      if (world.occupation.mesoById.get(mesoId) !== occupier) {
        changedOccupationTargets.add(mesoId);
      }
    }
    for (const [mesoId, occupier] of world.occupation.mesoById.entries()) {
      if (runtime.pathFieldOccupationByMesoId.get(mesoId) !== occupier) {
        changedOccupationTargets.add(mesoId);
      }
    }
    for (const [key, field] of runtime.sharedPathFields.entries()) {
      if (changedOccupationTargets.has(field.targetId)) {
        runtime.sharedPathFields.delete(key);
        instrumentation?.incrementCounter("pathfinding.shared.fieldsDiscarded");
      }
    }
    runtime.pathFieldOccupationVersion = world.occupation.version;
    runtime.pathFieldOccupationByMesoId = new Map(world.occupation.mesoById);
  }
  if (buildingChanged) {
    instrumentation?.incrementCounter(
      "pathfinding.shared.fieldsDiscarded",
      runtime.sharedPathFields.size,
    );
    runtime.sharedPathFields.clear();
    runtime.pathFieldBuildingVersion = world.buildingVersion;
  }

  if (mapChanged || territoryChanged || warsChanged) {
    instrumentation?.incrementCounter(
      "pathfinding.shared.fieldsDiscarded",
      runtime.sharedPathFields.size,
    );
    runtime.sharedPathFields.clear();
    runtime.pathFieldMapVersion = world.mapVersion;
    runtime.pathFieldTerritoryVersion = world.territoryVersion;
    runtime.pathFieldWarsReference = world.wars;
    runtime.pathFieldWarCount = world.wars.length;
  }
}

function rebuildLandAssignments(
  world: WorldState,
  runtime: LandAiRuntime,
  landUnits: UnitState[],
  mesoById: Map<MesoRegionId, MesoRegion>,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  occupationByMesoId: Map<MesoRegionId, NationId>,
  warAdjacency: WarAdjacency,
  instrumentation?: SimulationInstrumentation,
): void {
  const liberationTargetsByNationId = collectLiberationTargetsByNation(
    occupationByMesoId,
    ownerByMesoId,
    mesoById,
  );
  const intrusionTargetsByNationId = collectIntrusionTargetsByNation(
    landUnits,
    ownerByMesoId,
    mesoById,
    warAdjacency,
  );
  const occupationTargetsByNationId = collectOccupationTargetsByNation(
    world.mesoRegions,
    ownerByMesoId,
    occupationByMesoId,
    warAdjacency,
  );
  const borderByNationId = getBorderTargetsByNation(world);

  const nationById = new Map<NationId, WorldState["nations"][number]>();
  for (const nation of world.nations) {
    nationById.set(nation.id, nation);
    nation.unitRoles.defenseUnitIds = [];
    nation.unitRoles.occupationUnitIds = [];
  }

  const unitsByNation = new Map<NationId, UnitState[]>();
  for (const unit of landUnits) {
    const list = unitsByNation.get(unit.nationId);
    if (list) {
      list.push(unit);
    } else {
      unitsByNation.set(unit.nationId, [unit]);
    }
  }

  const movementGroups: LandMovementGroup[] = [];
  const unitById = new Map(landUnits.map((unit) => [unit.id, unit]));
  for (const [nationId, units] of unitsByNation.entries()) {
    const borderTargets = borderByNationId.get(nationId) ?? [];
    const intrusionTargets = intrusionTargetsByNationId.get(nationId) ?? [];
    const liberationTargets = liberationTargetsByNationId.get(nationId) ?? [];
    const occupationTargets = occupationTargetsByNationId.get(nationId) ?? [];
    const nation = nationById.get(nationId);
    const frontAllocations = getNationFrontAllocations(world, nationId);
    const retreatPlans = getRetreatPlans(world, nationId);
    const reorganizationPlans = getReorganizationPlans(world, nationId);
    const reserve = getNationReserveState(world, nationId);
    const reserveUnitIds = new Set(reserve?.unitIds ?? []);
    const reorganizationUnitIds = new Set(
      reorganizationPlans.map((plan) => plan.unitId),
    );
    const retreatUnitIds = new Set(
      retreatPlans.flatMap((retreat) => [
        ...retreat.rearguardUnitIds,
        ...retreat.retreatingUnitIds,
      ]),
    );
    const normalNationUnits = units.filter(
      (unit) =>
        !retreatUnitIds.has(unit.id) &&
        !reserveUnitIds.has(unit.id) &&
        !reorganizationUnitIds.has(unit.id),
    );
    for (const plan of reorganizationPlans) {
      const unit = unitById.get(plan.unitId);
      if (unit && unit.nationId === nationId) {
        movementGroups.push(
          buildReorganizationMovementGroup(
            world,
            plan,
            unit,
            nation,
            instrumentation,
          ),
        );
      }
    }
    if (reserve) {
      const reserveUnits = reserve.unitIds
        .map((unitId) => unitById.get(unitId))
        .filter(
          (unit): unit is UnitState =>
            !!unit &&
            unit.nationId === nationId &&
            !retreatUnitIds.has(unit.id) &&
            !reorganizationUnitIds.has(unit.id),
        );
      if (reserveUnits.length > 0) {
        movementGroups.push(
          buildReserveMovementGroup(
            world,
            reserve,
            reserveUnits,
            nation,
            instrumentation,
          ),
        );
      }
    }
    for (const retreat of retreatPlans) {
      const rearguardUnits = retreat.rearguardUnitIds
        .map((unitId) => unitById.get(unitId))
        .filter((unit): unit is UnitState => !!unit && unit.nationId === nationId);
      const withdrawingUnits = retreat.retreatingUnitIds
        .map((unitId) => unitById.get(unitId))
        .filter((unit): unit is UnitState => !!unit && unit.nationId === nationId);
      if (rearguardUnits.length > 0) {
        movementGroups.push(
          buildRetreatRearguardMovementGroup(
            world,
            retreat,
            rearguardUnits,
            intrusionTargets,
            liberationTargets,
            nation,
            mesoById,
            neighborsById,
            ownerByMesoId,
            occupationByMesoId,
            warAdjacency,
            instrumentation,
          ),
        );
      }
      if (withdrawingUnits.length > 0) {
        movementGroups.push(
          buildRetreatMovementGroup(
            world,
            retreat,
            withdrawingUnits,
            nation,
            instrumentation,
          ),
        );
      }
    }
    if (frontAllocations.length === 0) {
      if (normalNationUnits.length > 0) {
        movementGroups.push(
          buildLandMovementGroup(
            nationId,
            normalNationUnits,
            intrusionTargets,
            liberationTargets,
            borderTargets,
            occupationTargets,
            nation,
            mesoById,
            neighborsById,
            ownerByMesoId,
            occupationByMesoId,
            warAdjacency,
            instrumentation,
          ),
        );
      }
      continue;
    }

    for (const allocation of frontAllocations) {
      const front = world.landFronts.operationalSectorsById.get(allocation.frontId);
      if (!front) {
        continue;
      }
      const friendlySide = getFrontSide(front, nationId);
      const enemySide = getOpposingFrontSide(front, nationId);
      if (!friendlySide || !enemySide) {
        continue;
      }
      const allocatedUnits = allocation.unitIds
        .map((unitId) => unitById.get(unitId))
        .filter(
          (unit): unit is UnitState =>
            !!unit &&
            unit.nationId === nationId &&
            !retreatUnitIds.has(unit.id) &&
            !reserveUnitIds.has(unit.id) &&
            !reorganizationUnitIds.has(unit.id),
        );
      if (allocatedUnits.length === 0) {
        continue;
      }
      const operation = getOffensiveOperationForFront(
        world,
        allocation.frontId,
        nationId,
      );
      const activeOperation =
        operation && operation.phase !== "recovering" ? operation : undefined;
      const operationUnitIds = new Set(activeOperation?.assignedUnitIds ?? []);
      const normalFrontUnits = allocatedUnits.filter(
        (unit) => !operationUnitIds.has(unit.id),
      );
      const operationUnits = activeOperation
        ? allocatedUnits.filter((unit) => operationUnitIds.has(unit.id))
        : [];
      const operationTargetIds = new Set(
        activeOperation
          ? [
              activeOperation.primaryTargetRegionId,
              ...activeOperation.supportingTargetRegionIds,
            ]
          : [],
      );
      const friendlyScope = new Set(friendlySide.influenceRegionIds);
      const frontScope = new Set([
        ...friendlySide.influenceRegionIds,
        ...enemySide.influenceRegionIds,
      ]);
      const enemyScope = new Set(enemySide.influenceRegionIds);
      if (normalFrontUnits.length > 0) {
        movementGroups.push(
          buildLandMovementGroup(
            nationId,
            normalFrontUnits,
            intrusionTargets.filter((id) => frontScope.has(id)),
            liberationTargets.filter((id) => frontScope.has(id)),
            friendlySide.borderRegionIds,
            occupationTargets.filter(
              (id) => enemyScope.has(id) && !operationTargetIds.has(id),
            ),
            nation,
            mesoById,
            neighborsById,
            ownerByMesoId,
            occupationByMesoId,
            warAdjacency,
            instrumentation,
            friendlyScope,
          ),
        );
      }
      if (activeOperation && operationUnits.length > 0) {
        movementGroups.push(
          buildOperationMovementGroup(
            world,
            activeOperation,
            operationUnits,
            nation,
            instrumentation,
          ),
        );
      }
    }

    const unassignedUnits = getUnassignedLandUnitIds(world, nationId)
      .map((unitId) => unitById.get(unitId))
      .filter(
        (unit): unit is UnitState =>
          !!unit &&
          unit.nationId === nationId &&
          !retreatUnitIds.has(unit.id) &&
          !reserveUnitIds.has(unit.id) &&
          !reorganizationUnitIds.has(unit.id),
      );
    clearUnitMovement(unassignedUnits);
  }

  runtime.movementGroups = movementGroups;
  const unitsExpectedToHaveTarget = new Set<UnitState["id"]>();
  for (const group of movementGroups) {
    for (const unit of group.units) {
      if (unit.moveTargetId) {
        unitsExpectedToHaveTarget.add(unit.id);
      }
    }
  }
  runtime.unitsExpectedToHaveTarget = unitsExpectedToHaveTarget;
}

function buildReorganizationMovementGroup(
  world: WorldState,
  plan: ReorganizationPlan,
  unit: UnitState,
  nation: WorldState["nations"][number] | undefined,
  instrumentation?: SimulationInstrumentation,
): LandMovementGroup {
  const startedAt = instrumentation ? performance.now() : 0;
  const targetId = getReorganizationTargetForUnit(world, unit.id);
  let assignmentCount = 0;
  let switchCount = 0;
  if (plan.phase === "moving-to-rear" && targetId) {
    if (unit.moveTargetId !== targetId) {
      if (unit.moveTargetId) switchCount += 1;
      unit.moveTargetId = targetId;
      unit.moveFromId = null;
      unit.moveToId = null;
      unit.moveProgressMs = 0;
      assignmentCount += 1;
    }
  } else if (unit.moveTargetId || unit.moveToId || unit.moveFromId) {
    if (unit.moveTargetId) switchCount += 1;
    clearUnitMovement([unit]);
  }
  nation?.unitRoles.defenseUnitIds.push(unit.id);
  instrumentation?.incrementCounter(
    "reorganization.targetAssignments",
    assignmentCount,
  );
  instrumentation?.incrementCounter(
    "reorganization.unitTargetSwitches",
    switchCount,
  );
  if (instrumentation) {
    instrumentation.recordDuration(
      "reorganization.targetAssignment",
      performance.now() - startedAt,
    );
  }
  return { nationId: plan.nationId, units: [unit], controlledOnly: true };
}

function buildReserveMovementGroup(
  world: WorldState,
  reserve: NationReserveState,
  units: UnitState[],
  nation: WorldState["nations"][number] | undefined,
  instrumentation?: SimulationInstrumentation,
): LandMovementGroup {
  const startedAt = instrumentation ? performance.now() : 0;
  const orderedUnits = [...units].sort(compareUnitIds);
  let assignmentCount = 0;
  let switchCount = 0;
  for (const unit of orderedUnits) {
    const targetId = getReserveTargetForUnit(reserve, unit.id);
    if (!targetId) {
      if (unit.moveTargetId) switchCount += 1;
      unit.moveTargetId = null;
      unit.moveFromId = null;
      unit.moveToId = null;
      unit.moveProgressMs = 0;
      continue;
    }
    if (unit.moveTargetId === targetId) continue;
    if (unit.moveTargetId) switchCount += 1;
    unit.moveTargetId = targetId;
    unit.moveFromId = null;
    unit.moveToId = null;
    unit.moveProgressMs = 0;
    assignmentCount += 1;
  }
  nation?.unitRoles.defenseUnitIds.push(...orderedUnits.map((unit) => unit.id));
  instrumentation?.incrementCounter(
    "strategicReserve.targetAssignments",
    assignmentCount,
  );
  instrumentation?.incrementCounter(
    "strategicReserve.unitTargetSwitches",
    switchCount,
  );
  if (instrumentation) {
    instrumentation.recordDuration(
      "strategicReserve.targetAssignment",
      performance.now() - startedAt,
    );
  }
  return {
    nationId: reserve.nationId,
    units: orderedUnits,
    controlledOnly: true,
  };
}

function buildLandMovementGroup(
  nationId: NationId,
  units: UnitState[],
  intrusionTargets: MesoRegionId[],
  liberationTargets: MesoRegionId[],
  borderTargets: MesoRegionId[],
  occupationTargets: MesoRegionId[],
  nation: WorldState["nations"][number] | undefined,
  mesoById: Map<MesoRegionId, MesoRegion>,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  occupationByMesoId: Map<MesoRegionId, NationId>,
  warAdjacency: WarAdjacency,
  instrumentation?: SimulationInstrumentation,
  defenseRegionScope?: ReadonlySet<MesoRegionId>,
): LandMovementGroup {
  const orderedUnits = [...units].sort((a, b) => a.id.localeCompare(b.id));
  const defenseCount = determineDefenseUnitCount(
    orderedUnits.length,
    intrusionTargets.length,
    liberationTargets.length,
    occupationTargets.length,
  );
  const defenseUnits = orderedUnits.slice(0, defenseCount);
  const occupationUnits = orderedUnits.slice(defenseCount);
  if (nation) {
    nation.unitRoles.defenseUnitIds.push(...defenseUnits.map((unit) => unit.id));
    nation.unitRoles.occupationUnitIds.push(
      ...occupationUnits.map((unit) => unit.id),
    );
  }
  return {
    nationId,
    units: assignNationTargets(
      nationId,
      defenseUnits,
      occupationUnits,
      intrusionTargets,
      liberationTargets,
      borderTargets,
      occupationTargets,
      mesoById,
      neighborsById,
      ownerByMesoId,
      occupationByMesoId,
      warAdjacency,
      instrumentation,
      defenseRegionScope,
    ),
  };
}

function buildOperationMovementGroup(
  world: WorldState,
  operation: OffensiveOperation,
  units: UnitState[],
  nation: WorldState["nations"][number] | undefined,
  instrumentation?: SimulationInstrumentation,
): LandMovementGroup {
  const startedAt = instrumentation ? performance.now() : 0;
  let assignmentCount = 0;
  let switchCount = 0;
  const orderedUnits = [...units].sort((a, b) => a.id.localeCompare(b.id));
  for (const unit of orderedUnits) {
    const targetId =
      operation.phase === "preparing"
        ? operation.stagingRegionId
        : (operation.unitTargetRegionIds.get(unit.id) ??
          operation.primaryTargetRegionId);
    if (unit.moveTargetId === targetId) {
      continue;
    }
    if (unit.moveTargetId) {
      switchCount += 1;
    }
    unit.moveTargetId = targetId;
    unit.moveFromId = null;
    unit.moveToId = null;
    unit.moveProgressMs = 0;
    assignmentCount += 1;
  }
  if (operation.phase === "preparing") {
    nation?.unitRoles.defenseUnitIds.push(...orderedUnits.map((unit) => unit.id));
  } else {
    nation?.unitRoles.occupationUnitIds.push(...orderedUnits.map((unit) => unit.id));
  }
  world.offensiveOperations.unitTargetSwitchCount += switchCount;
  instrumentation?.incrementCounter(
    "offensiveOperation.targetAssignments",
    assignmentCount,
  );
  instrumentation?.incrementCounter(
    "offensiveOperation.unitTargetSwitches",
    switchCount,
  );
  if (instrumentation) {
    instrumentation.recordDuration(
      "offensiveOperation.targetAssignment",
      performance.now() - startedAt,
    );
  }
  return { nationId: operation.nationId, units: orderedUnits };
}

function buildRetreatRearguardMovementGroup(
  world: WorldState,
  retreat: RetreatPlan,
  units: UnitState[],
  intrusionTargets: MesoRegionId[],
  liberationTargets: MesoRegionId[],
  nation: WorldState["nations"][number] | undefined,
  mesoById: Map<MesoRegionId, MesoRegion>,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  occupationByMesoId: Map<MesoRegionId, NationId>,
  warAdjacency: WarAdjacency,
  instrumentation?: SimulationInstrumentation,
): LandMovementGroup {
  const front = world.landFronts.operationalSectorsById.get(retreat.frontId);
  const friendlySide = front ? getFrontSide(front, retreat.nationId) : undefined;
  const enemySide = front ? getOpposingFrontSide(front, retreat.nationId) : undefined;
  if (!friendlySide || !enemySide) {
    clearUnitMovement(units);
    nation?.unitRoles.defenseUnitIds.push(...units.map((unit) => unit.id));
    return { nationId: retreat.nationId, units: [...units].sort(compareUnitIds) };
  }
  const frontScope = new Set([
    ...friendlySide.influenceRegionIds,
    ...enemySide.influenceRegionIds,
  ]);
  return buildLandMovementGroup(
    retreat.nationId,
    units,
    intrusionTargets.filter((id) => frontScope.has(id)),
    liberationTargets.filter((id) => frontScope.has(id)),
    friendlySide.borderRegionIds,
    [],
    nation,
    mesoById,
    neighborsById,
    ownerByMesoId,
    occupationByMesoId,
    warAdjacency,
    instrumentation,
    new Set(friendlySide.influenceRegionIds),
  );
}

function buildRetreatMovementGroup(
  world: WorldState,
  retreat: RetreatPlan,
  units: UnitState[],
  nation: WorldState["nations"][number] | undefined,
  instrumentation?: SimulationInstrumentation,
): LandMovementGroup {
  const startedAt = instrumentation ? performance.now() : 0;
  const orderedUnits = [...units].sort(compareUnitIds);
  let assignmentCount = 0;
  let switchCount = 0;
  for (const unit of orderedUnits) {
    const targetId =
      retreat.unitTargetRegionIds.get(unit.id) ?? retreat.fallbackRegionIds[0];
    if (!targetId || unit.moveTargetId === targetId) {
      continue;
    }
    if (unit.moveTargetId) {
      switchCount += 1;
    }
    unit.moveTargetId = targetId;
    unit.moveFromId = null;
    unit.moveToId = null;
    unit.moveProgressMs = 0;
    assignmentCount += 1;
  }
  nation?.unitRoles.defenseUnitIds.push(...orderedUnits.map((unit) => unit.id));
  world.retreatPlans.targetAssignmentCount += assignmentCount;
  world.retreatPlans.unitTargetSwitchCount += switchCount;
  instrumentation?.incrementCounter("retreat.targetAssignments", assignmentCount);
  instrumentation?.incrementCounter("retreat.unitTargetSwitches", switchCount);
  if (instrumentation) {
    instrumentation.recordDuration(
      "retreat.targetAssignment",
      performance.now() - startedAt,
    );
  }
  return {
    nationId: retreat.nationId,
    units: orderedUnits,
    controlledOnly: true,
  };
}

function compareUnitIds(a: UnitState, b: UnitState): number {
  return a.id.localeCompare(b.id);
}

export function repositionNavalUnits(world: WorldState, dtMs: number): void {
  if (world.units.length === 0 || world.mesoRegions.length === 0) {
    return;
  }
  const navalUnits = world.units.filter((unit) => unit.domain === "naval");
  if (navalUnits.length === 0) {
    return;
  }

  const mesoById = getMesoById(world);
  const neighborsById = getNeighborsById(world);
  const ownerByMesoId = getOwnerByMesoId(world);

  for (const unit of navalUnits) {
    const current = mesoById.get(unit.regionId);
    if (!current || !isNavalNode(current, unit.nationId, ownerByMesoId)) {
      resetMovement(unit);
      continue;
    }

    if (!unit.moveTargetId || unit.regionId === unit.moveTargetId) {
      const target = pickNavalTarget(
        unit.regionId,
        unit.nationId,
        neighborsById,
        mesoById,
        ownerByMesoId,
        world.simRng,
      );
      unit.moveTargetId = target;
    }

    if (!unit.moveTargetId) {
      resetMovement(unit);
      continue;
    }

    moveUnitTowardTarget(
      unit,
      dtMs,
      neighborsById,
      (id) => {
        const meso = mesoById.get(id);
        return !!meso && isNavalNode(meso, unit.nationId, ownerByMesoId);
      },
      () => false,
    );
  }
}

function assignNationTargets(
  nationId: NationId,
  defenseUnits: UnitState[],
  occupationUnits: UnitState[],
  intrusionTargets: MesoRegionId[],
  liberationTargets: MesoRegionId[],
  borderTargets: MesoRegionId[],
  occupationTargets: MesoRegionId[],
  mesoById: Map<MesoRegionId, MesoRegion>,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  occupationByMesoId: Map<MesoRegionId, NationId>,
  warAdjacency: WarAdjacency,
  instrumentation?: SimulationInstrumentation,
  defenseRegionScope?: ReadonlySet<MesoRegionId>,
): UnitState[] {
  const defenseStartedAt = instrumentation ? performance.now() : 0;
  assignDefenseTargets(
    defenseUnits,
    nationId,
    intrusionTargets,
    liberationTargets,
    borderTargets,
    mesoById,
    neighborsById,
    ownerByMesoId,
    occupationByMesoId,
    warAdjacency,
    instrumentation,
    defenseRegionScope,
  );
  if (instrumentation) {
    instrumentation.recordDuration(
      "assignment.defense",
      performance.now() - defenseStartedAt,
    );
  }

  const attackStartedAt = instrumentation ? performance.now() : 0;
  assignOccupationTargets(
    occupationUnits,
    nationId,
    occupationTargets,
    mesoById,
    neighborsById,
    ownerByMesoId,
    warAdjacency,
    instrumentation,
  );
  if (instrumentation) {
    instrumentation.recordDuration(
      "assignment.attack",
      performance.now() - attackStartedAt,
    );
  }

  return [...defenseUnits, ...occupationUnits].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
}

function progressNationUnits(
  nationId: NationId,
  orderedUnits: UnitState[],
  dtMs: number,
  sharedPathFields: Map<string, SharedPathField>,
  mesoById: Map<MesoRegionId, MesoRegion>,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  occupationByMesoId: Map<MesoRegionId, NationId>,
  warAdjacency: WarAdjacency,
  isBlockedByEnemy: (toId: MesoRegionId) => boolean,
  controlledOnly: boolean,
  instrumentation?: SimulationInstrumentation,
): boolean {
  let orderInvalidated = false;
  for (const unit of orderedUnits) {
    const useWarPath =
      !controlledOnly &&
      shouldUseWarPath(
        unit,
        nationId,
        ownerByMesoId,
        occupationByMesoId,
        mesoById,
        warAdjacency,
      );
    orderInvalidated =
      moveUnitTowardTarget(
        unit,
        dtMs,
        neighborsById,
        (id) =>
          useWarPath
            ? isPassableForNation(id, nationId, mesoById, ownerByMesoId, warAdjacency)
            : controlledOnly
              ? isControlledPassable(
                  id,
                  nationId,
                  mesoById,
                  ownerByMesoId,
                  occupationByMesoId,
                )
              : isOwnedPassable(id, nationId, mesoById, ownerByMesoId),
        isBlockedByEnemy,
        instrumentation
          ? {
              nationId,
              pathMode: useWarPath ? "war" : "owned",
              sharedPathFields,
              instrumentation,
            }
          : {
              nationId,
              pathMode: useWarPath ? "war" : "owned",
              sharedPathFields,
            },
      ) || orderInvalidated;
  }
  return orderInvalidated;
}

function moveUnitTowardTarget(
  unit: UnitState,
  dtMs: number,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  isAllowed: (id: MesoRegionId) => boolean,
  isBlockedByEnemy: (toId: MesoRegionId) => boolean,
  pathContext?: SharedPathContext,
): boolean {
  if (!unit.moveTargetId || unit.regionId === unit.moveTargetId) {
    unit.moveFromId = null;
    unit.moveToId = null;
    unit.moveProgressMs = 0;
    return false;
  }

  if (!isAllowed(unit.regionId)) {
    unit.moveTargetId = null;
    unit.moveFromId = null;
    unit.moveToId = null;
    unit.moveProgressMs = 0;
    return true;
  }

  unit.moveProgressMs += dtMs;
  if (!ensureMoveLeg(unit, neighborsById, isAllowed, pathContext)) {
    unit.moveTargetId = null;
    unit.moveFromId = null;
    unit.moveToId = null;
    unit.moveProgressMs = 0;
    return true;
  }

  const moveMsPerRegion = getMoveMsPerRegion(unit);
  while (unit.moveProgressMs >= moveMsPerRegion) {
    const nextId = unit.moveToId ?? unit.regionId;
    unit.moveProgressMs -= moveMsPerRegion;
    const previousId = unit.regionId;
    unit.regionId = nextId;

    if (nextId !== previousId && isBlockedByEnemy(nextId)) {
      unit.regionId = previousId;
      unit.moveProgressMs = 0;
      return false;
    }
    if (nextId !== previousId) {
      pathContext?.instrumentation?.incrementCounter("movement.regionArrivals");
    }
    if (unit.regionId === unit.moveTargetId) {
      unit.moveFromId = null;
      unit.moveToId = null;
      unit.moveProgressMs = 0;
      return false;
    }

    unit.moveFromId = null;
    unit.moveToId = null;
    if (!ensureMoveLeg(unit, neighborsById, isAllowed, pathContext)) {
      unit.moveTargetId = null;
      unit.moveFromId = null;
      unit.moveToId = null;
      unit.moveProgressMs = 0;
      return true;
    }
  }
  return false;
}

function findNearestTarget(
  startId: MesoRegionId,
  targetSet: Set<MesoRegionId>,
  assignedTargets: Set<MesoRegionId>,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  isAllowed: (id: MesoRegionId) => boolean,
  instrumentation?: SimulationInstrumentation,
): MesoRegionId | null {
  const startedAt = instrumentation ? performance.now() : 0;
  if (!isAllowed(startId)) {
    recordPathfindingSearch(instrumentation, startedAt, 0, false);
    return null;
  }
  if (targetSet.has(startId) && !assignedTargets.has(startId)) {
    recordPathfindingSearch(instrumentation, startedAt, 1, true);
    return startId;
  }

  const queue: MesoRegionId[] = [startId];
  const visited = new Set<MesoRegionId>([startId]);
  let head = 0;

  while (head < queue.length) {
    const current = queue[head];
    head += 1;
    const neighbors = neighborsById.get(current) ?? [];
    for (const neighbor of neighbors) {
      if (visited.has(neighbor)) {
        continue;
      }
      if (!isAllowed(neighbor)) {
        continue;
      }
      if (targetSet.has(neighbor) && !assignedTargets.has(neighbor)) {
        recordPathfindingSearch(instrumentation, startedAt, visited.size + 1, true);
        return neighbor;
      }
      visited.add(neighbor);
      queue.push(neighbor);
    }
  }

  recordPathfindingSearch(instrumentation, startedAt, visited.size, false);
  return null;
}

function findNextStep(
  startId: MesoRegionId,
  targetId: MesoRegionId,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  isAllowed: (id: MesoRegionId) => boolean,
): MesoRegionId | null {
  const queue: MesoRegionId[] = [startId];
  const previous = new Map<MesoRegionId, MesoRegionId | null>();
  previous.set(startId, null);
  let head = 0;

  while (head < queue.length) {
    const current = queue[head];
    head += 1;
    const neighbors = neighborsById.get(current) ?? [];
    for (const neighbor of neighbors) {
      if (previous.has(neighbor)) {
        continue;
      }
      if (!isAllowed(neighbor)) {
        continue;
      }
      previous.set(neighbor, current);
      if (neighbor === targetId) {
        return resolveFirstStep(startId, targetId, previous);
      }
      queue.push(neighbor);
    }
  }

  return null;
}

function findSharedNextStep(
  startId: MesoRegionId,
  targetId: MesoRegionId,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  isAllowed: (id: MesoRegionId) => boolean,
  context: SharedPathContext,
): MesoRegionId | null {
  const instrumentation = context.instrumentation;
  instrumentation?.incrementCounter("pathfinding.shared.requests");
  const key = `${context.nationId}:${context.pathMode}:${targetId}`;
  let field = context.sharedPathFields.get(key);

  const cachedNextStep = field?.nextHopByRegion.get(startId);
  const cachedUnreachable = field?.unreachableRegions.has(startId) ?? false;
  if (field && cachedNextStep && isAllowed(cachedNextStep)) {
    instrumentation?.incrementCounter("pathfinding.shared.hits");
    context.sharedPathFields.delete(key);
    context.sharedPathFields.set(key, field);
    return cachedNextStep;
  }
  if (field && cachedUnreachable) {
    instrumentation?.incrementCounter("pathfinding.shared.hits");
    context.sharedPathFields.delete(key);
    context.sharedPathFields.set(key, field);
    return null;
  }
  instrumentation?.incrementCounter("pathfinding.shared.misses");
  if (field && cachedNextStep) {
    field.nextHopByRegion.delete(startId);
  }
  if (!field) {
    field = {
      targetId,
      nextHopByRegion: new Map(),
      unreachableRegions: new Set(),
    };
    context.sharedPathFields.set(key, field);
    instrumentation?.incrementCounter("pathfinding.shared.fieldsCreated");
  }

  const nextStep = findNextStepAndPopulateCache(
    startId,
    targetId,
    neighborsById,
    isAllowed,
    field,
    instrumentation,
  );
  context.sharedPathFields.delete(key);
  context.sharedPathFields.set(key, field);
  if (context.sharedPathFields.size > MAX_SHARED_PATH_FIELDS) {
    const oldestKey = context.sharedPathFields.keys().next().value;
    if (oldestKey) {
      context.sharedPathFields.delete(oldestKey);
    }
  }
  return nextStep;
}

function findNextStepAndPopulateCache(
  startId: MesoRegionId,
  targetId: MesoRegionId,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  isAllowed: (id: MesoRegionId) => boolean,
  field: SharedPathField,
  instrumentation?: SimulationInstrumentation,
): MesoRegionId | null {
  const startedAt = instrumentation ? performance.now() : 0;
  const queue: MesoRegionId[] = [startId];
  const previous = new Map<MesoRegionId, MesoRegionId | null>();
  previous.set(startId, null);
  let head = 0;
  while (head < queue.length) {
    const current = queue[head];
    head += 1;
    const neighbors = neighborsById.get(current) ?? [];
    for (const neighbor of neighbors) {
      if (previous.has(neighbor) || !isAllowed(neighbor)) {
        continue;
      }
      previous.set(neighbor, current);
      if (neighbor === targetId) {
        const path: MesoRegionId[] = [targetId];
        let pathNode: MesoRegionId | null = previous.get(targetId) ?? null;
        while (pathNode) {
          path.push(pathNode);
          pathNode = previous.get(pathNode) ?? null;
        }
        path.reverse();
        for (let i = 0; i < path.length - 1; i += 1) {
          field.nextHopByRegion.set(path[i], path[i + 1]);
        }
        instrumentation?.incrementCounter(
          "pathfinding.shared.entriesBuilt",
          Math.max(0, path.length - 1),
        );
        recordPathfindingSearch(
          instrumentation,
          startedAt,
          previous.size,
          true,
        );
        return path[1] ?? null;
      }
      queue.push(neighbor);
    }
  }
  field.unreachableRegions.add(startId);
  recordPathfindingSearch(instrumentation, startedAt, previous.size, false);
  return null;
}

function recordPathfindingSearch(
  instrumentation: SimulationInstrumentation | undefined,
  startedAt: number,
  exploredRegions: number,
  found: boolean,
): void {
  if (!instrumentation) {
    return;
  }
  instrumentation.recordDuration("pathfinding.bfs", performance.now() - startedAt);
  instrumentation.incrementCounter("pathfinding.bfs");
  instrumentation.incrementCounter("pathfinding.exploredRegions", exploredRegions);
  instrumentation.incrementCounter(
    found ? "pathfinding.bfsFound" : "pathfinding.bfsUnreachable",
  );
}

function ensureMoveLeg(
  unit: UnitState,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  isAllowed: (id: MesoRegionId) => boolean,
  context?: SharedPathContext,
): MesoRegionId | null {
  if (unit.moveFromId === unit.regionId && unit.moveToId) {
    if (isAllowed(unit.moveToId)) {
      return unit.moveToId;
    }
    unit.moveFromId = null;
    unit.moveToId = null;
  }

  const targetId = unit.moveTargetId;
  if (!targetId) {
    return null;
  }
  const nextStep = context
    ? findSharedNextStep(
        unit.regionId,
        targetId,
        neighborsById,
        isAllowed,
        context,
      )
    : findNextStep(unit.regionId, targetId, neighborsById, isAllowed);
  if (!nextStep) {
    return null;
  }

  unit.moveFromId = unit.regionId;
  unit.moveToId = nextStep;
  return nextStep;
}

function resolveFirstStep(
  startId: MesoRegionId,
  targetId: MesoRegionId,
  previous: Map<MesoRegionId, MesoRegionId | null>,
): MesoRegionId | null {
  let current: MesoRegionId = targetId;
  let prev = previous.get(current) ?? null;
  while (prev && prev !== startId) {
    current = prev;
    prev = previous.get(current) ?? null;
  }
  return prev === startId ? current : null;
}

function isNavalNode(
  meso: MesoRegion,
  nationId: NationId,
  ownerByMesoId: Map<MesoRegionId, NationId>,
): boolean {
  if (meso.type === "sea") {
    return true;
  }
  if (meso.building === "port") {
    return ownerByMesoId.get(meso.id) === nationId;
  }
  return false;
}

function collectCoastalSeaTiles(
  nationId: NationId,
  mesoById: Map<MesoRegionId, MesoRegion>,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
): MesoRegionId[] {
  const result = new Set<MesoRegionId>();

  for (const [mesoId, owner] of ownerByMesoId.entries()) {
    if (owner !== nationId) continue;

    const meso = mesoById.get(mesoId);
    if (!meso || meso.type === "sea") continue;

    const neighbors = neighborsById.get(mesoId) ?? [];
    for (const nId of neighbors) {
      const neighbor = mesoById.get(nId);
      if (neighbor?.type === "sea") {
        result.add(nId);
      }
    }
  }

  return [...result];
}

function pickNavalTarget(
  startId: MesoRegionId,
  nationId: NationId,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  mesoById: Map<MesoRegionId, MesoRegion>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  rng: SeededRng,
): MesoRegionId | null {
  // 1) Prefer seas adjacent to own land (coastal guard)
  const coastalSeaTiles = collectCoastalSeaTiles(
    nationId,
    mesoById,
    neighborsById,
    ownerByMesoId,
  );

  if (coastalSeaTiles.length > 0) {
    return coastalSeaTiles.length === 1
      ? coastalSeaTiles[0]
      : coastalSeaTiles[rng.nextInt(coastalSeaTiles.length)];
  }

  // 2) Fallback: previous local naval movement (adjacent navigable seas)
  const neighbors = neighborsById.get(startId) ?? [];
  const candidates: MesoRegionId[] = [];
  for (const neighborId of neighbors) {
    const neighbor = mesoById.get(neighborId);
    if (!neighbor) continue;
    if (!isNavalNode(neighbor, nationId, ownerByMesoId)) continue;
    candidates.push(neighborId);
  }

  if (candidates.length === 0) {
    return null;
  }

  return candidates.length === 1
    ? candidates[0]
    : candidates[rng.nextInt(candidates.length)];
}

function resetMovement(unit: UnitState): void {
  unit.moveTargetId = null;
  unit.moveFromId = null;
  unit.moveToId = null;
  unit.moveProgressMs = 0;
}

function isPassable(meso: MesoRegion): boolean {
  return meso.type !== "sea";
}

function collectOwnedTargets(
  nationId: NationId,
  mesoById: Map<MesoRegionId, MesoRegion>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
): MesoRegionId[] {
  const targets: MesoRegionId[] = [];
  for (const [mesoId, owner] of ownerByMesoId.entries()) {
    if (owner !== nationId) {
      continue;
    }
    const meso = mesoById.get(mesoId);
    if (meso && isPassable(meso)) {
      targets.push(mesoId);
    }
  }
  return targets;
}

function collectBuildingTargets(
  nationId: NationId,
  building: MesoRegionBuilding,
  mesoById: Map<MesoRegionId, MesoRegion>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
): MesoRegionId[] {
  const targets: MesoRegionId[] = [];
  for (const [mesoId, owner] of ownerByMesoId.entries()) {
    if (owner !== nationId) {
      continue;
    }
    const meso = mesoById.get(mesoId);
    if (!meso || !isPassable(meso)) {
      continue;
    }
    if (meso.building === building) {
      targets.push(mesoId);
    }
  }
  return targets;
}

function filterTargetsToScope(
  targets: MesoRegionId[],
  scope?: ReadonlySet<MesoRegionId>,
): MesoRegionId[] {
  return scope ? targets.filter((targetId) => scope.has(targetId)) : targets;
}

function collectIntrusionTargetsByNation(
  units: UnitState[],
  ownerByMesoId: Map<MesoRegionId, NationId>,
  mesoById: Map<MesoRegionId, MesoRegion>,
  warAdjacency: WarAdjacency,
): Map<NationId, MesoRegionId[]> {
  const targets = new Map<NationId, Set<MesoRegionId>>();
  for (const unit of units) {
    const owner = ownerByMesoId.get(unit.regionId);
    if (!owner || owner === unit.nationId) {
      continue;
    }
    if (!isAtWar(unit.nationId, owner, warAdjacency)) {
      continue;
    }
    const meso = mesoById.get(unit.regionId);
    if (!meso || !isPassable(meso)) {
      continue;
    }
    const set = targets.get(owner);
    if (set) {
      set.add(unit.regionId);
    } else {
      targets.set(owner, new Set([unit.regionId]));
    }
  }
  const result = new Map<NationId, MesoRegionId[]>();
  for (const [nationId, set] of targets.entries()) {
    result.set(nationId, [...set]);
  }
  return result;
}

function collectOccupationTargetsByNation(
  mesoRegions: MesoRegion[],
  ownerByMesoId: Map<MesoRegionId, NationId>,
  occupationByMesoId: Map<MesoRegionId, NationId>,
  warAdjacency: WarAdjacency,
): Map<NationId, MesoRegionId[]> {
  const targets = new Map<NationId, Set<MesoRegionId>>();
  for (const meso of mesoRegions) {
    if (!isPassable(meso)) {
      continue;
    }
    const owner = ownerByMesoId.get(meso.id);
    if (!owner) {
      continue;
    }
    if (occupationByMesoId.has(meso.id)) {
      continue;
    }
    const enemies = warAdjacency.get(owner);
    if (!enemies || enemies.size === 0) {
      continue;
    }
    for (const enemyId of enemies) {
      const set = targets.get(enemyId);
      if (set) {
        set.add(meso.id);
      } else {
        targets.set(enemyId, new Set([meso.id]));
      }
    }
  }
  const result = new Map<NationId, MesoRegionId[]>();
  for (const [nationId, set] of targets.entries()) {
    result.set(nationId, [...set]);
  }
  return result;
}

function assignDefenseTargets(
  units: UnitState[],
  nationId: NationId,
  intrusionTargets: MesoRegionId[],
  liberationTargets: MesoRegionId[],
  borderTargets: MesoRegionId[],
  mesoById: Map<MesoRegionId, MesoRegion>,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  occupationByMesoId: Map<MesoRegionId, NationId>,
  warAdjacency: WarAdjacency,
  instrumentation?: SimulationInstrumentation,
  regionScope?: ReadonlySet<MesoRegionId>,
): void {
  if (units.length === 0) {
    return;
  }
  if (regionScope) {
    assignScopedDefenseTargets(
      units,
      nationId,
      intrusionTargets,
      liberationTargets,
      borderTargets,
      regionScope,
      mesoById,
      ownerByMesoId,
    );
    return;
  }

  const intrusionList = selectTargetsForUnits(
    intrusionTargets,
    Math.min(units.length, intrusionTargets.length),
    mesoById,
    "even",
  );
  const intrusionSet = new Set(intrusionList);
  const liberationList = selectTargetsForUnits(
    liberationTargets,
    Math.min(units.length, liberationTargets.length),
    mesoById,
    "even",
  );
  const liberationSet = new Set(liberationList);
  const borderList = selectTargetsForUnits(
    borderTargets,
    Math.min(units.length, borderTargets.length),
    mesoById,
    "spread",
  );
  const borderSet = new Set(borderList);
  const ownedTargets = collectOwnedTargets(nationId, mesoById, ownerByMesoId);
  const capitalTargets = collectBuildingTargets(
    nationId,
    "capital",
    mesoById,
    ownerByMesoId,
  );
  const cityTargets = collectBuildingTargets(nationId, "city", mesoById, ownerByMesoId);

  if (
    intrusionSet.size === 0 &&
    liberationSet.size === 0 &&
    borderSet.size === 0 &&
    ownedTargets.length === 0
  ) {
    clearUnitMovement(units);
    return;
  }

  const orderedUnits = [...units].sort((a, b) => a.id.localeCompare(b.id));
  const assignedTargets = new Set<MesoRegionId>();
  let remainingUnits = orderedUnits;

  if (capitalTargets.length > 0 && remainingUnits.length > 0) {
    const capitalSet = new Set(capitalTargets);
    remainingUnits = keepExistingTargets(
      remainingUnits,
      capitalSet,
      assignedTargets,
      (id) => isOwnedPassable(id, nationId, mesoById, ownerByMesoId),
    );
    remainingUnits = assignUnitsOnTarget(remainingUnits, capitalSet, assignedTargets);
    remainingUnits = assignNearestTargets(
      remainingUnits,
      capitalSet,
      assignedTargets,
      neighborsById,
      (id) => isOwnedPassable(id, nationId, mesoById, ownerByMesoId),
      instrumentation,
    );
  }

  if (cityTargets.length > 0 && remainingUnits.length > 0) {
    const cityList = selectTargetsForUnits(
      cityTargets,
      Math.min(remainingUnits.length, cityTargets.length),
      mesoById,
      "even",
    );
    const citySet = new Set(cityList);
    remainingUnits = keepExistingTargets(
      remainingUnits,
      citySet,
      assignedTargets,
      (id) => isOwnedPassable(id, nationId, mesoById, ownerByMesoId),
    );
    remainingUnits = assignUnitsOnTarget(remainingUnits, citySet, assignedTargets);
    remainingUnits = assignNearestTargets(
      remainingUnits,
      citySet,
      assignedTargets,
      neighborsById,
      (id) => isOwnedPassable(id, nationId, mesoById, ownerByMesoId),
      instrumentation,
    );
  }

  if (intrusionSet.size > 0 && remainingUnits.length > 0) {
    remainingUnits = keepExistingTargets(
      remainingUnits,
      intrusionSet,
      assignedTargets,
      (id) => isOwnedPassable(id, nationId, mesoById, ownerByMesoId),
    );
    remainingUnits = assignUnitsOnTarget(remainingUnits, intrusionSet, assignedTargets);
    remainingUnits = assignNearestTargets(
      remainingUnits,
      intrusionSet,
      assignedTargets,
      neighborsById,
      (id) => isPassableForNation(id, nationId, mesoById, ownerByMesoId, warAdjacency),
      instrumentation,
    );
  }

  if (liberationSet.size > 0 && remainingUnits.length > 0) {
    remainingUnits = keepExistingTargets(
      remainingUnits,
      liberationSet,
      assignedTargets,
      (id) => isLiberationTarget(id, nationId, ownerByMesoId, occupationByMesoId, mesoById),
    );
    remainingUnits = assignUnitsOnTarget(remainingUnits, liberationSet, assignedTargets);
    remainingUnits = assignNearestTargets(
      remainingUnits,
      liberationSet,
      assignedTargets,
      neighborsById,
      (id) => isPassableForNation(id, nationId, mesoById, ownerByMesoId, warAdjacency),
      instrumentation,
    );
  }

  if (borderSet.size > 0 && remainingUnits.length > 0) {
    remainingUnits = keepExistingTargets(
      remainingUnits,
      borderSet,
      assignedTargets,
      (id) => isOwnedPassable(id, nationId, mesoById, ownerByMesoId),
    );
    remainingUnits = assignUnitsOnTarget(remainingUnits, borderSet, assignedTargets);
    remainingUnits = assignNearestTargets(
      remainingUnits,
      borderSet,
      assignedTargets,
      neighborsById,
      (id) => isOwnedPassable(id, nationId, mesoById, ownerByMesoId),
      instrumentation,
    );
  }

  if (ownedTargets.length > 0 && remainingUnits.length > 0) {
    const interiorTargets = selectTargetsForUnits(
      ownedTargets,
      Math.min(remainingUnits.length, ownedTargets.length),
      mesoById,
      "even",
    );
    const interiorSet = new Set(interiorTargets);
    remainingUnits = keepExistingTargets(
      remainingUnits,
      interiorSet,
      assignedTargets,
      (id) => isOwnedPassable(id, nationId, mesoById, ownerByMesoId),
    );
    remainingUnits = assignUnitsOnTarget(remainingUnits, interiorSet, assignedTargets);
    remainingUnits = assignNearestTargets(
      remainingUnits,
      interiorSet,
      assignedTargets,
      neighborsById,
      (id) => isOwnedPassable(id, nationId, mesoById, ownerByMesoId),
      instrumentation,
    );
  }

  if (remainingUnits.length > 0) {
    const stackTargets = pickDefenseStackTargets(
      intrusionTargets,
      liberationTargets,
      borderTargets,
      ownedTargets,
    );
    if (stackTargets.length > 0) {
      assignStackedTargets(remainingUnits, stackTargets);
      remainingUnits = [];
    }
  }

  clearUnitMovement(remainingUnits);
}

function assignScopedDefenseTargets(
  units: UnitState[],
  nationId: NationId,
  intrusionTargets: MesoRegionId[],
  liberationTargets: MesoRegionId[],
  borderTargets: MesoRegionId[],
  regionScope: ReadonlySet<MesoRegionId>,
  mesoById: Map<MesoRegionId, MesoRegion>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
): void {
  const capitalTargets = filterTargetsToScope(
    collectBuildingTargets(nationId, "capital", mesoById, ownerByMesoId),
    regionScope,
  );
  const cityTargets = filterTargetsToScope(
    collectBuildingTargets(nationId, "city", mesoById, ownerByMesoId),
    regionScope,
  );
  const ownedTargets = filterTargetsToScope(
    collectOwnedTargets(nationId, mesoById, ownerByMesoId),
    regionScope,
  );
  const tiers = [
    capitalTargets,
    cityTargets,
    intrusionTargets,
    liberationTargets,
    borderTargets,
    ownedTargets,
  ].map(uniqueSortedIds);
  const allTargets = new Set(tiers.flat());
  if (allTargets.size === 0) {
    clearUnitMovement(units);
    return;
  }

  const assignedTargets = new Set<MesoRegionId>();
  const remainingAfterExisting: UnitState[] = [];
  for (const unit of [...units].sort((a, b) => a.id.localeCompare(b.id))) {
    const targetId = unit.moveTargetId;
    if (targetId && allTargets.has(targetId) && !assignedTargets.has(targetId)) {
      assignedTargets.add(targetId);
    } else {
      remainingAfterExisting.push(unit);
    }
  }

  let remainingUnits = remainingAfterExisting;
  for (const targets of tiers) {
    if (remainingUnits.length === 0 || targets.length === 0) {
      continue;
    }
    const targetSet = new Set(targets);
    remainingUnits = assignUnitsOnTarget(
      remainingUnits,
      targetSet,
      assignedTargets,
    );
    remainingUnits = assignClosestTargetsByCenter(
      remainingUnits,
      targetSet,
      assignedTargets,
      mesoById,
    );
  }

  if (remainingUnits.length > 0) {
    const stackTargets = pickDefenseStackTargets(
      intrusionTargets,
      liberationTargets,
      borderTargets,
      ownedTargets,
    );
    assignStackedTargets(
      remainingUnits,
      stackTargets.length > 0 ? stackTargets : [...allTargets],
    );
  }
}

function assignClosestTargetsByCenter(
  units: UnitState[],
  targetSet: Set<MesoRegionId>,
  assignedTargets: Set<MesoRegionId>,
  mesoById: Map<MesoRegionId, MesoRegion>,
): UnitState[] {
  const remainingUnits: UnitState[] = [];
  for (const unit of units) {
    const candidates = [...targetSet].filter(
      (targetId) => !assignedTargets.has(targetId),
    );
    if (candidates.length === 0) {
      remainingUnits.push(unit);
      continue;
    }
    const unitCenter = mesoById.get(unit.regionId)?.center;
    const targetId = candidates.reduce((bestId, candidateId) => {
      if (!unitCenter) {
        return compareIds(candidateId, bestId) < 0 ? candidateId : bestId;
      }
      const bestCenter = mesoById.get(bestId)?.center ?? unitCenter;
      const candidateCenter = mesoById.get(candidateId)?.center ?? unitCenter;
      const bestDistance = distanceSq(unitCenter, bestCenter);
      const candidateDistance = distanceSq(unitCenter, candidateCenter);
      return candidateDistance < bestDistance ||
        (candidateDistance === bestDistance && compareIds(candidateId, bestId) < 0)
        ? candidateId
        : bestId;
    });
    if (unit.moveTargetId !== targetId) {
      unit.moveTargetId = targetId;
      unit.moveFromId = null;
      unit.moveToId = null;
      unit.moveProgressMs = 0;
    }
    assignedTargets.add(targetId);
  }
  return remainingUnits;
}

function uniqueSortedIds(ids: MesoRegionId[]): MesoRegionId[] {
  return [...new Set(ids)].sort(compareIds);
}

function assignOccupationTargets(
  units: UnitState[],
  nationId: NationId,
  occupationTargets: MesoRegionId[],
  mesoById: Map<MesoRegionId, MesoRegion>,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  warAdjacency: WarAdjacency,
  instrumentation?: SimulationInstrumentation,
): void {
  if (units.length === 0) {
    return;
  }
  if (occupationTargets.length === 0) {
    clearUnitMovement(units);
    return;
  }

  const targetSet = new Set(occupationTargets);
  const targetList = [...targetSet];
  if (targetSet.size === 0) {
    clearUnitMovement(units);
    return;
  }

  const orderedUnits = [...units].sort((a, b) => a.id.localeCompare(b.id));
  const assignedTargets = new Set<MesoRegionId>();
  let remainingUnits = orderedUnits;

  remainingUnits = keepExistingTargets(
    remainingUnits,
    targetSet,
    assignedTargets,
    (id) => isEnemyTarget(id, nationId, mesoById, ownerByMesoId, warAdjacency),
  );
  remainingUnits = assignUnitsOnTarget(remainingUnits, targetSet, assignedTargets);
  remainingUnits = assignNearestTargets(
    remainingUnits,
    targetSet,
    assignedTargets,
    neighborsById,
    (id) => isPassableForNation(id, nationId, mesoById, ownerByMesoId, warAdjacency),
    instrumentation,
  );

  if (remainingUnits.length > 0) {
    assignStackedTargets(remainingUnits, targetList);
    remainingUnits = [];
  }

  clearUnitMovement(remainingUnits);
}

function collectLiberationTargetsByNation(
  occupationByMesoId: Map<MesoRegionId, NationId>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  mesoById: Map<MesoRegionId, MesoRegion>,
): Map<NationId, MesoRegionId[]> {
  const result = new Map<NationId, MesoRegionId[]>();
  for (const [mesoId, occupier] of occupationByMesoId.entries()) {
    const owner = ownerByMesoId.get(mesoId);
    if (!owner || occupier === owner) {
      continue;
    }
    const meso = mesoById.get(mesoId);
    if (!meso || !isPassable(meso)) {
      continue;
    }
    const list = result.get(owner);
    if (list) {
      list.push(mesoId);
    } else {
      result.set(owner, [mesoId]);
    }
  }
  return result;
}

function pickDefenseStackTargets(
  intrusionTargets: MesoRegionId[],
  liberationTargets: MesoRegionId[],
  borderTargets: MesoRegionId[],
  ownedTargets: MesoRegionId[],
): MesoRegionId[] {
  if (intrusionTargets.length > 0) {
    return intrusionTargets;
  }
  if (liberationTargets.length > 0) {
    return liberationTargets;
  }
  if (borderTargets.length > 0) {
    return borderTargets;
  }
  return ownedTargets;
}

function determineDefenseUnitCount(
  totalUnits: number,
  intrusionCount: number,
  liberationCount: number,
  occupationCount: number,
): number {
  if (totalUnits <= 0) {
    return 0;
  }
  let ratio = 0.4;
  if (intrusionCount > 0) {
    ratio = 0.7;
  } else if (liberationCount > 0) {
    ratio = 0.6;
  } else if (occupationCount > 0) {
    ratio = 0.4;
  } else {
    ratio = 1;
  }
  const minCount = intrusionCount > 0 || liberationCount > 0 || occupationCount > 0 ? 1 : 0;
  return clamp(Math.round(totalUnits * ratio), minCount, totalUnits);
}

function clearUnitMovement(units: UnitState[]): void {
  for (const unit of units) {
    unit.moveTargetId = null;
    unit.moveFromId = null;
    unit.moveToId = null;
    unit.moveProgressMs = 0;
  }
}

function keepExistingTargets(
  units: UnitState[],
  targetSet: Set<MesoRegionId>,
  assignedTargets: Set<MesoRegionId>,
  isTargetStillValid: (id: MesoRegionId) => boolean,
): UnitState[] {
  const remaining: UnitState[] = [];
  for (const unit of units) {
    const targetId = unit.moveTargetId;
    if (!targetId) {
      remaining.push(unit);
      continue;
    }
    if (!targetSet.has(targetId)) {
      remaining.push(unit);
      continue;
    }
    if (!isTargetStillValid(targetId)) {
      remaining.push(unit);
      continue;
    }
    if (assignedTargets.has(targetId)) {
      remaining.push(unit);
      continue;
    }
    assignedTargets.add(targetId);
  }
  return remaining;
}

function assignUnitsOnTarget(
  units: UnitState[],
  targetSet: Set<MesoRegionId>,
  assignedTargets: Set<MesoRegionId>,
): UnitState[] {
  const remaining: UnitState[] = [];
  for (const unit of units) {
    if (targetSet.has(unit.regionId) && !assignedTargets.has(unit.regionId)) {
      unit.moveTargetId = unit.regionId;
      unit.moveFromId = null;
      unit.moveToId = null;
      assignedTargets.add(unit.regionId);
    } else {
      remaining.push(unit);
    }
  }
  return remaining;
}

function assignNearestTargets(
  units: UnitState[],
  targetSet: Set<MesoRegionId>,
  assignedTargets: Set<MesoRegionId>,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  isAllowed: (id: MesoRegionId) => boolean,
  instrumentation?: SimulationInstrumentation,
): UnitState[] {
  if (targetSet.size === 0 || assignedTargets.size >= targetSet.size) {
    return units;
  }

  const remaining: UnitState[] = [];
  for (const unit of units) {
    if (assignedTargets.size >= targetSet.size) {
      remaining.push(unit);
      continue;
    }
    const target = findNearestTarget(
      unit.regionId,
      targetSet,
      assignedTargets,
      neighborsById,
      isAllowed,
      instrumentation,
    );
    if (target) {
      unit.moveTargetId = target;
      assignedTargets.add(target);
    } else {
      remaining.push(unit);
    }
  }
  return remaining;
}

function assignStackedTargets(units: UnitState[], targets: MesoRegionId[]): void {
  const orderedTargets = [...targets].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (orderedTargets.length === 0) {
    return;
  }
  for (let i = 0; i < units.length; i += 1) {
    const unit = units[i];
    const nextTarget = orderedTargets[i % orderedTargets.length];
    if (unit.moveTargetId === nextTarget) {
      continue;
    }
    unit.moveTargetId = nextTarget;
    unit.moveFromId = null;
    unit.moveToId = null;
    unit.moveProgressMs = 0;
  }
}

function selectTargetsForUnits(
  targets: MesoRegionId[],
  unitCount: number,
  mesoById: Map<MesoRegionId, MesoRegion>,
  mode: "spread" | "even",
): MesoRegionId[] {
  if (unitCount <= 0) {
    return [];
  }

  const seen = new Set<MesoRegionId>();
  const uniqueTargets: MesoRegionId[] = [];
  for (const target of targets) {
    if (!seen.has(target)) {
      seen.add(target);
      uniqueTargets.push(target);
    }
  }

  if (uniqueTargets.length <= unitCount) {
    return uniqueTargets;
  }

  if (!hasAllCenters(uniqueTargets, mesoById)) {
    return selectEvenlyByIndex(uniqueTargets, unitCount);
  }

  if (mode === "even") {
    return selectEvenlyByAngle(uniqueTargets, unitCount, mesoById);
  }
  return selectSpreadByDistance(uniqueTargets, unitCount, mesoById);
}

function hasAllCenters(
  targets: MesoRegionId[],
  mesoById: Map<MesoRegionId, MesoRegion>,
): boolean {
  for (const target of targets) {
    if (!mesoById.get(target)) {
      return false;
    }
  }
  return true;
}

function selectSpreadByDistance(
  targets: MesoRegionId[],
  unitCount: number,
  mesoById: Map<MesoRegionId, MesoRegion>,
): MesoRegionId[] {
  // Farthest-point sampling with incremental distance updates.
  // Complexity: O(n * unitCount) instead of repeatedly re-scanning selected points.
  const n = targets.length;
  if (n === 0 || unitCount <= 0) {
    return [];
  }
  if (unitCount >= n) {
    return targets;
  }

  // Build center arrays (selectTargetsForUnits ensures centers exist when this is called).
  const xs = new Array<number>(n);
  const ys = new Array<number>(n);
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i += 1) {
    const id = targets[i];
    const meso = mesoById.get(id);
    const c = meso?.center;
    // Fallback to 0,0 if somehow missing; this keeps behavior safe.
    const x = c?.x ?? 0;
    const y = c?.y ?? 0;
    xs[i] = x;
    ys[i] = y;
    sumX += x;
    sumY += y;
  }

  const cx = sumX / n;
  const cy = sumY / n;

  // Pick the first point as farthest from centroid (tie-break by id).
  let firstIdx = 0;
  let bestDist = -1;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - cx;
    const dy = ys[i] - cy;
    const dist = dx * dx + dy * dy;
    if (dist > bestDist || (dist === bestDist && targets[i] < targets[firstIdx])) {
      bestDist = dist;
      firstIdx = i;
    }
  }

  const selected: MesoRegionId[] = [targets[firstIdx]];
  const picked = new Array<boolean>(n).fill(false);
  picked[firstIdx] = true;

  // Track each candidate's min distance to any selected point.
  const minDistToSelected = new Array<number>(n);
  for (let i = 0; i < n; i += 1) {
    if (picked[i]) {
      minDistToSelected[i] = 0;
      continue;
    }
    const dx = xs[i] - xs[firstIdx];
    const dy = ys[i] - ys[firstIdx];
    minDistToSelected[i] = dx * dx + dy * dy;
  }

  while (selected.length < unitCount) {
    // Choose the point maximizing minDistToSelected (tie-break by id).
    let bestIdx = -1;
    let bestMinDist = -1;
    for (let i = 0; i < n; i += 1) {
      if (picked[i]) {
        continue;
      }
      const d = minDistToSelected[i];
      if (d > bestMinDist) {
        bestMinDist = d;
        bestIdx = i;
      } else if (d === bestMinDist && bestIdx !== -1 && targets[i] < targets[bestIdx]) {
        bestIdx = i;
      }
    }

    if (bestIdx === -1) {
      break;
    }

    picked[bestIdx] = true;
    selected.push(targets[bestIdx]);

    // Incrementally update min distances with the newly selected point.
    const bx = xs[bestIdx];
    const by = ys[bestIdx];
    for (let i = 0; i < n; i += 1) {
      if (picked[i]) {
        continue;
      }
      const dx = xs[i] - bx;
      const dy = ys[i] - by;
      const d = dx * dx + dy * dy;
      if (d < minDistToSelected[i]) {
        minDistToSelected[i] = d;
      }
    }
  }

  return selected;
}

function selectEvenlyByIndex(
  targets: MesoRegionId[],
  unitCount: number,
): MesoRegionId[] {
  const step = targets.length / unitCount;
  const used = new Set<number>();
  const selected: MesoRegionId[] = [];

  for (let i = 0; i < unitCount; i += 1) {
    const raw = Math.floor((i + 0.5) * step);
    let index = clamp(raw, 0, targets.length - 1);
    while (used.has(index)) {
      index = (index + 1) % targets.length;
    }
    used.add(index);
    selected.push(targets[index]);
  }

  return selected;
}

function selectEvenlyByAngle(
  targets: MesoRegionId[],
  unitCount: number,
  mesoById: Map<MesoRegionId, MesoRegion>,
): MesoRegionId[] {
  const centers = new Map<MesoRegionId, { x: number; y: number }>();
  for (const target of targets) {
    const meso = mesoById.get(target);
    if (meso) {
      centers.set(target, meso.center);
    }
  }

  let sumX = 0;
  let sumY = 0;
  for (const center of centers.values()) {
    sumX += center.x;
    sumY += center.y;
  }
  const count = centers.size || 1;
  const centroid = { x: sumX / count, y: sumY / count };

  const ordered = targets
    .map((target) => {
      const center = centers.get(target) ?? centroid;
      const angle = Math.atan2(center.y - centroid.y, center.x - centroid.x);
      const radius = distanceSq(center, centroid);
      return { target, angle, radius };
    })
    .sort((a, b) => {
      if (a.angle !== b.angle) {
        return a.angle - b.angle;
      }
      if (a.radius !== b.radius) {
        return a.radius - b.radius;
      }
      return a.target < b.target ? -1 : a.target > b.target ? 1 : 0;
    })
    .map((entry) => entry.target);

  return selectEvenlyByIndex(ordered, unitCount);
}

function distanceSq(a: { x: number; y: number }, b: { x: number; y: number }): number {
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

function isOwnedPassable(
  id: MesoRegionId,
  nationId: NationId,
  mesoById: Map<MesoRegionId, MesoRegion>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
): boolean {
  if (ownerByMesoId.get(id) !== nationId) {
    return false;
  }
  const meso = mesoById.get(id);
  return !!meso && isPassable(meso);
}

function isControlledPassable(
  id: MesoRegionId,
  nationId: NationId,
  mesoById: Map<MesoRegionId, MesoRegion>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  occupationByMesoId: Map<MesoRegionId, NationId>,
): boolean {
  const controller = occupationByMesoId.get(id) ?? ownerByMesoId.get(id);
  if (controller !== nationId) {
    return false;
  }
  const meso = mesoById.get(id);
  return !!meso && isPassable(meso);
}

function isPassableForNation(
  id: MesoRegionId,
  nationId: NationId,
  mesoById: Map<MesoRegionId, MesoRegion>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  warAdjacency: WarAdjacency,
): boolean {
  const owner = ownerByMesoId.get(id);
  if (!owner) {
    return false;
  }
  const meso = mesoById.get(id);
  if (!meso || !isPassable(meso)) {
    return false;
  }
  if (owner === nationId) {
    return true;
  }
  return isAtWar(nationId, owner, warAdjacency);
}

function isEnemyTarget(
  id: MesoRegionId,
  nationId: NationId,
  mesoById: Map<MesoRegionId, MesoRegion>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  warAdjacency: WarAdjacency,
): boolean {
  const owner = ownerByMesoId.get(id);
  if (!owner || owner === nationId) {
    return false;
  }
  const meso = mesoById.get(id);
  if (!meso || !isPassable(meso)) {
    return false;
  }
  return isAtWar(nationId, owner, warAdjacency);
}

function isLiberationTarget(
  id: MesoRegionId,
  nationId: NationId,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  occupationByMesoId: Map<MesoRegionId, NationId>,
  mesoById: Map<MesoRegionId, MesoRegion>,
): boolean {
  const owner = ownerByMesoId.get(id);
  if (!owner || owner !== nationId) {
    return false;
  }
  const occupier = occupationByMesoId.get(id);
  if (!occupier || occupier === nationId) {
    return false;
  }
  const meso = mesoById.get(id);
  return !!meso && isPassable(meso);
}

function shouldUseWarPath(
  unit: UnitState,
  nationId: NationId,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  occupationByMesoId: Map<MesoRegionId, NationId>,
  mesoById: Map<MesoRegionId, MesoRegion>,
  warAdjacency: WarAdjacency,
): boolean {
  const targetId = unit.moveTargetId;
  if (targetId) {
    if (isEnemyTarget(targetId, nationId, mesoById, ownerByMesoId, warAdjacency)) {
      return true;
    }
    if (
      isLiberationTarget(targetId, nationId, ownerByMesoId, occupationByMesoId, mesoById)
    ) {
      return true;
    }
  }

  const owner = ownerByMesoId.get(unit.regionId);
  if (owner && owner !== nationId) {
    return isAtWar(nationId, owner, warAdjacency);
  }

  const occupier = occupationByMesoId.get(unit.regionId);
  if (occupier && occupier !== nationId) {
    return true;
  }

  return false;
}
