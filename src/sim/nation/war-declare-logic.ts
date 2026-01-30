import type { NationId } from "../../worldgen/nation";
import type { MesoRegion, MesoRegionId } from "../../worldgen/meso-region";
import type { UnitState } from "../unit";
import type { WorldState } from "../world-state";
import {
  getAdjacentNationPairs,
  getMesoById,
  getNeighborsById,
  getOwnerByMesoId,
} from "../world-cache";
import { nextScheduledTickRange } from "../schedule";
import { buildWarAdjacency, isAtWar } from "../war-state";
import { WAR_DECLARE_POLICY } from "./war-declare-policy";

export function pickWarDeclarations(world: WorldState): {
  readyNationIds: Set<NationId>;
  candidates: Array<[NationId, NationId]>;
  maxWars: number;
  declareRange: { min: number; max: number };
} {
  const declareRange = WAR_DECLARE_POLICY.slowTickRange;
  if (declareRange.min <= 0 || declareRange.max <= 0) {
    return { readyNationIds: new Set(), candidates: [], maxWars: 0, declareRange };
  }
  if (world.nations.length < 2) {
    return { readyNationIds: new Set(), candidates: [], maxWars: 0, declareRange };
  }

  const adjacentPairs = getAdjacentNationPairs(world);
  const readyNationIds = new Set<NationId>();
  for (const nation of world.nations) {
    if (world.time.slowTick >= nation.nextWarDeclarationTick) {
      readyNationIds.add(nation.id);
    }
  }
  if (readyNationIds.size === 0) {
    return { readyNationIds, candidates: [], maxWars: 0, declareRange };
  }

  const unitCounts = collectUnitCountsByNation(world.units);
  const landPowerByNation = collectLandPowerByNation(world.units);
  const navalPowerByNation = collectNavalPowerByNation(world.units);
  const navalCountsByNation = collectNavalCountsByNation(world.units);
  const mesoById = getMesoById(world);
  const neighborsById = getNeighborsById(world);
  const ownerByMesoId = getOwnerByMesoId(world);
  const occupationByMesoId = world.occupation.mesoById;
  const coastalLandByNation = collectCoastalLandByNation(
    world.mesoRegions,
    mesoById,
    ownerByMesoId,
    occupationByMesoId,
  );
  const warAdjacency = buildWarAdjacency(world.wars);
  const candidates: Array<[NationId, NationId]> = [];
  const candidateKeys = new Set<string>();

  const minTotalUnits = Math.max(0, Math.round(WAR_DECLARE_POLICY.minTotalUnits));
  const minUnitGap = Math.max(0, Math.round(WAR_DECLARE_POLICY.minUnitGap));
  const unitRatio = Math.max(1, WAR_DECLARE_POLICY.unitRatio);
  const evenUnitGap = Math.max(0, Math.round(WAR_DECLARE_POLICY.evenUnitGap));
  const evenUnitRatio = Math.max(1, WAR_DECLARE_POLICY.evenUnitRatio);
  const evenChance = clamp(WAR_DECLARE_POLICY.evenChance, 0, 1);

  for (const [nationA, nationB] of adjacentPairs) {
    if (isAtWar(nationA, nationB, warAdjacency)) {
      continue;
    }
    const isAReady = readyNationIds.has(nationA);
    const isBReady = readyNationIds.has(nationB);
    if (!isAReady && !isBReady) {
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
      if ((strongId === nationA && isAReady) || (strongId === nationB && isBReady)) {
        pushCandidate(candidates, candidateKeys, strongId, weakId);
      }
      continue;
    }

    if (gap <= evenUnitGap && ratio <= evenUnitRatio) {
      if (world.simRng.nextFloat() < evenChance) {
        const readyOptions: NationId[] = [];
        if (isAReady) {
          readyOptions.push(nationA);
        }
        if (isBReady) {
          readyOptions.push(nationB);
        }
        if (readyOptions.length === 0) {
          continue;
        }
        const aggressorId =
          readyOptions.length === 1
            ? readyOptions[0]
            : readyOptions[world.simRng.nextInt(readyOptions.length)];
        const defenderId = aggressorId === nationA ? nationB : nationA;
        pushCandidate(candidates, candidateKeys, aggressorId, defenderId);
      }
    }
  }

  const maxWars = Math.max(0, Math.round(WAR_DECLARE_POLICY.maxWarsPerTick));
  const adjacentSet = buildAdjacentSet(adjacentPairs);
  for (const aggressorId of readyNationIds) {
    for (const defender of world.nations) {
      if (defender.id === aggressorId) {
        continue;
      }
      if (isAtWar(aggressorId, defender.id, warAdjacency)) {
        continue;
      }
      if (adjacentSet.has(pairKey(aggressorId, defender.id))) {
        continue;
      }
      if (
        !canAmphibiousDeclare(
          aggressorId,
          defender.id,
          unitCounts,
          landPowerByNation,
          navalPowerByNation,
          navalCountsByNation,
          coastalLandByNation,
          mesoById,
          neighborsById,
          ownerByMesoId,
          occupationByMesoId,
        )
      ) {
        continue;
      }
      pushCandidate(candidates, candidateKeys, aggressorId, defender.id);
    }
  }

  return { readyNationIds, candidates, maxWars, declareRange };
}

