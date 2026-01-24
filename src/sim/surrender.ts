import type { MacroRegion } from "../worldgen/macro-region";
import type { MesoRegion } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import { WORLD_BALANCE } from "../data/balance";
import type { UnitState } from "./unit";
import { buildWarAdjacency, isAtWar } from "./war-state";
import type { WorldState } from "./world-state";

export function updateSurrender(world: WorldState): void {
  if (world.wars.length === 0 || world.nations.length === 0) {
    return;
  }

  const mesoById = new Map<MesoRegion["id"], MesoRegion>();
  for (const meso of world.mesoRegions) {
    mesoById.set(meso.id, meso);
  }

  const mesoByNation = collectMesoByNation(world.macroRegions, mesoById);
  const occupationByMesoId = world.occupation.mesoById;
  const nationById = new Map<NationId, WorldState["nations"][number]>();
  for (const nation of world.nations) {
    nationById.set(nation.id, nation);
  }
  const warAdjacency = buildWarAdjacency(world.wars);
  const unitCountsByNation = collectUnitCountsByNation(world.units);

  const surrendering: NationId[] = [];
  for (const nation of world.nations) {
    const isAtWar = (warAdjacency.get(nation.id)?.size ?? 0) > 0;
    if (!isAtWar) {
      continue;
    }

    const unitCount = unitCountsByNation.get(nation.id) ?? 0;
    if (unitCount <= 0) {
      surrendering.push(nation.id);
      continue;
    }

    const mesoIds = mesoByNation.get(nation.id) ?? [];
    if (mesoIds.length === 0) {
      continue;
    }
    if (isFullyOccupied(nation.id, mesoIds, occupationByMesoId)) {
      surrendering.push(nation.id);
    }
  }

  if (surrendering.length === 0) {
    return;
  }

  let occupationChanged = false;
  let territoryChanged = false;
  const surrenderedThisTick: NationId[] = [];
  const eliminatedNationIds = new Set<NationId>();

  for (const surrenderNationId of surrendering) {
    const macroIds = nationById.get(surrenderNationId)?.macroRegionIds ?? [];
    if (macroIds.length === 0) {
      continue;
    }

    const contributions = collectWarContributions(world, surrenderNationId);
    const allocation = allocateMacroCounts(macroIds.length, contributions);
    if (allocation.size === 0) {
      continue;
    }

    const occupancyByMacro = collectMacroOccupancy(
      world.macroRegions,
      occupationByMesoId,
      new Set(allocation.keys()),
    );
    const assignments = assignMacroRegions(
      macroIds,
      allocation,
      contributions,
      occupancyByMacro,
    );

    const didChange = applyAssignments(
      surrenderNationId,
      assignments,
      world.macroRegions,
      nationById,
      occupationByMesoId,
      mesoById,
    );
    occupationChanged ||= didChange.occupationChanged;
    territoryChanged ||= didChange.territoryChanged;

    if (didChange.territoryChanged) {
      clearCapitalMarkerForNation(surrenderNationId, nationById, mesoById);
      surrenderedThisTick.push(surrenderNationId);
      const remainingMacroIds = nationById.get(surrenderNationId)?.macroRegionIds ?? [];
      if (remainingMacroIds.length === 0) {
        eliminatedNationIds.add(surrenderNationId);
      }
      world.wars = world.wars.filter(
        (war) =>
          war.nationAId !== surrenderNationId && war.nationBId !== surrenderNationId,
      );
      world.battles = world.battles.filter(
        (battle) =>
          battle.attackerNationId !== surrenderNationId &&
          battle.defenderNationId !== surrenderNationId,
      );
    }
  }

  if (eliminatedNationIds.size > 0) {
    const releasedOccupation = releaseOccupationForEliminatedNations(
      world.occupation.mesoById,
      world.occupation.macroById,
      eliminatedNationIds,
      world.macroRegions,
    );
    occupationChanged ||= releasedOccupation;
  }

  if (occupationChanged) {
    world.occupation.version += 1;
  }
  if (territoryChanged) {
    repatriateUnitsAfterSurrender(
      world,
      mesoById,
      new Set(surrenderedThisTick),
    );
    world.territoryVersion += 1;
  }
}

