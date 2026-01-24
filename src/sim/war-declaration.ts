import { WORLD_BALANCE } from "../data/balance";
import type { MacroRegion } from "../worldgen/macro-region";
import type { MesoRegion, MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import type { UnitState } from "./unit";
import type { WorldState } from "./world-state";
import { buildWarAdjacency, declareWar, isAtWar } from "./war-state";

export function updateWarDeclarations(world: WorldState): void {
  const declareBalance = WORLD_BALANCE.war.declare;
  if (declareBalance.slowTickInterval <= 0) {
    return;
  }
  if (world.time.slowTick % declareBalance.slowTickInterval !== 0) {
    return;
  }
  if (world.nations.length < 2) {
    return;
  }

  const adjacentPairs = collectAdjacentNationPairs(world.mesoRegions, world.macroRegions);
  if (adjacentPairs.length === 0) {
    return;
  }

  const unitCounts = collectUnitCountsByNation(world.units);
  const warAdjacency = buildWarAdjacency(world.wars);
  const candidates: Array<[NationId, NationId]> = [];

  const minTotalUnits = Math.max(0, Math.round(declareBalance.minTotalUnits));
  const minUnitGap = Math.max(0, Math.round(declareBalance.minUnitGap));
  const unitRatio = Math.max(1, declareBalance.unitRatio);
  const evenUnitGap = Math.max(0, Math.round(declareBalance.evenUnitGap));
  const evenUnitRatio = Math.max(1, declareBalance.evenUnitRatio);
  const evenChance = clamp(declareBalance.evenChance, 0, 1);

  for (const [nationA, nationB] of adjacentPairs) {
    if (isAtWar(nationA, nationB, warAdjacency)) {
      continue;
    }

    const countA = unitCounts.get(nationA) ?? 0;
    const countB = unitCounts.get(nationB) ?? 0;
    if (countA + countB < minTotalUnits) {
      continue;
    }

    const [strongId, weakId, strongCount, weakCount] =
      countA >= countB
        ? [nationA, nationB, countA, countB]
        : [nationB, nationA, countB, countA];

    const gap = strongCount - weakCount;
    const ratio = (strongCount + 1) / (weakCount + 1);
    const isDominant = gap >= minUnitGap || ratio >= unitRatio;

    if (isDominant) {
      candidates.push([strongId, weakId]);
      continue;
    }

    if (gap <= evenUnitGap && ratio <= evenUnitRatio) {
      if (world.simRng.nextFloat() < evenChance) {
        candidates.push([nationA, nationB]);
      }
    }
  }

  const maxWars = Math.max(0, Math.round(declareBalance.maxWarsPerTick));
  if (candidates.length === 0 || maxWars <= 0) {
    return;
  }

  const limit = Math.min(maxWars, candidates.length);
  for (let i = 0; i < limit; i += 1) {
    const pickIndex = world.simRng.nextInt(candidates.length);
    const [nationA, nationB] = candidates.splice(pickIndex, 1)[0];
    const war = declareWar(world.wars, nationA, nationB, world.time.fastTick);
    if (war) {
      console.info(
        `[War] ${war.nationAId} vs ${war.nationBId} start @${world.time.fastTick}`,
      );
    }
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

function collectUnitCountsByNation(units: UnitState[]): Map<NationId, number> {
  const counts = new Map<NationId, number>();
  for (const unit of units) {
    counts.set(unit.nationId, (counts.get(unit.nationId) ?? 0) + 1);
  }
  return counts;
}

function isPassable(meso: MesoRegion): boolean {
  return meso.type !== "sea";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
