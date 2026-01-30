import type { MesoRegion, MesoRegionId } from "../../../worldgen/meso-region";
import { clamp, distanceSq } from "./math";

export function selectTargetsForUnits(
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

function selectEvenlyByIndex(targets: MesoRegionId[], unitCount: number): MesoRegionId[] {
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