function collectMesoByNation(
  macroRegions: MacroRegion[],
  mesoById: Map<MesoRegion["id"], MesoRegion>,
): Map<NationId, MesoRegion["id"][]> {
  const result = new Map<NationId, MesoRegion["id"][]>();
  for (const macro of macroRegions) {
    let list = result.get(macro.nationId);
    if (!list) {
      list = [];
      result.set(macro.nationId, list);
    }
    for (const mesoId of macro.mesoRegionIds) {
      const meso = mesoById.get(mesoId);
      if (!meso || meso.type === "sea") {
        continue;
      }
      list.push(mesoId);
    }
  }
  return result;
}

function isFullyOccupied(
  nationId: NationId,
  mesoIds: MesoRegion["id"][],
  occupationByMesoId: Map<MesoRegion["id"], NationId>,
): boolean {
  for (const mesoId of mesoIds) {
    const occupier = occupationByMesoId.get(mesoId);
    if (!occupier || occupier === nationId) {
      return false;
    }
  }
  return true;
}

function collectWarContributions(
  world: WorldState,
  surrenderedNationId: NationId,
): Map<NationId, number> {
  const contributions = new Map<NationId, number>();
  for (const war of world.wars) {
    let enemy: NationId | null = null;
    if (war.nationAId === surrenderedNationId) {
      enemy = war.nationBId;
    } else if (war.nationBId === surrenderedNationId) {
      enemy = war.nationAId;
    }
    if (!enemy) {
      continue;
    }
    const value = war.contributionByNationId.get(enemy) ?? 0;
    contributions.set(enemy, (contributions.get(enemy) ?? 0) + value);
  }

  if (sumValues(contributions) > 0) {
    return contributions;
  }

  const occupationCounts = new Map<NationId, number>();
  const nation = world.nations.find((entry) => entry.id === surrenderedNationId);
  if (!nation) {
    return contributions;
  }
  const macroById = new Map<MacroRegion["id"], MacroRegion>();
  for (const macro of world.macroRegions) {
    macroById.set(macro.id, macro);
  }

  for (const macroId of nation.macroRegionIds) {
    const macro = macroById.get(macroId);
    if (!macro) {
      continue;
    }
    for (const mesoId of macro.mesoRegionIds) {
      const occupier = world.occupation.mesoById.get(mesoId);
      if (!occupier || occupier === surrenderedNationId) {
        continue;
      }
      occupationCounts.set(occupier, (occupationCounts.get(occupier) ?? 0) + 1);
    }
  }

  if (sumValues(occupationCounts) > 0) {
    return occupationCounts;
  }

  for (const war of world.wars) {
    if (war.nationAId === surrenderedNationId) {
      contributions.set(war.nationBId, 1);
    } else if (war.nationBId === surrenderedNationId) {
      contributions.set(war.nationAId, 1);
    }
  }

  return contributions;
}

function allocateMacroCounts(
  total: number,
  contributions: Map<NationId, number>,
): Map<NationId, number> {
  const allocation = new Map<NationId, number>();
  if (total <= 0 || contributions.size === 0) {
    return allocation;
  }

  let totalContribution = sumValues(contributions);
  const entries = [...contributions.entries()];
  if (totalContribution <= 0) {
    totalContribution = entries.length;
    for (const [nationId] of entries) {
      contributions.set(nationId, 1);
    }
  }

  const remainders: Array<{ nationId: NationId; remainder: number; weight: number }> = [];
  let assigned = 0;
  for (const [nationId, value] of entries) {
    if (value <= 0) {
      allocation.set(nationId, 0);
      continue;
    }
    const raw = (total * value) / totalContribution;
    const count = Math.floor(raw);
    assigned += count;
    allocation.set(nationId, count);
    remainders.push({ nationId, remainder: raw - count, weight: value });
  }

  const remaining = total - assigned;
  if (remaining > 0) {
    remainders.sort((a, b) => {
      if (a.remainder !== b.remainder) {
        return b.remainder - a.remainder;
      }
      return b.weight - a.weight;
    });
    for (let i = 0; i < remaining; i += 1) {
      const entry = remainders[i % remainders.length];
      allocation.set(entry.nationId, (allocation.get(entry.nationId) ?? 0) + 1);
    }
  }

  return allocation;
}