export function scheduleNextWarDeclarations(
  world: WorldState,
  readyNationIds: Set<NationId>,
  declareRange: { min: number; max: number },
): void {
  for (const nation of world.nations) {
    if (!readyNationIds.has(nation.id)) {
      continue;
    }
    nation.nextWarDeclarationTick = nextScheduledTickRange(
      world.time.slowTick,
      declareRange.min,
      declareRange.max,
      world.simRng,
    );
  }
}

function collectUnitCountsByNation(units: UnitState[]): Map<NationId, number> {
  const counts = new Map<NationId, number>();
  for (const unit of units) {
    counts.set(unit.nationId, (counts.get(unit.nationId) ?? 0) + 1);
  }
  return counts;
}

function collectLandPowerByNation(units: UnitState[]): Map<NationId, number> {
  const power = new Map<NationId, number>();
  for (const unit of units) {
    if (unit.domain !== "land") {
      continue;
    }
    const value = unit.manpower * Math.max(0, unit.combatPower);
    power.set(unit.nationId, (power.get(unit.nationId) ?? 0) + value);
  }
  return power;
}

function collectNavalPowerByNation(units: UnitState[]): Map<NationId, number> {
  const power = new Map<NationId, number>();
  for (const unit of units) {
    if (unit.domain !== "naval" || unit.combatPower <= 0) {
      continue;
    }
    const value = unit.manpower * Math.max(0, unit.combatPower);
    power.set(unit.nationId, (power.get(unit.nationId) ?? 0) + value);
  }
  return power;
}

function collectNavalCountsByNation(
  units: UnitState[],
): Map<NationId, { combatShips: number; transportShips: number }> {
  const counts = new Map<NationId, { combatShips: number; transportShips: number }>();
  for (const unit of units) {
    if (unit.domain !== "naval") {
      continue;
    }
    const entry = counts.get(unit.nationId) ?? { combatShips: 0, transportShips: 0 };
    if (unit.type === "CombatShip") {
      entry.combatShips += 1;
    } else if (unit.type === "TransportShip") {
      entry.transportShips += 1;
    }
    counts.set(unit.nationId, entry);
  }
  return counts;
}

