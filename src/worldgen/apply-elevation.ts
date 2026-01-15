import type { WorldConfig } from "../data/world-config";
import { clamp } from "../utils/math";
import { SeededRng } from "../utils/seeded-rng";
import type { MicroRegion, MicroRegionId } from "./micro-region";

export function applyElevation(
  microRegions: MicroRegion[],
  config: WorldConfig,
  rng: SeededRng,
): void {
  const count = microRegions.length;
  if (count === 0) {
    return;
  }

  const idToIndex = new Map<MicroRegionId, number>();
  for (let i = 0; i < count; i += 1) {
    idToIndex.set(microRegions[i].id, i);
    microRegions[i].elevation = config.elevationSeaLevel;
  }

  const seedCount = Math.min(count, Math.max(2, Math.floor(count * config.elevationSeedRatio)));
  const seedIndices = pickUniqueIndices(count, seedCount, rng);
  const assigned = new Array(count).fill(false);
  let frontier: number[] = [];

  for (const index of seedIndices) {
    microRegions[index].elevation = pickSeedElevation(config, rng);
    assigned[index] = true;
    frontier.push(index);
  }

  while (frontier.length > 0) {
    const nextFrontier: number[] = [];
    for (const currentIndex of frontier) {
      const currentElevation = microRegions[currentIndex].elevation;
      if (currentElevation <= 0) {
        continue;
      }

      const nextBase = currentElevation - config.elevationFalloff;
      for (const neighborId of microRegions[currentIndex].neighbors) {
        const neighborIndex = idToIndex.get(neighborId);
        if (neighborIndex === undefined || assigned[neighborIndex]) {
          continue;
        }

        const drop = rng.range(0, config.elevationSpread);
        const nextElevation = clamp(
          nextBase - drop,
          config.elevationRange.min,
          config.elevationRange.max,
        );

        microRegions[neighborIndex].elevation = nextElevation;
        assigned[neighborIndex] = true;
        if (nextElevation > 0) {
          nextFrontier.push(neighborIndex);
        }
      }
    }
    frontier = nextFrontier;
  }

  for (let i = 0; i < count; i += 1) {
    if (!assigned[i]) {
      microRegions[i].elevation = config.elevationSeaLevel;
    }
  }
}

function pickUniqueIndices(count: number, target: number, rng: SeededRng): number[] {
  const indices = new Set<number>();
  while (indices.size < target) {
    indices.add(rng.nextInt(count));
  }

  return Array.from(indices);
}

function pickSeedElevation(config: WorldConfig, rng: SeededRng): number {
  return rng.range(config.elevationLandRange.min, config.elevationLandRange.max);
}
