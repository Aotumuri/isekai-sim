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
    microRegions[i].elevation = 0;
  }

  const seedCount = Math.min(count, Math.max(2, Math.floor(count * config.elevationSeedRatio)));
  const seedIndices = pickUniqueIndices(count, seedCount, rng);
  const assigned = new Array(count).fill(false);
  const queue: number[] = [];

  for (const index of seedIndices) {
    microRegions[index].elevation = pickSeedElevation(config, rng);
    assigned[index] = true;
    queue.push(index);
  }

  let head = 0;
  while (head < queue.length) {
    const currentIndex = queue[head];
    head += 1;

    const currentElevation = microRegions[currentIndex].elevation;
    for (const neighborId of microRegions[currentIndex].neighbors) {
      const neighborIndex = idToIndex.get(neighborId);
      if (neighborIndex === undefined || assigned[neighborIndex]) {
        continue;
      }

      const drift = rng.range(-config.elevationSpread, config.elevationSpread);
      const nextElevation = clamp(
        currentElevation * (1 - config.elevationFalloff) + drift,
        config.elevationRange.min,
        config.elevationRange.max,
      );

      microRegions[neighborIndex].elevation = nextElevation;
      assigned[neighborIndex] = true;
      queue.push(neighborIndex);
    }
  }

  for (let i = 0; i < count; i += 1) {
    if (!assigned[i]) {
      microRegions[i].elevation = 0;
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
  if (rng.nextFloat() < config.elevationSeaSeedRatio) {
    return rng.range(config.elevationSeaRange.min, config.elevationSeaRange.max);
  }

  return rng.range(config.elevationLandRange.min, config.elevationLandRange.max);
}
