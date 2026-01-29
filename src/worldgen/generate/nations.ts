import type { Range, WorldConfig } from "../../data/world-config";
import { SeededRng } from "../../utils/seeded-rng";
import type { MesoRegion, MesoRegionId } from "../meso-region";
import { createMacroRegionId, type MacroRegion } from "../macro-region";
import { createNationId, type Nation } from "../nation";

interface NationGenerationResult {
  nations: Nation[];
  macroRegions: MacroRegion[];
}

export function generateNations(
  mesoRegions: MesoRegion[],
  config: WorldConfig,
  rng: SeededRng,
): NationGenerationResult {
  if (!config.nationEnabled) {
    return { nations: [], macroRegions: [] };
  }

  const landIndices: number[] = [];
  const isLand = new Array<boolean>(mesoRegions.length).fill(false);
  for (let i = 0; i < mesoRegions.length; i += 1) {
    if (mesoRegions[i].type !== "sea") {
      landIndices.push(i);
      isLand[i] = true;
    }
  }

  if (landIndices.length === 0) {
    return { nations: [], macroRegions: [] };
  }

  const idToIndex = new Map<MesoRegionId, number>();
  for (let i = 0; i < mesoRegions.length; i += 1) {
    idToIndex.set(mesoRegions[i].id, i);
  }

  const neighborsByIndex = mesoRegions.map((region) => {
    const neighbors: number[] = [];
    for (const neighbor of region.neighbors) {
      const neighborIndex = idToIndex.get(neighbor.id);
      if (neighborIndex === undefined) {
        continue;
      }
      if (!isLand[neighborIndex]) {
        continue;
      }
      neighbors.push(neighborIndex);
    }
    return neighbors;
  });

  const sizeRange = normalizeRange(config.nationMacroRegionSizeRange);
  const averageMacroRegionSize = (sizeRange.min + sizeRange.max) / 2;
  const targetMacroRegionsPerNation = Math.max(
    1,
    Math.round(config.nationTargetMacroRegionsPerNation),
  );
  const macroRegionEstimate = landIndices.length / Math.max(1, averageMacroRegionSize);
  const desiredNationCount = Math.max(
    1,
    Math.round(macroRegionEstimate / targetMacroRegionsPerNation),
  );

  const initialCapitals = pickRandomIndices(
    landIndices,
    Math.min(desiredNationCount, landIndices.length),
    rng,
  );
  const landComponents = buildLandComponents(landIndices, neighborsByIndex);
  const capitalIndices = ensureCapitalPerComponent(initialCapitals, landComponents, rng);

  for (const capitalIndex of capitalIndices) {
    mesoRegions[capitalIndex].building = "capital";
  }

  const { ownerByIndex, distanceByIndex } = assignToCapitals(
    capitalIndices,
    neighborsByIndex,
    isLand,
  );

  const nations: Nation[] = [];
  for (let i = 0; i < capitalIndices.length; i += 1) {
    const capitalIndex = capitalIndices[i];
    nations.push({
      id: createNationId(i),
      capitalMesoId: mesoRegions[capitalIndex].id,
      macroRegionIds: [],
    });
  }

  const indicesByNation: number[][] = Array.from({ length: nations.length }, () => []);
  for (const index of landIndices) {
    const owner = ownerByIndex[index];
    if (owner >= 0) {
      indicesByNation[owner].push(index);
    }
  }

  const macroRegions: MacroRegion[] = [];
  for (let nationIndex = 0; nationIndex < nations.length; nationIndex += 1) {
    const indices = indicesByNation[nationIndex];
    if (indices.length === 0) {
      continue;
    }

    const coreTargetSize = pickTargetSize(sizeRange, rng);
    const coreDistance = chooseCoreDistance(indices, distanceByIndex, coreTargetSize);
    const coreIndices = indices.filter((index) => distanceByIndex[index] <= coreDistance);

    if (coreIndices.length > 0) {
      const macroId = createMacroRegionId(macroRegions.length);
      macroRegions.push({
        id: macroId,
        nationId: nations[nationIndex].id,
        mesoRegionIds: coreIndices.map((index) => mesoRegions[index].id),
        isCore: true,
      });
      nations[nationIndex].macroRegionIds.push(macroId);
    }

    const farIndices = indices.filter((index) => distanceByIndex[index] > coreDistance);
    const farMacroGroups = splitFarRegions(
      farIndices,
      neighborsByIndex,
      sizeRange,
      distanceByIndex,
      rng,
    );
    for (const group of farMacroGroups) {
      const macroId = createMacroRegionId(macroRegions.length);
      macroRegions.push({
        id: macroId,
        nationId: nations[nationIndex].id,
        mesoRegionIds: group.map((index) => mesoRegions[index].id),
        isCore: false,
      });
      nations[nationIndex].macroRegionIds.push(macroId);
    }
  }

  assignCities(mesoRegions, macroRegions, nations, idToIndex, config, rng);
  assignPorts(mesoRegions, macroRegions, nations, idToIndex, config, rng);

  return { nations, macroRegions };
}

