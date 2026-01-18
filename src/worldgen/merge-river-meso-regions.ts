import type { MicroRegion, MicroRegionId } from "./micro-region";
import type { MesoRegion } from "./meso-region";

export function mergeRiverMesoRegions(
  microRegions: MicroRegion[],
  mesoRegions: MesoRegion[],
  neighborsByIndex: number[][],
  idToIndex: Map<MicroRegionId, number>,
): void {
  const mesoById = new Map<MesoRegion["id"], MesoRegion>();
  for (const region of mesoRegions) {
    mesoById.set(region.id, region);
  }

  let merged = true;
  while (merged) {
    merged = false;

    for (const riverRegion of mesoRegions) {
      if (riverRegion.type !== "river" || riverRegion.microRegionIds.length === 0) {
        continue;
      }

      const target = pickRiverMergeTarget(
        riverRegion,
        microRegions,
        neighborsByIndex,
        idToIndex,
        mesoById,
      );
      if (!target) {
        continue;
      }

      for (const microId of riverRegion.microRegionIds) {
        const index = idToIndex.get(microId);
        if (index === undefined) {
          continue;
        }
        microRegions[index].mesoRegionId = target.id;
        target.microRegionIds.push(microId);
      }
      riverRegion.microRegionIds = [];
      merged = true;
    }
  }
}

function pickRiverMergeTarget(
  riverRegion: MesoRegion,
  microRegions: MicroRegion[],
  neighborsByIndex: number[][],
  idToIndex: Map<MicroRegionId, number>,
  mesoById: Map<MesoRegion["id"], MesoRegion>,
): MesoRegion | null {
  const neighborCounts = new Map<MesoRegion["id"], number>();

  for (const microId of riverRegion.microRegionIds) {
    const index = idToIndex.get(microId);
    if (index === undefined) {
      continue;
    }

    for (const neighborIndex of neighborsByIndex[index]) {
      const neighborMesoId = microRegions[neighborIndex].mesoRegionId;
      if (!neighborMesoId || neighborMesoId === riverRegion.id) {
        continue;
      }

      const neighborRegion = mesoById.get(neighborMesoId);
      if (!neighborRegion || neighborRegion.microRegionIds.length === 0) {
        continue;
      }
      if (neighborRegion.type === "river") {
        continue;
      }

      neighborCounts.set(neighborMesoId, (neighborCounts.get(neighborMesoId) ?? 0) + 1);
    }
  }

  let bestId: MesoRegion["id"] | null = null;
  let bestCount = -1;
  for (const [neighborId, count] of neighborCounts.entries()) {
    if (count > bestCount || (count === bestCount && neighborId < (bestId ?? neighborId))) {
      bestId = neighborId;
      bestCount = count;
    }
  }

  return bestId ? mesoById.get(bestId) ?? null : null;
}
