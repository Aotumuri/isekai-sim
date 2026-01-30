import { getMoveMsPerRegion } from "../movement";
import type { UnitState } from "../unit";
import type { MesoRegionId } from "../../worldgen/meso-region";

export function moveUnitTowardTarget(
  unit: UnitState,
  dtMs: number,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  isAllowed: (id: MesoRegionId) => boolean,
  isBlockedByEnemy: (toId: MesoRegionId) => boolean,
): void {
  if (!unit.moveTargetId || unit.regionId === unit.moveTargetId) {
    unit.moveFromId = null;
    unit.moveToId = null;
    unit.moveProgressMs = 0;
    return;
  }

  if (!isAllowed(unit.regionId)) {
    unit.moveTargetId = null;
    unit.moveFromId = null;
    unit.moveToId = null;
    unit.moveProgressMs = 0;
    return;
  }

  unit.moveProgressMs += dtMs;
  if (!ensureMoveLeg(unit, neighborsById, isAllowed)) {
    unit.moveTargetId = null;
    unit.moveFromId = null;
    unit.moveToId = null;
    unit.moveProgressMs = 0;
    return;
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
      return;
    }

    if (unit.regionId === unit.moveTargetId) {
      unit.moveFromId = null;
      unit.moveToId = null;
      unit.moveProgressMs = 0;
      return;
    }

    unit.moveFromId = null;
    unit.moveToId = null;
    if (!ensureMoveLeg(unit, neighborsById, isAllowed)) {
      unit.moveTargetId = null;
      unit.moveFromId = null;
      unit.moveToId = null;
      unit.moveProgressMs = 0;
      return;
    }
  }
}

export function findNearestTarget(
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

export function resetMovement(unit: UnitState): void {
  unit.moveTargetId = null;
  unit.moveFromId = null;
  unit.moveToId = null;
  unit.moveProgressMs = 0;
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

function ensureMoveLeg(
  unit: UnitState,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  isAllowed: (id: MesoRegionId) => boolean,
): MesoRegionId | null {
  if (unit.moveFromId === unit.regionId && unit.moveToId) {
    if (isAllowed(unit.moveToId)) {
      return unit.moveToId;
    }
    unit.moveFromId = null;
    unit.moveToId = null;
  }

  const nextStep = findNextStep(unit.regionId, unit.moveTargetId, neighborsById, isAllowed);
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
