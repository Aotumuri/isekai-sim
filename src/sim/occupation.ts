import { WORLD_BALANCE } from "../data/balance";
import type { MacroRegion, MacroRegionId } from "../worldgen/macro-region";
import type { MesoRegion, MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import type { UnitState } from "./unit";
import type { WorldState } from "./world-state";
import { buildWarAdjacency, isAtWar } from "./war-state";

export interface OccupationState {
  mesoById: Map<MesoRegionId, NationId>;
  macroById: Map<MacroRegionId, NationId>;
  version: number;
}

export function createOccupationState(): OccupationState {
  return {
    mesoById: new Map(),
    macroById: new Map(),
    version: 0,
  };
}

export function updateOccupation(world: WorldState): void {
  const warAdjacency = buildWarAdjacency(world.wars);
  const ownerByMesoId = buildOwnerByMesoId(world.macroRegions);
  const unitsByMesoId = collectUnitsByMeso(world.units);
  const mesoOccupation = new Map<MesoRegionId, NationId>(world.occupation.mesoById);
  let mesoChanged = false;

  for (const meso of world.mesoRegions) {
    if (!isPassable(meso)) {
      if (mesoOccupation.delete(meso.id)) {
        mesoChanged = true;
      }
      continue;
    }
    const owner = ownerByMesoId.get(meso.id);
    if (!owner) {
      if (mesoOccupation.delete(meso.id)) {
        mesoChanged = true;
      }
      continue;
    }

    const units = unitsByMesoId.get(meso.id) ?? [];
    if (units.some((unit) => unit.nationId === owner)) {
      if (mesoOccupation.delete(meso.id)) {
        mesoChanged = true;
      }
      continue;
    }

    const current = mesoOccupation.get(meso.id);
    if (current && current !== owner) {
      continue;
    }

    const occupier = pickOccupier(units, owner, warAdjacency);
    if (occupier && occupier !== current) {
      mesoOccupation.set(meso.id, occupier);
      mesoChanged = true;
    }
  }

  const macroOccupation = computeMacroOccupation(
    world.macroRegions,
    mesoOccupation,
    WORLD_BALANCE.war.macroOccupationRatio,
  );

  const macroChanged = !mapsEqual(macroOccupation, world.occupation.macroById);
  if (mesoChanged || macroChanged) {
    world.occupation.mesoById = mesoOccupation;
    world.occupation.macroById = macroOccupation;
    world.occupation.version += 1;
  }
}

function buildOwnerByMesoId(macroRegions: MacroRegion[]): Map<MesoRegionId, NationId> {
  const ownerByMesoId = new Map<MesoRegionId, NationId>();
  for (const macro of macroRegions) {
    for (const mesoId of macro.mesoRegionIds) {
      ownerByMesoId.set(mesoId, macro.nationId);
    }
  }
  return ownerByMesoId;
}

function collectUnitsByMeso(units: UnitState[]): Map<MesoRegionId, UnitState[]> {
  const unitsByMesoId = new Map<MesoRegionId, UnitState[]>();
  for (const unit of units) {
    const list = unitsByMesoId.get(unit.regionId);
    if (list) {
      list.push(unit);
    } else {
      unitsByMesoId.set(unit.regionId, [unit]);
    }
  }
  return unitsByMesoId;
}

function pickOccupier(
  units: UnitState[],
  owner: NationId,
  warAdjacency: ReturnType<typeof buildWarAdjacency>,
): NationId | null {
  const counts = new Map<NationId, number>();
  for (const unit of units) {
    if (unit.nationId === owner) {
      continue;
    }
    if (!isAtWar(unit.nationId, owner, warAdjacency)) {
      continue;
    }
    counts.set(unit.nationId, (counts.get(unit.nationId) ?? 0) + 1);
  }

  let bestNation: NationId | null = null;
  let bestCount = 0;
  for (const [nationId, count] of counts.entries()) {
    if (count > bestCount) {
      bestNation = nationId;
      bestCount = count;
    }
  }
  return bestNation;
}

function computeMacroOccupation(
  macroRegions: MacroRegion[],
  mesoOccupation: Map<MesoRegionId, NationId>,
  threshold: number,
): Map<MacroRegionId, NationId> {
  const macroOccupation = new Map<MacroRegionId, NationId>();

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

function isPassable(meso: MesoRegion): boolean {
  return meso.type !== "sea";
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