function collectCoastalLandByNation(
  mesoRegions: MesoRegion[],
  mesoById: Map<MesoRegionId, MesoRegion>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  occupationByMesoId: Map<MesoRegionId, NationId>,
): Map<NationId, MesoRegionId[]> {
  const result = new Map<NationId, MesoRegionId[]>();
  for (const meso of mesoRegions) {
    if (meso.type === "sea") {
      continue;
    }
    if (!isCoastalLand(meso, mesoById)) {
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

function isCoastalLand(
  meso: MesoRegion,
  mesoById: Map<MesoRegionId, MesoRegion>,
): boolean {
  for (const neighbor of meso.neighbors) {
    const neighborMeso = mesoById.get(neighbor.id);
    if (neighborMeso && neighborMeso.type === "sea") {
      return true;
    }
  }
  return false;
}

function canAmphibiousDeclare(
  aggressorId: NationId,
  defenderId: NationId,
  unitCounts: Map<NationId, number>,
  landPowerByNation: Map<NationId, number>,
  navalPowerByNation: Map<NationId, number>,
  navalCountsByNation: Map<NationId, { combatShips: number; transportShips: number }>,
  coastalLandByNation: Map<NationId, MesoRegionId[]>,
  mesoById: Map<MesoRegionId, MesoRegion>,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  occupationByMesoId: Map<MesoRegionId, NationId>,
): boolean {
  const totalUnits = (unitCounts.get(aggressorId) ?? 0) + (unitCounts.get(defenderId) ?? 0);
  if (totalUnits < WAR_DECLARE_POLICY.minTotalUnits) {
    return false;
  }

  const navalCounts = navalCountsByNation.get(aggressorId) ?? {
    combatShips: 0,
    transportShips: 0,
  };
  if (navalCounts.combatShips < WAR_DECLARE_POLICY.amphibious.minCombatShips) {
    return false;
  }
  if (navalCounts.transportShips < WAR_DECLARE_POLICY.amphibious.minTransportShips) {
    return false;
  }

  const aggressorLand = landPowerByNation.get(aggressorId) ?? 0;
  const defenderLand = landPowerByNation.get(defenderId) ?? 0;
  if (aggressorLand < (defenderLand + 1) * WAR_DECLARE_POLICY.amphibious.landPowerRatio) {
    return false;
  }

  const aggressorNaval = navalPowerByNation.get(aggressorId) ?? 0;
  const defenderNaval = navalPowerByNation.get(defenderId) ?? 0;
  if (aggressorNaval < (defenderNaval + 1) * WAR_DECLARE_POLICY.amphibious.navalPowerRatio) {
    return false;
  }

  const defenderCoasts = coastalLandByNation.get(defenderId) ?? [];
  if (defenderCoasts.length === 0) {
    return false;
  }

  const reachableSeas = computeReachableSeas(
    aggressorId,
    mesoById,
    neighborsById,
    ownerByMesoId,
    occupationByMesoId,
  );
  if (reachableSeas.size === 0) {
    return false;
  }

  for (const landId of defenderCoasts) {
    const land = mesoById.get(landId);
    if (!land) {
      continue;
    }
    for (const neighbor of land.neighbors) {
      const neighborMeso = mesoById.get(neighbor.id);
      if (!neighborMeso || neighborMeso.type !== "sea") {
        continue;
      }
      if (reachableSeas.has(neighbor.id)) {
        return true;
      }
    }
  }

  return false;
}

function computeReachableSeas(
  nationId: NationId,
  mesoById: Map<MesoRegionId, MesoRegion>,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  occupationByMesoId: Map<MesoRegionId, NationId>,
): Set<MesoRegionId> {
  const sources = collectNavalSourcesByNation(
    nationId,
    mesoById,
    ownerByMesoId,
    occupationByMesoId,
  );
  const reachableSeas = new Set<MesoRegionId>();
  if (sources.length === 0) {
    return reachableSeas;
  }
  const visited = new Set<MesoRegionId>();
  const queue: MesoRegionId[] = [...sources];
  for (const source of sources) {
    visited.add(source);
    const meso = mesoById.get(source);
    if (meso && meso.type === "sea") {
      reachableSeas.add(source);
    }
  }

  let head = 0;
  while (head < queue.length) {
    const current = queue[head];
    head += 1;
    const neighbors = neighborsById.get(current) ?? [];
    for (const neighborId of neighbors) {
      if (visited.has(neighborId)) {
        continue;
      }
      const neighbor = mesoById.get(neighborId);
      if (!neighbor || !isNavalNode(neighbor, nationId, ownerByMesoId, occupationByMesoId)) {
        continue;
      }
      visited.add(neighborId);
      queue.push(neighborId);
      if (neighbor.type === "sea") {
        reachableSeas.add(neighborId);
      }
    }
  }

  return reachableSeas;
}

function collectNavalSourcesByNation(
  nationId: NationId,
  mesoById: Map<MesoRegionId, MesoRegion>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  occupationByMesoId: Map<MesoRegionId, NationId>,
): MesoRegionId[] {
  const sources: MesoRegionId[] = [];
  for (const [mesoId, meso] of mesoById.entries()) {
    if (meso.type === "sea") {
      continue;
    }
    const owner = ownerByMesoId.get(mesoId);
    if (owner !== nationId) {
      continue;
    }
    const occupier = occupationByMesoId.get(mesoId);
    if (occupier && occupier !== nationId) {
      continue;
    }
    if (meso.building === "port") {
      sources.push(mesoId);
    }
    for (const neighbor of meso.neighbors) {
      const neighborMeso = mesoById.get(neighbor.id);
      if (neighborMeso && neighborMeso.type === "sea") {
        sources.push(neighbor.id);
      }
    }
  }
  return [...new Set(sources)];
}

function isNavalNode(
  meso: MesoRegion,
  nationId: NationId,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  occupationByMesoId: Map<MesoRegionId, NationId>,
): boolean {
  if (meso.type === "sea") {
    return true;
  }
  if (meso.building === "port") {
    if (ownerByMesoId.get(meso.id) !== nationId) {
      return false;
    }
    const occupier = occupationByMesoId.get(meso.id);
    return !occupier || occupier === nationId;
  }
  return false;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function buildAdjacentSet(pairs: Array<[NationId, NationId]>): Set<string> {
  const set = new Set<string>();
  for (const [a, b] of pairs) {
    set.add(pairKey(a, b));
  }
  return set;
}

function pairKey(a: NationId, b: NationId): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function pushCandidate(
  candidates: Array<[NationId, NationId]>,
  candidateKeys: Set<string>,
  aggressorId: NationId,
  defenderId: NationId,
): void {
  const key = `${aggressorId}->${defenderId}`;
  if (candidateKeys.has(key)) {
    return;
  }
  candidates.push([aggressorId, defenderId]);
  candidateKeys.add(key);
}