function collectMacroOccupancy(
  macroRegions: MacroRegion[],
  occupationByMesoId: Map<MesoRegion["id"], NationId>,
  eligibleEnemies: Set<NationId>,
): Map<MacroRegion["id"], Map<NationId, number>> {
  const result = new Map<MacroRegion["id"], Map<NationId, number>>();
  for (const macro of macroRegions) {
    const counts = new Map<NationId, number>();
    for (const mesoId of macro.mesoRegionIds) {
      const occupier = occupationByMesoId.get(mesoId);
      if (!occupier || !eligibleEnemies.has(occupier)) {
        continue;
      }
      counts.set(occupier, (counts.get(occupier) ?? 0) + 1);
    }
    result.set(macro.id, counts);
  }
  return result;
}

function assignMacroRegions(
  macroIds: MacroRegion["id"][],
  allocation: Map<NationId, number>,
  contributions: Map<NationId, number>,
  occupancyByMacro: Map<MacroRegion["id"], Map<NationId, number>>,
): Map<MacroRegion["id"], NationId> {
  const assignments = new Map<MacroRegion["id"], NationId>();
  const remaining = new Map<NationId, number>();
  for (const [nationId, count] of allocation.entries()) {
    remaining.set(nationId, count);
  }

  const macroScores = macroIds.map((macroId) => {
    const counts = occupancyByMacro.get(macroId) ?? new Map<NationId, number>();
    let bestNation: NationId | null = null;
    let bestCount = 0;
    for (const [nationId, count] of counts.entries()) {
      if (count > bestCount) {
        bestNation = nationId;
        bestCount = count;
      }
    }
    return { macroId, counts, bestNation, bestCount };
  });

  macroScores.sort((a, b) => b.bestCount - a.bestCount);

  for (const entry of macroScores) {
    let chosen: NationId | null = null;
    let bestCount = -1;
    let bestWeight = -1;
    for (const [nationId, count] of entry.counts.entries()) {
      if ((remaining.get(nationId) ?? 0) <= 0) {
        continue;
      }
      const weight = contributions.get(nationId) ?? 0;
      if (count > bestCount || (count === bestCount && weight > bestWeight)) {
        chosen = nationId;
        bestCount = count;
        bestWeight = weight;
      }
    }
    if (!chosen) {
      continue;
    }
    assignments.set(entry.macroId, chosen);
    remaining.set(chosen, (remaining.get(chosen) ?? 0) - 1);
  }

  const remainingMacroIds = macroIds.filter((macroId) => !assignments.has(macroId));
  if (remainingMacroIds.length > 0) {
    const remainingNations = [...remaining.entries()]
      .filter(([, count]) => count > 0)
      .sort((a, b) => {
        if (a[1] !== b[1]) {
          return b[1] - a[1];
        }
        return (contributions.get(b[0]) ?? 0) - (contributions.get(a[0]) ?? 0);
      });
    let index = 0;
    for (const macroId of remainingMacroIds) {
      if (remainingNations.length === 0) {
        break;
      }
      const [nationId] = remainingNations[index % remainingNations.length];
      assignments.set(macroId, nationId);
      remaining.set(nationId, (remaining.get(nationId) ?? 0) - 1);
      if ((remaining.get(nationId) ?? 0) <= 0) {
        remainingNations.splice(index % remainingNations.length, 1);
        if (remainingNations.length === 0) {
          break;
        }
        index = 0;
      } else {
        index += 1;
      }
    }
  }

  return assignments;
}

function applyAssignments(
  surrenderedNationId: NationId,
  assignments: Map<MacroRegion["id"], NationId>,
  macroRegions: MacroRegion[],
  nationById: Map<NationId, WorldState["nations"][number]>,
  occupationByMesoId: Map<MesoRegion["id"], NationId>,
  mesoById: Map<MesoRegion["id"], MesoRegion>,
): { territoryChanged: boolean; occupationChanged: boolean } {
  if (assignments.size === 0) {
    return { territoryChanged: false, occupationChanged: false };
  }

  const macroById = new Map<MacroRegion["id"], MacroRegion>();
  for (const macro of macroRegions) {
    macroById.set(macro.id, macro);
  }

  let territoryChanged = false;
  let occupationChanged = false;
  const surrenderedNation = nationById.get(surrenderedNationId);
  for (const [macroId, newOwnerId] of assignments.entries()) {
    const macro = macroById.get(macroId);
    if (!macro) {
      continue;
    }
    if (macro.nationId === newOwnerId) {
      continue;
    }
    const oldOwnerId = macro.nationId;
    macro.nationId = newOwnerId;
    macro.isCore = false;
    territoryChanged = true;

    if (oldOwnerId === surrenderedNationId) {
      for (const mesoId of macro.mesoRegionIds) {
        const meso = mesoById.get(mesoId);
        if (meso && meso.building === "capital") {
          meso.building = null;
        }
      }
    }

    const newOwner = nationById.get(newOwnerId);
    if (newOwner && !newOwner.macroRegionIds.includes(macroId)) {
      newOwner.macroRegionIds.push(macroId);
    }

    if (surrenderedNation) {
      surrenderedNation.macroRegionIds = surrenderedNation.macroRegionIds.filter(
        (id) => id !== macroId,
      );
    } else {
      const oldOwner = nationById.get(oldOwnerId);
      if (oldOwner) {
        oldOwner.macroRegionIds = oldOwner.macroRegionIds.filter((id) => id !== macroId);
      }
    }

    for (const mesoId of macro.mesoRegionIds) {
      if (occupationByMesoId.delete(mesoId)) {
        occupationChanged = true;
      }
    }
  }

  return { territoryChanged, occupationChanged };
}

