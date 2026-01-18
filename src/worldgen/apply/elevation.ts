import type { WorldConfig } from "../../data/world-config";
import { clamp } from "../../utils/math";
import { SeededRng } from "../../utils/seeded-rng";
import type { MicroRegion, MicroRegionId } from "../micro-region";

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

  const neighborsByIndex = microRegions.map((region) => {
    const neighbors: number[] = [];
    for (const neighborId of region.neighbors) {
      const neighborIndex = idToIndex.get(neighborId);
      if (neighborIndex !== undefined) {
        neighbors.push(neighborIndex);
      }
    }
    return neighbors;
  });

  const assigned = new Array(count).fill(false);
  let frontier: number[] = [];
  const ridgeCount = clampInt(Math.round(config.elevationRidgeCount), 1, 3);
  const ridgeLength = Math.min(
    count,
    Math.max(8, Math.floor(count * Math.max(0, config.elevationRidgeLengthRatio))),
  );
  const ridgeInertia = clamp(config.elevationRidgeInertia, 0, 1);
  const centerScores = buildCenterScores(microRegions, config);
  const edgeScores = buildEdgeScores(microRegions, config);
  const startWeights = buildRidgeStartWeights(centerScores, edgeScores, config);
  const smoothingStrength = clamp(config.elevationSmoothingStrength, 0, 1);


  for (let ridgeIndex = 0; ridgeIndex < ridgeCount; ridgeIndex += 1) {
    const startIndex = pickWeightedIndex(count, rng, (index) =>
      assigned[index] ? 0 : startWeights[index],
    );
    if (startIndex === undefined) {
      break;
    }

    const ridgePath = buildRidgePath(
      startIndex,
      ridgeLength,
      neighborsByIndex,
      microRegions,
      rng,
      ridgeInertia,
      edgeScores,
      config.elevationEdgeAvoidStrength,
      assigned,
    );

    for (const index of ridgePath) {
      if (assigned[index]) {
        continue;
      }

      microRegions[index].elevation = pickRidgeElevation(config, rng);
      assigned[index] = true;
      frontier.push(index);
    }
  }

  while (frontier.length > 0) {
    const nextFrontier: number[] = [];
    for (const currentIndex of frontier) {
      const currentElevation = microRegions[currentIndex].elevation;
      if (currentElevation <= 0) {
        continue;
      }

      const nextBase = currentElevation - config.elevationFalloff;
      for (const neighborIndex of neighborsByIndex[currentIndex]) {
        if (assigned[neighborIndex]) {
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

  applyElevationSmoothing(microRegions, neighborsByIndex, smoothingStrength, config.elevationRange);
}

function buildCenterScores(microRegions: MicroRegion[], config: WorldConfig): number[] {
  const centerX = config.width * 0.5;
  const centerY = config.height * 0.5;
  const maxCenterDist = Math.hypot(centerX, centerY);

  return microRegions.map((region) => {
    const { x, y } = region.site;
    const distToCenter = Math.hypot(x - centerX, y - centerY);
    return maxCenterDist > 0 ? 1 - clamp(distToCenter / maxCenterDist, 0, 1) : 0.5;
  });
}

function buildEdgeScores(microRegions: MicroRegion[], config: WorldConfig): number[] {
  const centerX = config.width * 0.5;
  const centerY = config.height * 0.5;
  const maxEdgeDist = Math.min(centerX, centerY);

  return microRegions.map((region) => {
    const { x, y } = region.site;
    const distToEdge = Math.min(x, config.width - x, y, config.height - y);
    return maxEdgeDist > 0 ? clamp(distToEdge / maxEdgeDist, 0, 1) : 0.5;
  });
}

function buildRidgeStartWeights(
  centerScores: number[],
  edgeScores: number[],
  config: WorldConfig,
): number[] {
  const centerBias = clamp(config.elevationCenterBiasStrength, 0, 1);
  const edgeAvoid = clamp(config.elevationEdgeAvoidStrength, 0, 1);

  return centerScores.map((centerScore, index) => {
    const edgeScore = edgeScores[index] ?? 0.5;
    const centerWeight = 1 + centerBias * centerScore;
    const edgeWeight = (1 - edgeAvoid) + edgeAvoid * edgeScore;
    return Math.max(0.001, centerWeight * edgeWeight);
  });
}

function pickWeightedIndex(
  count: number,
  rng: SeededRng,
  weightForIndex: (index: number) => number,
): number | undefined {
  const weights = new Array<number>(count);
  let total = 0;
  for (let i = 0; i < count; i += 1) {
    const weight = Math.max(0, weightForIndex(i));
    weights[i] = weight;
    total += weight;
  }

  if (total <= 0) {
    return undefined;
  }

  let roll = rng.nextFloat() * total;
  for (let i = 0; i < count; i += 1) {
    roll -= weights[i];
    if (roll <= 0) {
      return i;
    }
  }

  return undefined;
}

function buildRidgePath(
  startIndex: number,
  maxLength: number,
  neighborsByIndex: number[][],
  microRegions: MicroRegion[],
  rng: SeededRng,
  inertia: number,
  edgeScores: number[],
  edgeAvoidStrength: number,
  assigned: boolean[],
): number[] {
  if (maxLength <= 0 || assigned[startIndex]) {
    return [];
  }

  const path: number[] = [];
  const visited = new Set<number>();
  let previousIndex: number | null = null;
  let currentIndex = startIndex;

  for (let step = 0; step < maxLength; step += 1) {
    if (assigned[currentIndex]) {
      break;
    }

    path.push(currentIndex);
    visited.add(currentIndex);

    const nextIndex = pickRidgeNeighbor(
      currentIndex,
      previousIndex,
      visited,
      assigned,
      neighborsByIndex,
      microRegions,
      rng,
      inertia,
      edgeScores,
      edgeAvoidStrength,
    );
    if (nextIndex === undefined) {
      break;
    }

    previousIndex = currentIndex;
    currentIndex = nextIndex;
  }

  return path;
}

function pickRidgeNeighbor(
  currentIndex: number,
  previousIndex: number | null,
  visited: Set<number>,
  assigned: boolean[],
  neighborsByIndex: number[][],
  microRegions: MicroRegion[],
  rng: SeededRng,
  inertia: number,
  edgeScores: number[],
  edgeAvoidStrength: number,
): number | undefined {
  const neighbors = neighborsByIndex[currentIndex];
  if (neighbors.length === 0) {
    return undefined;
  }

  let candidates = neighbors.filter((index) => !assigned[index] && !visited.has(index));
  if (candidates.length === 0) {
    candidates = neighbors.filter((index) => !assigned[index]);
  }
  if (candidates.length === 0) {
    candidates = [...neighbors];
  }

  return pickWeightedCandidate(candidates, rng, (candidate) => {
    let weight = 1;
    if (visited.has(candidate)) {
      weight *= 0.2;
    }
    if (assigned[candidate]) {
      weight *= 0.1;
    }
    if (previousIndex !== null && inertia > 0) {
      weight *= computeInertiaWeight(previousIndex, currentIndex, candidate, microRegions, inertia);
    }
    const edgeScore = edgeScores[candidate] ?? 0.5;
    const edgeAvoid = clamp(edgeAvoidStrength, 0, 1);
    const edgeWeight = (1 - edgeAvoid) + edgeAvoid * (edgeScore ** 5);
    weight *= edgeWeight;
    return weight;
  });
}

function pickWeightedCandidate(
  candidates: number[],
  rng: SeededRng,
  weightForCandidate: (candidate: number) => number,
): number | undefined {
  const weights = new Array<number>(candidates.length);
  let total = 0;
  for (let i = 0; i < candidates.length; i += 1) {
    const weight = Math.max(0, weightForCandidate(candidates[i]));
    weights[i] = weight;
    total += weight;
  }

  if (total <= 0) {
    return undefined;
  }

  let roll = rng.nextFloat() * total;
  for (let i = 0; i < candidates.length; i += 1) {
    roll -= weights[i];
    if (roll <= 0) {
      return candidates[i];
    }
  }

  return candidates[candidates.length - 1];
}

function computeInertiaWeight(
  previousIndex: number,
  currentIndex: number,
  candidateIndex: number,
  microRegions: MicroRegion[],
  inertia: number,
): number {
  if (inertia <= 0) {
    return 1;
  }

  const previous = microRegions[previousIndex].site;
  const current = microRegions[currentIndex].site;
  const candidate = microRegions[candidateIndex].site;
  const previousDx = current.x - previous.x;
  const previousDy = current.y - previous.y;
  const candidateDx = candidate.x - current.x;
  const candidateDy = candidate.y - current.y;
  const previousLength = Math.hypot(previousDx, previousDy);
  const candidateLength = Math.hypot(candidateDx, candidateDy);
  if (previousLength === 0 || candidateLength === 0) {
    return 1;
  }

  const dot = (previousDx * candidateDx + previousDy * candidateDy) / (previousLength * candidateLength);
  const alignment = (dot + 1) * 0.5;
  return (1 - inertia) + inertia * alignment;
}

function clampInt(value: number, min: number, max: number): number {
  const rounded = Math.round(value);
  if (rounded < min) {
    return min;
  }
  if (rounded > max) {
    return max;
  }
  return rounded;
}

function pickRidgeElevation(config: WorldConfig, rng: SeededRng): number {
  const peak = rng.range(config.elevationRidgePeakRange.min, config.elevationRidgePeakRange.max);
  return clamp(peak, config.elevationRange.min, config.elevationRange.max);
}

function applyElevationSmoothing(
  microRegions: MicroRegion[],
  neighborsByIndex: number[][],
  strength: number,
  range: { min: number; max: number },
): void {
  if (strength <= 0) {
    return;
  }

  const smoothed = new Array<number>(microRegions.length);
  for (let i = 0; i < microRegions.length; i += 1) {
    const neighbors = neighborsByIndex[i];
    if (neighbors.length === 0) {
      smoothed[i] = microRegions[i].elevation;
      continue;
    }

    let sum = 0;
    for (const neighborIndex of neighbors) {
      sum += microRegions[neighborIndex].elevation;
    }
    const average = sum / neighbors.length;
    const current = microRegions[i].elevation;
    const blended = current + (average - current) * strength;
    smoothed[i] = clamp(blended, range.min, range.max);
  }

  for (let i = 0; i < microRegions.length; i += 1) {
    microRegions[i].elevation = smoothed[i];
  }
}
