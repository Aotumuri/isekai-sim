import type { WorldConfig } from "../../data/world-config";
import { SeededRng } from "../../utils/seeded-rng";
import { buildMesoNeighbors } from "../build-meso-neighbors";
import { mergeRiverMesoRegions } from "../merge-river-meso-regions";
import type { MicroRegion, MicroRegionId } from "../micro-region";
import {
  createMesoRegionId,
  type MesoRegion,
  type MesoRegionType,
} from "../meso-region";

export function generateMesoRegions(
  microRegions: MicroRegion[],
  config: WorldConfig,
  rng: SeededRng,
): MesoRegion[] {
  const count = microRegions.length;
  if (count === 0) {
    return [];
  }

  const idToIndex = new Map<MicroRegionId, number>();
  for (let i = 0; i < count; i += 1) {
    const region = microRegions[i];
    idToIndex.set(region.id, i);
    region.mesoRegionId = null;
  }

  const neighborsByIndex = microRegions.map((region) => {
    const neighbors: number[] = [];
    for (const neighborId of region.neighbors) {
      const neighborIndex = idToIndex.get(neighborId);
      if (neighborIndex !== undefined) {
        neighbors.push(neighborIndex);
      }
    }
    shuffleInPlace(neighbors, rng);
    return neighbors;
  });

  const typeByIndex = microRegions.map((region) => getMesoType(region));
  const candidatesByType: Record<MesoRegionType, number[]> = {
    land: [],
    sea: [],
    river: [],
  };

  for (let i = 0; i < count; i += 1) {
    candidatesByType[typeByIndex[i]].push(i);
  }

  const mesoRegions: MesoRegion[] = [];
  const assigned = new Array<boolean>(count).fill(false);
  const regionIndexByMicroIndex = new Array<number | null>(count).fill(null);

  const floodFill = (queue: number[], type: MesoRegionType): void => {
    while (queue.length > 0) {
      const currentIndex = queue.shift();
      if (currentIndex === undefined) {
        break;
      }

      const currentRegionIndex = regionIndexByMicroIndex[currentIndex];
      if (currentRegionIndex === null) {
        continue;
      }

      for (const neighborIndex of neighborsByIndex[currentIndex]) {
        if (assigned[neighborIndex]) {
          continue;
        }
        if (typeByIndex[neighborIndex] !== type) {
          continue;
        }

        assigned[neighborIndex] = true;
        regionIndexByMicroIndex[neighborIndex] = currentRegionIndex;
        const mesoRegion = mesoRegions[currentRegionIndex];
        const microRegion = microRegions[neighborIndex];
        microRegion.mesoRegionId = mesoRegion.id;
        mesoRegion.microRegionIds.push(microRegion.id);
        queue.push(neighborIndex);
      }
    }
  };

  const fillType = (type: MesoRegionType, centerCount: number): void => {
    const candidates = candidatesByType[type];
    if (candidates.length === 0 || centerCount <= 0) {
      return;
    }

    const centers = pickRandomIndices(candidates, centerCount, rng);
    const queue: number[] = [];
    for (const centerIndex of centers) {
      if (assigned[centerIndex]) {
        continue;
      }

      const regionIndex = createRegion(centerIndex, type, mesoRegions, microRegions);
      assigned[centerIndex] = true;
      regionIndexByMicroIndex[centerIndex] = regionIndex;
      queue.push(centerIndex);
    }

    floodFill(queue, type);

    for (const index of candidates) {
      if (assigned[index]) {
        continue;
      }

      const regionIndex = createRegion(index, type, mesoRegions, microRegions);
      assigned[index] = true;
      regionIndexByMicroIndex[index] = regionIndex;
      queue.length = 0;
      queue.push(index);
      floodFill(queue, type);
    }
  };

  fillType(
    "land",
    computeCenterCount(
      candidatesByType.land.length,
      config.mesoLandCenterRatio,
      config.mesoMinCenterCount,
    ),
  );
  fillType(
    "sea",
    computeCenterCount(
      candidatesByType.sea.length,
      config.mesoSeaCenterRatio,
      config.mesoMinCenterCount,
    ),
  );
  fillType(
    "river",
    computeCenterCount(
      candidatesByType.river.length,
      config.mesoRiverCenterRatio,
      config.mesoMinCenterCount,
    ),
  );

  mergeRiverMesoRegions(microRegions, mesoRegions, neighborsByIndex, idToIndex);
  const mergedMesoRegions = mesoRegions.filter((region) => region.microRegionIds.length > 0);
  const neighborsById = buildMesoNeighbors(mergedMesoRegions, microRegions, neighborsByIndex);
  for (const region of mergedMesoRegions) {
    region.neighbors = neighborsById.get(region.id) ?? [];
  }

  return mergedMesoRegions;
}

function getMesoType(region: MicroRegion): MesoRegionType {
  if (region.isSea) {
    return "sea";
  }
  if (region.isRiver) {
    return "river";
  }
  return "land";
}

function createRegion(
  centerIndex: number,
  type: MesoRegionType,
  mesoRegions: MesoRegion[],
  microRegions: MicroRegion[],
): number {
  const centerRegion = microRegions[centerIndex];
  const region: MesoRegion = {
    id: createMesoRegionId(mesoRegions.length),
    type,
    centerId: centerRegion.id,
    microRegionIds: [centerRegion.id],
    neighbors: [],
    building: null,
  };
  mesoRegions.push(region);
  centerRegion.mesoRegionId = region.id;
  return mesoRegions.length - 1;
}

function computeCenterCount(count: number, ratio: number, minCount: number): number {
  if (count <= 0) {
    return 0;
  }
  const target = Math.floor(count * Math.max(0, ratio));
  return Math.min(count, Math.max(minCount, target));
}

function pickRandomIndices(candidates: number[], count: number, rng: SeededRng): number[] {
  const shuffled = [...candidates];
  shuffleInPlace(shuffled, rng);
  return shuffled.slice(0, Math.min(count, shuffled.length));
}

function shuffleInPlace(values: number[], rng: SeededRng): void {
  for (let i = values.length - 1; i > 0; i -= 1) {
    const j = rng.nextInt(i + 1);
    [values[i], values[j]] = [values[j], values[i]];
  }
}