function assignCities(
  mesoRegions: MesoRegion[],
  macroRegions: MacroRegion[],
  nations: Nation[],
  idToIndex: Map<MesoRegionId, number>,
  config: WorldConfig,
  rng: SeededRng,
): void {
  const candidatesByNation = new Map<Nation["id"], number[]>();

  for (const macro of macroRegions) {
    for (const mesoId of macro.mesoRegionIds) {
      const index = idToIndex.get(mesoId);
      if (index === undefined) {
        continue;
      }
      const meso = mesoRegions[index];
      if (meso.type !== "land") {
        continue;
      }
      if (meso.building === "capital") {
        continue;
      }
      let list = candidatesByNation.get(macro.nationId);
      if (!list) {
        list = [];
        candidatesByNation.set(macro.nationId, list);
      }
      list.push(index);
    }
  }

  for (const nation of nations) {
    const candidates = candidatesByNation.get(nation.id) ?? [];
    if (candidates.length === 0) {
      continue;
    }
    const baseCount = Math.round(
      nation.macroRegionIds.length * config.nationCityPerMacroRegion,
    );
    const minCount = Math.max(0, Math.round(config.nationMinCitiesPerNation));
    const targetCount = Math.min(
      candidates.length,
      Math.max(minCount, baseCount),
    );
    if (targetCount <= 0) {
      continue;
    }
    const selected = pickRandomIndices(candidates, targetCount, rng);
    for (const index of selected) {
      if (mesoRegions[index].building === null) {
        mesoRegions[index].building = "city";
      }
    }
  }
}

function assignPorts(
  mesoRegions: MesoRegion[],
  macroRegions: MacroRegion[],
  nations: Nation[],
  idToIndex: Map<MesoRegionId, number>,
  config: WorldConfig,
  rng: SeededRng,
): void {
  const candidatesByNation = new Map<Nation["id"], number[]>();
  const isCoastal = buildCoastalIndex(mesoRegions, idToIndex);

  for (const macro of macroRegions) {
    for (const mesoId of macro.mesoRegionIds) {
      const index = idToIndex.get(mesoId);
      if (index === undefined) {
        continue;
      }
      const meso = mesoRegions[index];
      if (meso.type === "sea") {
        continue;
      }
      if (!isCoastal[index]) {
        continue;
      }
      if (meso.building !== null) {
        continue;
      }
      let list = candidatesByNation.get(macro.nationId);
      if (!list) {
        list = [];
        candidatesByNation.set(macro.nationId, list);
      }
      list.push(index);
    }
  }

  for (const nation of nations) {
    const candidates = candidatesByNation.get(nation.id) ?? [];
    if (candidates.length === 0) {
      continue;
    }
    const baseCount = Math.round(
      nation.macroRegionIds.length * config.nationPortPerMacroRegion,
    );
    const minCount = Math.max(0, Math.round(config.nationMinPortsPerNation));
    const targetCount = Math.min(
      candidates.length,
      Math.max(minCount, baseCount),
    );
    if (targetCount <= 0) {
      continue;
    }
    const selected = pickRandomIndices(candidates, targetCount, rng);
    for (const index of selected) {
      if (mesoRegions[index].building === null) {
        mesoRegions[index].building = "port";
      }
    }
  }
}

