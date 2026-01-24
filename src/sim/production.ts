import { WORLD_BALANCE } from "../data/balance";
import type { MacroRegion } from "../worldgen/macro-region";
import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import { createDefaultUnit } from "./create-units";
import { createUnitId, type UnitState } from "./unit";
import type { WorldState } from "./world-state";
import { getCityTargetsByNation, getOwnerByMesoId } from "./world-cache";

export function updateProduction(world: WorldState): void {
  const production = WORLD_BALANCE.production;
  if (production.unitSlowTickInterval <= 0) {
    return;
  }
  if (world.time.slowTick % production.unitSlowTickInterval !== 0) {
    return;
  }
  if (world.nations.length === 0) {
    return;
  }

  const ownerByMesoId = getOwnerByMesoId(world);
  const occupationByMesoId = world.occupation.mesoById;
  const occupiedMacroById = world.occupation.macroById;
  const cityTargetsByNation = getCityTargetsByNation(world);
  const unitCountsByNation = collectUnitCountsByNation(world.units);

  const newUnits: UnitState[] = [];
  const cityUnitsPerCycle = Math.max(0, Math.round(production.cityUnitsPerCycle));
  const maxUnitsPerNation = Math.max(0, Math.round(production.maxUnitsPerNation));
  const hasCap = maxUnitsPerNation > 0;

  for (const nation of world.nations) {
    let currentCount = unitCountsByNation.get(nation.id) ?? 0;
    const capacity = hasCap ? maxUnitsPerNation : Number.POSITIVE_INFINITY;
    if (currentCount >= capacity) {
      continue;
    }

    const addUnit = (regionId: MesoRegionId): boolean => {
      if (currentCount >= capacity) {
        return false;
      }
      newUnits.push(createUnitForWorld(world, nation.id, regionId));
      currentCount += 1;
      return true;
    };

    const capitalId = nation.capitalMesoId;
    if (
      isOwnedAndUnoccupied(capitalId, nation.id, ownerByMesoId, occupationByMesoId)
    ) {
      const ownedMacroCount = countOwnedMacroRegions(
        nation.id,
        world.macroRegions,
        occupiedMacroById,
      );
      const capitalUnits = Math.max(
        0,
        Math.round(ownedMacroCount * production.capitalUnitsPerOwnedMacro),
      );
      for (let i = 0; i < capitalUnits; i += 1) {
        if (!addUnit(capitalId)) {
          break;
        }
      }
    }

    const cityTargets = cityTargetsByNation.get(nation.id) ?? [];
    if (cityUnitsPerCycle > 0) {
      for (const cityId of cityTargets) {
        for (let i = 0; i < cityUnitsPerCycle; i += 1) {
          if (!addUnit(cityId)) {
            break;
          }
        }
        if (currentCount >= capacity) {
          break;
        }
      }
    }

    unitCountsByNation.set(nation.id, currentCount);
  }

  if (newUnits.length > 0) {
    world.units.push(...newUnits);
  }
}

function createUnitForWorld(
  world: WorldState,
  nationId: NationId,
  regionId: MesoRegionId,
): UnitState {
  const unitId = createUnitId(world.unitIdCounter);
  world.unitIdCounter += 1;
  return createDefaultUnit(unitId, nationId, regionId);
}

function countOwnedMacroRegions(
  nationId: NationId,
  macroRegions: MacroRegion[],
  occupiedMacroById: Map<MacroRegion["id"], NationId>,
): number {
  let count = 0;
  for (const macro of macroRegions) {
    if (macro.nationId !== nationId) {
      continue;
    }
    const occupier = occupiedMacroById.get(macro.id);
    if (occupier && occupier !== nationId) {
      continue;
    }
    count += 1;
  }
  return count;
}

function isOwnedAndUnoccupied(
  mesoId: MesoRegionId,
  nationId: NationId,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  occupationByMesoId: Map<MesoRegionId, NationId>,
): boolean {
  if (ownerByMesoId.get(mesoId) !== nationId) {
    return false;
  }
  const occupier = occupationByMesoId.get(mesoId);
  if (occupier && occupier !== nationId) {
    return false;
  }
  return true;
}

function collectUnitCountsByNation(units: UnitState[]): Map<NationId, number> {
  const counts = new Map<NationId, number>();
  for (const unit of units) {
    counts.set(unit.nationId, (counts.get(unit.nationId) ?? 0) + 1);
  }
  return counts;
}