function sumValues(values: Map<NationId, number>): number {
  let total = 0;
  for (const value of values.values()) {
    total += value;
  }
  return total;
}

function clearCapitalMarkerForNation(
  nationId: NationId,
  nationById: Map<NationId, WorldState["nations"][number]>,
  mesoById: Map<MesoRegion["id"], MesoRegion>,
): void {
  const nation = nationById.get(nationId);
  if (!nation) {
    return;
  }
  const meso = mesoById.get(nation.capitalMesoId);
  if (meso && meso.building === "capital") {
    meso.building = null;
  }
}

function collectUnitCountsByNation(units: UnitState[]): Map<NationId, number> {
  const counts = new Map<NationId, number>();
  for (const unit of units) {
    counts.set(unit.nationId, (counts.get(unit.nationId) ?? 0) + 1);
  }
  return counts;
}

function releaseOccupationForEliminatedNations(
  occupationByMesoId: Map<MesoRegion["id"], NationId>,
  occupationByMacroId: Map<MacroRegion["id"], NationId>,
  eliminatedNationIds: Set<NationId>,
  macroRegions: MacroRegion[],
): boolean {
  if (eliminatedNationIds.size === 0) {
    return false;
  }

  let mesoChanged = false;
  for (const [mesoId, occupier] of occupationByMesoId.entries()) {
    if (!eliminatedNationIds.has(occupier)) {
      continue;
    }
    occupationByMesoId.delete(mesoId);
    mesoChanged = true;
  }

  const nextMacroOccupation = computeMacroOccupation(
    macroRegions,
    occupationByMesoId,
    WORLD_BALANCE.war.macroOccupationRatio,
  );
  const macroChanged = !mapsEqual(nextMacroOccupation, occupationByMacroId);
  if (macroChanged) {
    occupationByMacroId.clear();
    for (const [macroId, occupier] of nextMacroOccupation.entries()) {
      occupationByMacroId.set(macroId, occupier);
    }
  }

  return mesoChanged || macroChanged;
}

function computeMacroOccupation(
  macroRegions: MacroRegion[],
  mesoOccupation: Map<MesoRegion["id"], NationId>,
  threshold: number,
): Map<MacroRegion["id"], NationId> {
  const macroOccupation = new Map<MacroRegion["id"], NationId>();

  for (const macro of macroRegions) {
    const total = macro.mesoRegionIds.length;
    if (total === 0) {
      continue;
    }

    const counts = new Map<NationId, number>();
    for (const mesoId of macro.mesoRegionIds) {
      const occupier = mesoOccupation.get(mesoId);
      if (!occupier || occupier === macro.nationId) {
        continue;
      }
      counts.set(occupier, (counts.get(occupier) ?? 0) + 1);
    }

    let bestNation: NationId | null = null;
    let bestCount = 0;
    for (const [nationId, count] of counts.entries()) {
      if (count > bestCount) {
        bestNation = nationId;
        bestCount = count;
      }
    }

    if (bestNation && bestCount / total >= threshold) {
      macroOccupation.set(macro.id, bestNation);
    }
  }

  return macroOccupation;
}

function mapsEqual<K, V>(a: Map<K, V>, b: Map<K, V>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const [key, value] of a.entries()) {
    if (b.get(key) !== value) {
      return false;
    }
  }
  return true;
}

