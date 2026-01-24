import type { SeededRng } from "../utils/seeded-rng";
import type { MacroRegion } from "../worldgen/macro-region";
import type { MesoRegion, MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import type { WarState } from "./war-state";
import { declareWar } from "./war-state";

export function addTestWar(
  wars: WarState[],
  mesoRegions: MesoRegion[],
  macroRegions: MacroRegion[],
  rng: SeededRng,
  startedAtFastTick: number,
): void {
  const pairs = collectAdjacentNationPairs(mesoRegions, macroRegions);
  if (pairs.length === 0) {
    console.info("[War] No adjacent nation pairs found for test war.");
    return;
  }

  const [nationAId, nationBId] = pairs[rng.nextInt(pairs.length)];
  const war = declareWar(wars, nationAId, nationBId, startedAtFastTick, true);
  if (war) {
    console.info(
      `[War] ${war.nationAId} vs ${war.nationBId} start (test) @${startedAtFastTick}`,
    );
  }
}

function collectAdjacentNationPairs(
  mesoRegions: MesoRegion[],
  macroRegions: MacroRegion[],
): Array<[NationId, NationId]> {
  const mesoById = new Map<MesoRegionId, MesoRegion>();
  for (const meso of mesoRegions) {
    mesoById.set(meso.id, meso);
  }

  const ownerByMesoId = new Map<MesoRegionId, NationId>();
  for (const macro of macroRegions) {
    for (const mesoId of macro.mesoRegionIds) {
      ownerByMesoId.set(mesoId, macro.nationId);
    }
  }

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

function isPassable(meso: MesoRegion): boolean {
  return meso.type !== "sea";
}
