import type { MacroRegion } from "../worldgen/macro-region";
import type { MesoRegion, MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import type { WorldState } from "./world-state";

export interface WorldCache {
  mesoById: Map<MesoRegionId, MesoRegion>;
  neighborsById: Map<MesoRegionId, MesoRegionId[]>;
  ownerByMesoId: Map<MesoRegionId, NationId>;
  ownerByMesoVersion: number;
  borderByNationId: Map<NationId, MesoRegionId[]>;
  borderByNationVersion: number;
  adjacentNationPairs: Array<[NationId, NationId]>;
  adjacentNationPairsVersion: number;
  cityTargetsByNation: Map<NationId, MesoRegionId[]>;
  cityTargetsKey: string;
  portTargetsByNation: Map<NationId, MesoRegionId[]>;
  portTargetsKey: string;
}

export function createWorldCache(): WorldCache {
  return {
    mesoById: new Map(),
    neighborsById: new Map(),
    ownerByMesoId: new Map(),
    ownerByMesoVersion: -1,
    borderByNationId: new Map(),
    borderByNationVersion: -1,
    adjacentNationPairs: [],
    adjacentNationPairsVersion: -1,
    cityTargetsByNation: new Map(),
    cityTargetsKey: "",
    portTargetsByNation: new Map(),
    portTargetsKey: "",
  };
}

export function getMesoById(
  world: WorldState,
): Map<MesoRegionId, MesoRegion> {
  ensureStaticMesoCache(world);
  return world.cache.mesoById;
}

export function getNeighborsById(
  world: WorldState,
): Map<MesoRegionId, MesoRegionId[]> {
  ensureStaticMesoCache(world);
  return world.cache.neighborsById;
}

export function getOwnerByMesoId(
  world: WorldState,
): Map<MesoRegionId, NationId> {
  const cache = world.cache;
  if (cache.ownerByMesoVersion === world.territoryVersion) {
    return cache.ownerByMesoId;
  }

  const ownerByMesoId = buildOwnerByMesoId(world.macroRegions);
  cache.ownerByMesoId = ownerByMesoId;
  cache.ownerByMesoVersion = world.territoryVersion;
  return ownerByMesoId;
}

export function getBorderTargetsByNation(
  world: WorldState,
): Map<NationId, MesoRegionId[]> {
  const cache = world.cache;
  if (cache.borderByNationVersion === world.territoryVersion) {
    return cache.borderByNationId;
  }

  const mesoById = getMesoById(world);
  const neighborsById = getNeighborsById(world);
  const ownerByMesoId = getOwnerByMesoId(world);
  const borderByNationId = new Map<NationId, MesoRegionId[]>();

  for (const [mesoId, meso] of mesoById.entries()) {
    if (!isPassable(meso)) {
      continue;
    }
    const owner = ownerByMesoId.get(mesoId);
    if (!owner) {
      continue;
    }
    const neighbors = neighborsById.get(mesoId) ?? [];
    let isBorder = false;
    for (const neighborId of neighbors) {
      const neighborOwner = ownerByMesoId.get(neighborId);
      if (!neighborOwner || neighborOwner === owner) {
        continue;
      }
      isBorder = true;
      break;
    }
    if (!isBorder) {
      continue;
    }
    const list = borderByNationId.get(owner);
    if (list) {
      list.push(mesoId);
    } else {
      borderByNationId.set(owner, [mesoId]);
    }
  }

  cache.borderByNationId = borderByNationId;
  cache.borderByNationVersion = world.territoryVersion;
  return borderByNationId;
}

export function getAdjacentNationPairs(
  world: WorldState,
): Array<[NationId, NationId]> {
  const cache = world.cache;
  if (cache.adjacentNationPairsVersion === world.territoryVersion) {
    return cache.adjacentNationPairs;
  }

  const ownerByMesoId = getOwnerByMesoId(world);
  const mesoById = getMesoById(world);
  const pairs = collectAdjacentNationPairs(world.mesoRegions, mesoById, ownerByMesoId);
  cache.adjacentNationPairs = pairs;
  cache.adjacentNationPairsVersion = world.territoryVersion;
  return pairs;
}

export function getCityTargetsByNation(
  world: WorldState,
): Map<NationId, MesoRegionId[]> {
  const cache = world.cache;
  const key = `${world.territoryVersion}:${world.occupation.version}:${world.buildingVersion}`;
  if (cache.cityTargetsKey === key) {
    return cache.cityTargetsByNation;
  }

  const ownerByMesoId = getOwnerByMesoId(world);
  const targets = collectCityTargetsByNation(
    world.mesoRegions,
    ownerByMesoId,
    world.occupation.mesoById,
  );
  cache.cityTargetsByNation = targets;
  cache.cityTargetsKey = key;
  return targets;
}

export function getPortTargetsByNation(
  world: WorldState,
): Map<NationId, MesoRegionId[]> {
  const cache = world.cache;
  const key = `${world.territoryVersion}:${world.occupation.version}:${world.buildingVersion}`;
  if (cache.portTargetsKey === key) {
    return cache.portTargetsByNation;
  }

  const ownerByMesoId = getOwnerByMesoId(world);
  const targets = collectPortTargetsByNation(
    world.mesoRegions,
    ownerByMesoId,
    world.occupation.mesoById,
  );
  cache.portTargetsByNation = targets;
  cache.portTargetsKey = key;
  return targets;
}

function buildOwnerByMesoId(
  macroRegions: MacroRegion[],
): Map<MesoRegionId, NationId> {
  const ownerByMesoId = new Map<MesoRegionId, NationId>();
  for (const macro of macroRegions) {
    for (const mesoId of macro.mesoRegionIds) {
      ownerByMesoId.set(mesoId, macro.nationId);
    }
  }
  return ownerByMesoId;
}

function ensureStaticMesoCache(world: WorldState): void {
  const cache = world.cache;
  if (cache.mesoById.size > 0 && cache.neighborsById.size > 0) {
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
  cache.mesoById = mesoById;
  cache.neighborsById = neighborsById;
}

function collectAdjacentNationPairs(
  mesoRegions: MesoRegion[],
  mesoById: Map<MesoRegionId, MesoRegion>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
): Array<[NationId, NationId]> {
  const pairs: Array<[NationId, NationId]> = [];
  const seen = new Set<string>();

  for (const meso of mesoRegions) {
    if (!isPassable(meso)) {
      continue;
    }
    const owner = ownerByMesoId.get(meso.id);
    if (!owner) {
      continue;
    }

    for (const neighbor of meso.neighbors) {
      const neighborMeso = mesoById.get(neighbor.id);
      if (!neighborMeso || !isPassable(neighborMeso)) {
        continue;
      }
      const neighborOwner = ownerByMesoId.get(neighbor.id);
      if (!neighborOwner || neighborOwner === owner) {
        continue;
      }

      const [nationA, nationB] =
        owner < neighborOwner ? [owner, neighborOwner] : [neighborOwner, owner];
      const key = `${nationA}::${nationB}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      pairs.push([nationA, nationB]);
    }
  }

  return pairs;
}

function collectCityTargetsByNation(
  mesoRegions: MesoRegion[],
  ownerByMesoId: Map<MesoRegionId, NationId>,
  occupationByMesoId: Map<MesoRegionId, NationId>,
): Map<NationId, MesoRegionId[]> {
  const result = new Map<NationId, MesoRegionId[]>();
  for (const meso of mesoRegions) {
    if (meso.type === "sea") {
      continue;
    }
    if (meso.building !== "city") {
      continue;
    }
    const owner = ownerByMesoId.get(meso.id);
    if (!owner) {
      continue;
    }
    const occupier = occupationByMesoId.get(meso.id);
    if (occupier && occupier !== owner) {
      continue;
    }
    const list = result.get(owner);
    if (list) {
      list.push(meso.id);
    } else {
      result.set(owner, [meso.id]);
    }
  }
  return result;
}

function collectPortTargetsByNation(
  mesoRegions: MesoRegion[],
  ownerByMesoId: Map<MesoRegionId, NationId>,
  occupationByMesoId: Map<MesoRegionId, NationId>,
): Map<NationId, MesoRegionId[]> {
  const result = new Map<NationId, MesoRegionId[]>();
  for (const meso of mesoRegions) {
    if (meso.type === "sea") {
      continue;
    }
    if (meso.building !== "port") {
      continue;
    }
    const owner = ownerByMesoId.get(meso.id);
    if (!owner) {
      continue;
    }
    const occupier = occupationByMesoId.get(meso.id);
    if (occupier && occupier !== owner) {
      continue;
    }
    const list = result.get(owner);
    if (list) {
      list.push(meso.id);
    } else {
      result.set(owner, [meso.id]);
    }
  }
  return result;
}

function isPassable(meso: MesoRegion): boolean {
  return meso.type !== "sea";
}