function buildCoastalIndex(
  mesoRegions: MesoRegion[],
  idToIndex: Map<MesoRegionId, number>,
): boolean[] {
  const coastal = new Array<boolean>(mesoRegions.length).fill(false);
  for (let i = 0; i < mesoRegions.length; i += 1) {
    const meso = mesoRegions[i];
    if (meso.type === "sea") {
      continue;
    }
    for (const neighbor of meso.neighbors) {
      const neighborIndex = idToIndex.get(neighbor.id);
      if (neighborIndex === undefined) {
        continue;
      }
      if (mesoRegions[neighborIndex].type === "sea") {
        coastal[i] = true;
        break;
      }
    }
  }
  return coastal;
}

function assignToCapitals(
  capitalIndices: number[],
  neighborsByIndex: number[][],
  isLand: boolean[],
): { ownerByIndex: number[]; distanceByIndex: number[] } {
  const count = neighborsByIndex.length;
  const ownerByIndex = new Array<number>(count).fill(-1);
  const distanceByIndex = new Array<number>(count).fill(Number.POSITIVE_INFINITY);
  const queue: number[] = [];

  for (let i = 0; i < capitalIndices.length; i += 1) {
    const capitalIndex = capitalIndices[i];
    ownerByIndex[capitalIndex] = i;
    distanceByIndex[capitalIndex] = 0;
    queue.push(capitalIndex);
  }

  let head = 0;
  while (head < queue.length) {
    const current = queue[head];
    head += 1;
    const nextDistance = distanceByIndex[current] + 1;

    for (const neighbor of neighborsByIndex[current]) {
      if (!isLand[neighbor]) {
        continue;
      }
      if (ownerByIndex[neighbor] !== -1) {
        continue;
      }

      ownerByIndex[neighbor] = ownerByIndex[current];
      distanceByIndex[neighbor] = nextDistance;
      queue.push(neighbor);
    }
  }

  return { ownerByIndex, distanceByIndex };
}

function buildLandComponents(
  landIndices: number[],
  neighborsByIndex: number[][],
): number[][] {
  const components: number[][] = [];
  const visited = new Array<boolean>(neighborsByIndex.length).fill(false);

  for (const start of landIndices) {
    if (visited[start]) {
      continue;
    }

    const component: number[] = [];
    const queue: number[] = [start];
    visited[start] = true;

    let head = 0;
    while (head < queue.length) {
      const current = queue[head];
      head += 1;
      component.push(current);

      for (const neighbor of neighborsByIndex[current]) {
        if (visited[neighbor]) {
          continue;
        }
        visited[neighbor] = true;
        queue.push(neighbor);
      }
    }

    components.push(component);
  }

  return components;
}

function ensureCapitalPerComponent(
  initialCapitals: number[],
  components: number[][],
  rng: SeededRng,
): number[] {
  const capitals: number[] = [];
  const capitalSet = new Set<number>();

  for (const capital of initialCapitals) {
    if (capitalSet.has(capital)) {
      continue;
    }
    capitalSet.add(capital);
    capitals.push(capital);
  }

  for (const component of components) {
    let hasCapital = false;
    for (const index of component) {
      if (capitalSet.has(index)) {
        hasCapital = true;
        break;
      }
    }

    if (!hasCapital && component.length > 0) {
      const pick = component[rng.nextInt(component.length)];
      capitalSet.add(pick);
      capitals.push(pick);
    }
  }

  return capitals;
}

