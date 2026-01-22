import type { WorldState } from "../world-state";
import type { UnitState } from "../unit";
import { MOVE_MS_PER_REGION } from "../movement";
import type { MesoRegion, MesoRegionId } from "../../worldgen/meso-region";
import type { NationId } from "../../worldgen/nation";

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
  const borderTargets = selectTargetsForUnits(
    targets,
    Math.min(units.length, targets.length),
    mesoById,
    "spread",
  );
  const borderTargetSet = new Set(borderTargets);
  const borderAllSet = new Set(targets);
  const ownedTargets = collectOwnedTargets(nationId, mesoById, ownerByMesoId);
  let interiorCandidates = ownedTargets.filter(
    (id) => !borderAllSet.has(id) && isCoastalById(id, mesoById),
  );
  if (interiorCandidates.length === 0) {
    interiorCandidates = ownedTargets.filter((id) => !borderAllSet.has(id));
  }
  if (interiorCandidates.length === 0) {
    interiorCandidates = ownedTargets;
  }
  const interiorTargetCount = Math.max(0, units.length - borderTargets.length);
  const interiorTargets = selectTargetsForUnits(
    interiorCandidates,
    interiorTargetCount,
    mesoById,
    "even",
  );
  const interiorTargetSet = new Set(interiorTargets);
  if (borderTargetSet.size === 0 && interiorTargetSet.size === 0) {
    for (const unit of units) {
      unit.moveTargetId = null;
      unit.moveFromId = null;
      unit.moveToId = null;
      unit.moveProgressMs = 0;
    }
    return;
  }

  const orderedUnits = [...units].sort((a, b) => a.id.localeCompare(b.id));
  const assignedTargets = new Set<MesoRegionId>();
  let remainingUnits = orderedUnits;

  remainingUnits = keepExistingTargets(
    remainingUnits,
    borderTargetSet,
    assignedTargets,
    nationId,
    ownerByMesoId,
  );
  remainingUnits = assignUnitsOnTarget(remainingUnits, borderTargetSet, assignedTargets);
  remainingUnits = assignNearestTargets(
    remainingUnits,
    borderTargetSet,
    assignedTargets,
    neighborsById,
    (id) => isOwnedPassable(id, nationId, mesoById, ownerByMesoId),
  );

  if (interiorTargetSet.size > 0 && remainingUnits.length > 0) {
    remainingUnits = keepExistingTargets(
      remainingUnits,
      interiorTargetSet,
      assignedTargets,
      nationId,
      ownerByMesoId,
    );
    remainingUnits = assignUnitsOnTarget(remainingUnits, interiorTargetSet, assignedTargets);
    remainingUnits = assignNearestTargets(
      remainingUnits,
      interiorTargetSet,
      assignedTargets,
      neighborsById,
      (id) => isOwnedPassable(id, nationId, mesoById, ownerByMesoId),
    );
  }

  if (remainingUnits.length > 0) {
    const stackTargets = pickStackTargets(interiorTargets, borderTargets, ownedTargets);
    if (stackTargets.length > 0) {
      assignStackedTargets(remainingUnits, stackTargets);
      remainingUnits = [];
    }
  }

  for (const unit of remainingUnits) {
    unit.moveTargetId = null;
    unit.moveFromId = null;
    unit.moveToId = null;
    unit.moveProgressMs = 0;
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

  while (unit.moveProgressMs >= MOVE_MS_PER_REGION) {
    unit.moveProgressMs -= MOVE_MS_PER_REGION;
    unit.regionId = unit.moveToId ?? unit.regionId;

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

function isPassable(meso: MesoRegion): boolean {
  return meso.type !== "sea";
}

function isCoastalById(
  id: MesoRegionId,
  mesoById: Map<MesoRegionId, MesoRegion>,
): boolean {
  const meso = mesoById.get(id);
  if (!meso || meso.type === "sea") {
    return false;
  }
  for (const neighbor of meso.neighbors) {
    const neighborMeso = mesoById.get(neighbor.id);
    if (neighborMeso && neighborMeso.type === "sea") {
      return true;
    }
  }
  return false;
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

function keepExistingTargets(
  units: UnitState[],
  targetSet: Set<MesoRegionId>,
  assignedTargets: Set<MesoRegionId>,
  nationId: NationId,
  ownerByMesoId: Map<MesoRegionId, NationId>,
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
    if (ownerByMesoId.get(targetId) !== nationId) {
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

function pickStackTargets(
  interiorTargets: MesoRegionId[],
  borderTargets: MesoRegionId[],
  ownedTargets: MesoRegionId[],
): MesoRegionId[] {
  if (interiorTargets.length > 0) {
    return interiorTargets;
  }
  if (borderTargets.length > 0) {
    return borderTargets;
  }
  return ownedTargets;
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

  let first = targets[0];
  let bestDist = -1;
  for (const target of targets) {
    const center = centers.get(target);
    if (!center) {
      continue;
    }
    const dist = distanceSq(center, centroid);
    if (dist > bestDist || (dist === bestDist && target < first)) {
      bestDist = dist;
      first = target;
    }
  }

  const selected: MesoRegionId[] = [first];
  const selectedSet = new Set<MesoRegionId>(selected);

  while (selected.length < unitCount) {
    let bestCandidate: MesoRegionId | null = null;
    let bestMinDist = -1;
    for (const target of targets) {
      if (selectedSet.has(target)) {
        continue;
      }
      const center = centers.get(target);
      if (!center) {
        continue;
      }
      let minDist = Number.POSITIVE_INFINITY;
      for (const chosen of selected) {
        const chosenCenter = centers.get(chosen);
        if (!chosenCenter) {
          continue;
        }
        minDist = Math.min(minDist, distanceSq(center, chosenCenter));
      }
      if (
        minDist > bestMinDist ||
        (minDist === bestMinDist && target < (bestCandidate ?? target))
      ) {
        bestMinDist = minDist;
        bestCandidate = target;
      }
    }
    if (!bestCandidate) {
      break;
    }
    selected.push(bestCandidate);
    selectedSet.add(bestCandidate);
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
