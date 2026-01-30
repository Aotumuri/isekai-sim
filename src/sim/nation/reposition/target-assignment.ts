import type { UnitState } from "../../unit";
import type { MesoRegion, MesoRegionId } from "../../../worldgen/meso-region";
import type { NationId } from "../../../worldgen/nation";
import type { WarAdjacency } from "../../war-state";
import { findNearestTarget } from "./movement-engine";
import { collectBuildingTargets, collectOwnedTargets } from "./target-collectors";
import { selectTargetsForUnits } from "./target-selection";
import {
  isEnemyTarget,
  isLiberationTarget,
  isOwnedPassable,
  isPassableForNation,
} from "./passability";

export function assignDefenseTargets(
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
): void {
  if (units.length === 0) {
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

export function assignOccupationTargets(
  units: UnitState[],
  nationId: NationId,
  occupationTargets: MesoRegionId[],
  mesoById: Map<MesoRegionId, MesoRegion>,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  warAdjacency: WarAdjacency,
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
  );

  if (remainingUnits.length > 0) {
    assignStackedTargets(remainingUnits, targetList);
    remainingUnits = [];
  }

  clearUnitMovement(remainingUnits);
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