function normalizeRange(range: Range): { min: number; max: number } {
  const min = Math.max(1, Math.round(Math.min(range.min, range.max)));
  const max = Math.max(min, Math.round(Math.max(range.min, range.max)));
  return { min, max };
}

function pickTargetSize(range: { min: number; max: number }, rng: SeededRng): number {
  if (range.max <= range.min) {
    return range.min;
  }
  return range.min + rng.nextInt(range.max - range.min + 1);
}

function chooseCoreDistance(
  indices: number[],
  distanceByIndex: number[],
  targetSize: number,
): number {
  const countsByDistance = new Map<number, number>();
  for (const index of indices) {
    const distance = distanceByIndex[index];
    countsByDistance.set(distance, (countsByDistance.get(distance) ?? 0) + 1);
  }

  const distances = [...countsByDistance.keys()].sort((a, b) => a - b);
  if (distances.length === 0) {
    return 0;
  }

  let bestDistance = distances[0];
  let bestDiff = Number.POSITIVE_INFINITY;
  let cumulative = 0;
  for (const distance of distances) {
    cumulative += countsByDistance.get(distance) ?? 0;
    const diff = Math.abs(cumulative - targetSize);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestDistance = distance;
    }
  }

  return bestDistance;
}

function splitFarRegions(
  indices: number[],
  neighborsByIndex: number[][],
  sizeRange: { min: number; max: number },
  distanceByIndex: number[],
  rng: SeededRng,
): number[][] {
  if (indices.length === 0) {
    return [];
  }

  const unassigned = new Set(indices);
  const regions: number[][] = [];

  while (unassigned.size > 0) {
    const seed = pickSeed(unassigned, distanceByIndex, rng);
    const targetSize = pickTargetSize(sizeRange, rng);
    const region = collectMacroRegion(seed, unassigned, neighborsByIndex, targetSize);
    if (region.length > 0) {
      regions.push(region);
    }
  }

  return regions;
}

function pickSeed(
  unassigned: Set<number>,
  distanceByIndex: number[],
  rng: SeededRng,
): number {
  let bestDistance = -Infinity;
  let candidates: number[] = [];

  for (const index of unassigned) {
    const distance = distanceByIndex[index] ?? 0;
    if (distance > bestDistance) {
      bestDistance = distance;
      candidates = [index];
    } else if (distance === bestDistance) {
      candidates.push(index);
    }
  }

  if (candidates.length === 0) {
    return [...unassigned][0];
  }

  return candidates[rng.nextInt(candidates.length)];
}

function collectMacroRegion(
  seed: number,
  unassigned: Set<number>,
  neighborsByIndex: number[][],
  targetSize: number,
): number[] {
  if (!unassigned.has(seed)) {
    return [];
  }

  const region: number[] = [];
  const queue: number[] = [seed];
  const queued = new Set<number>([seed]);

  while (queue.length > 0 && region.length < targetSize) {
    const current = queue.shift();
    if (current === undefined) {
      break;
    }
    if (!unassigned.has(current)) {
      continue;
    }

    unassigned.delete(current);
    region.push(current);

    for (const neighbor of neighborsByIndex[current]) {
      if (!unassigned.has(neighbor)) {
        continue;
      }
      if (queued.has(neighbor)) {
        continue;
      }
      queued.add(neighbor);
      queue.push(neighbor);
    }
  }

  return region;
}

function pickRandomIndices(values: number[], count: number, rng: SeededRng): number[] {
  const shuffled = [...values];
  shuffleInPlace(shuffled, rng);
  return shuffled.slice(0, Math.min(count, shuffled.length));
}

function shuffleInPlace(values: number[], rng: SeededRng): void {
  for (let i = values.length - 1; i > 0; i -= 1) {
    const j = rng.nextInt(i + 1);
    [values[i], values[j]] = [values[j], values[i]];
  }
}
