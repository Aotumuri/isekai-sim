import { SeededRng } from "../utils/seeded-rng";
import type { MicroRegion, MicroRegionId } from "./micro-region";
import { createMicroRegionEdgeKey, type MicroRegionEdge } from "./micro-region-edge";

export function applyRivers(
  microRegions: MicroRegion[],
  edges: MicroRegionEdge[],
  rng: SeededRng,
  riverSourceCount: number,
): void {
  const count = microRegions.length;
  if (count === 0 || edges.length === 0) {
    return;
  }

  for (const region of microRegions) {
    region.isRiver = false;
  }

  const idToIndex = new Map<MicroRegionId, number>();
  for (let i = 0; i < count; i += 1) {
    idToIndex.set(microRegions[i].id, i);
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

  const edgeIndex = new Map<string, MicroRegionEdge>();
  for (const edge of edges) {
    edgeIndex.set(createMicroRegionEdgeKey(edge.a, edge.b), edge);
  }

  const sourceCandidates: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const region = microRegions[i];
    if (!region.isSea) {
      continue;
    }
    if (hasUphillOrFlatNeighbor(i, neighborsByIndex, microRegions, true)) {
      sourceCandidates.push(i);
    }
  }

  if (sourceCandidates.length === 0) {
    return;
  }

  const sources = pickRiverSources(sourceCandidates, rng, riverSourceCount);
  for (const sourceIndex of sources) {
    let currentIndex = sourceIndex;
    const visited = new Set<number>();
    visited.add(currentIndex);

    while (true) {
      const nextIndex = pickUphillOrFlatNeighbor(
        currentIndex,
        neighborsByIndex,
        microRegions,
        rng,
      );
      if (nextIndex === undefined) {
        break;
      }

      const currentRegion = microRegions[currentIndex];
      const nextRegion = microRegions[nextIndex];
      const edge = edgeIndex.get(createMicroRegionEdgeKey(currentRegion.id, nextRegion.id));
      if (edge) {
        edge.hasRiver = true;
      }

      if (!nextRegion.isSea) {
        nextRegion.isRiver = true;
      }

      if (visited.has(nextIndex)) {
        break;
      }

      visited.add(nextIndex);
      currentIndex = nextIndex;
    }
  }
}

function hasUphillOrFlatNeighbor(
  index: number,
  neighborsByIndex: number[][],
  microRegions: MicroRegion[],
  disallowSea: boolean,
): boolean {
  const currentElevation = microRegions[index].elevation;
  for (const neighborIndex of neighborsByIndex[index]) {
    const neighbor = microRegions[neighborIndex];
    if (disallowSea && neighbor.isSea) {
      continue;
    }
    if (neighbor.elevation >= currentElevation) {
      return true;
    }
  }
  return false;
}

function pickUphillOrFlatNeighbor(
  index: number,
  neighborsByIndex: number[][],
  microRegions: MicroRegion[],
  rng: SeededRng,
): number | undefined {
  const currentElevation = microRegions[index].elevation;
  const disallowSea = microRegions[index].isSea;
  const candidates: number[] = [];
  for (const neighborIndex of neighborsByIndex[index]) {
    const neighbor = microRegions[neighborIndex];
    if (disallowSea && neighbor.isSea) {
      continue;
    }
    if (neighbor.elevation >= currentElevation) {
      candidates.push(neighborIndex);
    }
  }

  if (candidates.length === 0) {
    return undefined;
  }

  return candidates[rng.nextInt(candidates.length)];
}

function pickRiverSources(
  candidates: number[],
  rng: SeededRng,
  riverSourceCount: number,
): number[] {
  const result = [...candidates];
  shuffleInPlace(result, rng);
  const limit = Math.min(result.length, Math.max(1, riverSourceCount));
  return result.slice(0, limit);
}

function shuffleInPlace(values: number[], rng: SeededRng): void {
  for (let i = values.length - 1; i > 0; i -= 1) {
    const j = rng.nextInt(i + 1);
    [values[i], values[j]] = [values[j], values[i]];
  }
}
