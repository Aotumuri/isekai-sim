import type { WorldState } from "../world-state";
import type { UnitState } from "../unit";
import type { MesoRegion, MesoRegionId } from "../../worldgen/meso-region";
import type { NationId } from "../../worldgen/nation";

const MOVE_MS_PER_REGION = 600;

export function repositionUnits(world: WorldState, dtMs: number): void {
  if (world.units.length === 0 || world.mesoRegions.length === 0) {
    return;
  }

  const mesoById = new Map<MesoRegionId, MesoRegion>();
  const neighborsById = new Map<MesoRegionId, MesoRegionId[]>();
  for (const meso of world.mesoRegions) {
    mesoById.set(meso.id, meso);
    neighborsById.set(
      meso.id,
      meso.neighbors.map((neighbor) => neighbor.id),
    );
  }

  const ownerByMesoId = new Map<MesoRegionId, NationId>();
  for (const macro of world.macroRegions) {
    for (const mesoId of macro.mesoRegionIds) {
      ownerByMesoId.set(mesoId, macro.nationId);
    }
  }

  const borderByNationId = new Map<NationId, MesoRegionId[]>();
  for (const meso of world.mesoRegions) {
    if (!isPassable(meso)) {
      continue;
    }
    const owner = ownerByMesoId.get(meso.id);
    if (!owner) {
      continue;
    }

    for (const neighbor of meso.neighbors) {
      const neighborOwner = ownerByMesoId.get(neighbor.id);
      if (neighborOwner && neighborOwner !== owner) {
        const list = borderByNationId.get(owner);
        if (list) {
          list.push(meso.id);
        } else {
          borderByNationId.set(owner, [meso.id]);
        }
        break;
      }
    }
  }

  const unitsByNation = new Map<NationId, UnitState[]>();
  for (const unit of world.units) {
    const list = unitsByNation.get(unit.nationId);
    if (list) {
      list.push(unit);
    } else {
      unitsByNation.set(unit.nationId, [unit]);
    }
  }

  for (const [nationId, units] of unitsByNation.entries()) {
    const targets = borderByNationId.get(nationId) ?? [];
    repositionNationUnits(
      nationId,
      units,
      targets,
      dtMs,
      mesoById,
      neighborsById,
      ownerByMesoId,
    );
  }
}

function repositionNationUnits(
  nationId: NationId,
  units: UnitState[],
  targets: MesoRegionId[],
  dtMs: number,
  mesoById: Map<MesoRegionId, MesoRegion>,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
): void {
  const targetSet = new Set(targets);
  if (targetSet.size === 0) {
    for (const unit of units) {
      unit.moveTargetId = null;
      unit.moveProgressMs = 0;
    }
    return;
  }

  const orderedUnits = [...units].sort((a, b) => a.id.localeCompare(b.id));
  const assignedTargets = new Set<MesoRegionId>();

  for (const unit of orderedUnits) {
    if (!unit.moveTargetId) {
      continue;
    }
    if (!targetSet.has(unit.moveTargetId)) {
      unit.moveTargetId = null;
      continue;
    }
    if (ownerByMesoId.get(unit.moveTargetId) !== nationId) {
      unit.moveTargetId = null;
      continue;
    }
    if (assignedTargets.has(unit.moveTargetId)) {
      unit.moveTargetId = null;
      continue;
    }
    assignedTargets.add(unit.moveTargetId);
  }

  for (const unit of orderedUnits) {
    if (unit.moveTargetId) {
      continue;
    }
    if (targetSet.has(unit.regionId) && !assignedTargets.has(unit.regionId)) {
      unit.moveTargetId = unit.regionId;
      assignedTargets.add(unit.regionId);
    }
  }

  for (const unit of orderedUnits) {
    if (unit.moveTargetId) {
      continue;
    }
    const target = findNearestTarget(
      unit.regionId,
      targetSet,
      assignedTargets,
      neighborsById,
      (id) => isOwnedPassable(id, nationId, mesoById, ownerByMesoId),
    );
    if (target) {
      unit.moveTargetId = target;
      assignedTargets.add(target);
    }
  }

  for (const unit of orderedUnits) {
    moveUnitTowardTarget(
      unit,
      dtMs,
      neighborsById,
      (id) => isOwnedPassable(id, nationId, mesoById, ownerByMesoId),
    );
  }
}

function moveUnitTowardTarget(
  unit: UnitState,
  dtMs: number,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  isAllowed: (id: MesoRegionId) => boolean,
): void {
  if (!unit.moveTargetId || unit.regionId === unit.moveTargetId) {
    unit.moveProgressMs = 0;
    return;
  }

  if (!isAllowed(unit.regionId)) {
    unit.moveTargetId = null;
    unit.moveProgressMs = 0;
    return;
  }

  unit.moveProgressMs += dtMs;
  while (unit.moveProgressMs >= MOVE_MS_PER_REGION) {
    const nextStep = findNextStep(
      unit.regionId,
      unit.moveTargetId,
      neighborsById,
      isAllowed,
    );
    if (!nextStep) {
      unit.moveTargetId = null;
      unit.moveProgressMs = 0;
      return;
    }

    unit.regionId = nextStep;
    unit.moveProgressMs -= MOVE_MS_PER_REGION;
    if (unit.regionId === unit.moveTargetId) {
      unit.moveProgressMs = 0;
      return;
    }
  }
}

function findNearestTarget(
  startId: MesoRegionId,
  targetSet: Set<MesoRegionId>,
  assignedTargets: Set<MesoRegionId>,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  isAllowed: (id: MesoRegionId) => boolean,
): MesoRegionId | null {
  if (!isAllowed(startId)) {
    return null;
  }
  if (targetSet.has(startId) && !assignedTargets.has(startId)) {
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
        return neighbor;
      }
      visited.add(neighbor);
      queue.push(neighbor);
    }
  }

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

function isPassable(meso: MesoRegion): boolean {
  return meso.type !== "sea";
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