function repatriateUnitsAfterSurrender(
  world: WorldState,
  mesoById: Map<MesoRegion["id"], MesoRegion>,
  surrenderedNationIds: Set<NationId>,
): void {
  if (world.units.length === 0) {
    return;
  }

  const neighborsById = new Map<MesoRegion["id"], MesoRegion["id"][]>();
  for (const meso of world.mesoRegions) {
    neighborsById.set(
      meso.id,
      meso.neighbors.map((neighbor) => neighbor.id),
    );
  }

  const ownerByMesoId = buildOwnerByMesoId(world.macroRegions);
  const ownedMesoByNation = collectMesoByNation(world.macroRegions, mesoById);
  const warAdjacency = buildWarAdjacency(world.wars);
  const nearestCache = new Map<NationId, Map<MesoRegion["id"], MesoRegion["id"]>>();

  let changed = false;
  const remainingUnits: UnitState[] = [];

  for (const unit of world.units) {
    const ownedMesoIds = ownedMesoByNation.get(unit.nationId) ?? [];
    if (ownedMesoIds.length === 0) {
      if (surrenderedNationIds.has(unit.nationId)) {
        changed = true;
        continue;
      }
      remainingUnits.push(unit);
      continue;
    }

    const owner = ownerByMesoId.get(unit.regionId);
    if (!owner || owner === unit.nationId) {
      remainingUnits.push(unit);
      continue;
    }
    if (isAtWar(unit.nationId, owner, warAdjacency)) {
      remainingUnits.push(unit);
      continue;
    }

    let nearestByMeso = nearestCache.get(unit.nationId);
    if (!nearestByMeso) {
      nearestByMeso = computeNearestOwnedMeso(
        ownedMesoIds,
        neighborsById,
        mesoById,
      );
      nearestCache.set(unit.nationId, nearestByMeso);
    }

    const fallback = ownedMesoIds[0];
    const targetId = nearestByMeso.get(unit.regionId) ?? fallback;
    if (targetId) {
      unit.regionId = targetId;
      resetUnitMovement(unit);
      remainingUnits.push(unit);
      changed = true;
    } else if (surrenderedNationIds.has(unit.nationId)) {
      changed = true;
    } else {
      remainingUnits.push(unit);
    }
  }

  if (changed) {
    world.units = remainingUnits;
  }
}

function computeNearestOwnedMeso(
  ownedMesoIds: MesoRegion["id"][],
  neighborsById: Map<MesoRegion["id"], MesoRegion["id"][]>,
  mesoById: Map<MesoRegion["id"], MesoRegion>,
): Map<MesoRegion["id"], MesoRegion["id"]> {
  const nearest = new Map<MesoRegion["id"], MesoRegion["id"]>();
  const queue: MesoRegion["id"][] = [];

  for (const mesoId of ownedMesoIds) {
    if (nearest.has(mesoId)) {
      continue;
    }
    const meso = mesoById.get(mesoId);
    if (!meso || !isPassable(meso)) {
      continue;
    }
    nearest.set(mesoId, mesoId);
    queue.push(mesoId);
  }

  let head = 0;
  while (head < queue.length) {
    const current = queue[head];
    head += 1;
    const source = nearest.get(current);
    if (!source) {
      continue;
    }
    const neighbors = neighborsById.get(current) ?? [];
    for (const neighbor of neighbors) {
      if (nearest.has(neighbor)) {
        continue;
      }
      const meso = mesoById.get(neighbor);
      if (!meso || !isPassable(meso)) {
        continue;
      }
      nearest.set(neighbor, source);
      queue.push(neighbor);
    }
  }

  return nearest;
}

function resetUnitMovement(unit: UnitState): void {
  unit.moveTargetId = null;
  unit.moveFromId = null;
  unit.moveToId = null;
  unit.moveProgressMs = 0;
}

function buildOwnerByMesoId(
  macroRegions: MacroRegion[],
): Map<MesoRegion["id"], NationId> {
  const ownerByMesoId = new Map<MesoRegion["id"], NationId>();
  for (const macro of macroRegions) {
    for (const mesoId of macro.mesoRegionIds) {
      ownerByMesoId.set(mesoId, macro.nationId);
    }
  }
  return ownerByMesoId;
}

function isPassable(meso: MesoRegion): boolean {
  return meso.type !== "sea";
}
