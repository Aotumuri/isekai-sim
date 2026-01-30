import { WORLD_BALANCE } from "../data/balance";
import type { MacroRegion, MacroRegionId } from "../worldgen/macro-region";
import type { MesoRegion, MesoRegionId } from "../worldgen/meso-region";
import { createNationId, type NationId } from "../worldgen/nation";
import type { SeededRng } from "../utils/seeded-rng";
import {
  createNationResourceFlow,
  createNationResources,
  type NationRuntime,
  type NationResources,
} from "./nation-runtime";
import { WAR_DECLARE_POLICY } from "./nation/war-declare-policy";
import { nextScheduledTickRange } from "./schedule";
import type { UnitState } from "./unit";
import { declareWar } from "./war-state";
import type { WorldState } from "./world-state";
import { getMesoById } from "./world-cache";

export function updateCivilWar(world: WorldState): void {
  if (world.nations.length === 0) {
    return;
  }

  const cooperationBalance = WORLD_BALANCE.war.cooperation;
  const civilWarBalance = WORLD_BALANCE.war.civilWar;
  if (!civilWarBalance.enabled) {
    return;
  }
  const mesoById = getMesoById(world);
  const mesoToMacro = buildMesoToMacroMap(world.macroRegions);
  const macroAdjacency = buildMacroAdjacency(world.mesoRegions, mesoToMacro);

  const nationsSnapshot = [...world.nations];
  let territoryChanged = false;
  let buildingChanged = false;

  for (const nation of nationsSnapshot) {
    if (nation.warCooperation > cooperationBalance.min) {
      continue;
    }
    if (nation.macroRegionIds.length <= 1) {
      continue;
    }

    const cityCandidates = collectCityCandidates(
      nation.id,
      world.macroRegions,
      mesoById,
      world.occupation.mesoById,
      nation.capitalMesoId,
    );
    if (cityCandidates.length === 0) {
      continue;
    }
    const cityMesoId = cityCandidates[world.simRng.nextInt(cityCandidates.length)];
    const cityMacroId = mesoToMacro.get(cityMesoId);
    if (!cityMacroId) {
      continue;
    }

    const rebelMacroIds = pickRebelMacroIds(
      nation,
      cityMacroId,
      macroAdjacency,
      world.simRng,
    );
    if (rebelMacroIds.size === 0) {
      continue;
    }

    const rebelMesoIds = collectMesoIdsForMacros(
      world.macroRegions,
      rebelMacroIds,
    );
    if (demoteExtraCapitals(rebelMesoIds, mesoById, cityMesoId)) {
      buildingChanged = true;
    }
    const newNationId = createNationId(world.nations.length);
    const initialUnitCount = reassignUnitsToRebels(
      world.units,
      nation.id,
      newNationId,
      rebelMesoIds,
    );
    const initialCityCount = countCityBuildingsForMacros(
      world.macroRegions,
      rebelMacroIds,
      mesoById,
    );
    const totalMacroCount = nation.macroRegionIds.length;
    const rebelShare = totalMacroCount > 0 ? rebelMacroIds.size / totalMacroCount : 0;
    const rebelResources = transferResources(nation.resources, rebelShare);

    for (const macro of world.macroRegions) {
      if (!rebelMacroIds.has(macro.id)) {
        continue;
      }
      macro.nationId = newNationId;
      territoryChanged = true;
    }
    nation.macroRegionIds = nation.macroRegionIds.filter(
      (macroId) => !rebelMacroIds.has(macroId),
    );

    const capital = mesoById.get(cityMesoId);
    if (capital && capital.building !== "capital") {
      capital.building = "capital";
      buildingChanged = true;
    }

    const productionBalance = WORLD_BALANCE.production;
    const unitRange = productionBalance.unitSlowTickRange;
    const isUnitProductionEnabled = unitRange.min > 0 && unitRange.max > 0;
    const declareRange = WAR_DECLARE_POLICY.slowTickRange;
    const isWarDeclarationEnabled = declareRange.min > 0 && declareRange.max > 0;
    const newNation: NationRuntime = {
      id: newNationId,
      capitalMesoId: cityMesoId,
      macroRegionIds: [...rebelMacroIds],
      unitRoles: {
        defenseUnitIds: [],
        occupationUnitIds: [],
      },
      capitalFallCount: 0,
      surrenderScore: 0,
      initialUnitCount,
      initialCityCount,
      warCooperation: cooperationBalance.max,
      warCooperationBoost: 0,
      resources: rebelResources,
      resourceFlow: createNationResourceFlow(),
      nextUnitProductionTick: isUnitProductionEnabled
        ? nextScheduledTickRange(
            world.time.slowTick,
            unitRange.min,
            unitRange.max,
            world.simRng,
          )
        : Number.POSITIVE_INFINITY,
      nextWarDeclarationTick: isWarDeclarationEnabled
        ? nextScheduledTickRange(
            world.time.slowTick,
            declareRange.min,
            declareRange.max,
            world.simRng,
          )
        : Number.POSITIVE_INFINITY,
    };
    world.nations.push(newNation);

    const boost = Math.max(0, cooperationBalance.civilWarBoost);
    nation.warCooperationBoost = clamp(
      nation.warCooperationBoost + boost,
      0,
      cooperationBalance.max,
    );
    nation.warCooperation = clamp(
      nation.warCooperation + boost,
      cooperationBalance.min,
      cooperationBalance.max,
    );

    const war = declareWar(world.wars, newNationId, nation.id, world.time.fastTick);
    if (war) {
      console.info(
        `[CivilWar] ${nation.id} vs ${newNationId} start @${world.time.fastTick}`,
      );
    }
  }

  if (territoryChanged) {
    world.territoryVersion += 1;
  }
  if (buildingChanged) {
    world.buildingVersion += 1;
  }
}

function collectCityCandidates(
  nationId: NationId,
  macroRegions: MacroRegion[],
  mesoById: Map<MesoRegionId, MesoRegion>,
  occupationByMesoId: Map<MesoRegionId, NationId>,
  capitalMesoId: MesoRegionId,
): MesoRegionId[] {
  const candidates: MesoRegionId[] = [];
  for (const macro of macroRegions) {
    if (macro.nationId !== nationId) {
      continue;
    }
    for (const mesoId of macro.mesoRegionIds) {
      const meso = mesoById.get(mesoId);
      if (!meso || meso.type === "sea") {
        continue;
      }
      if (meso.building !== "city") {
        continue;
      }
      if (mesoId === capitalMesoId) {
        continue;
      }
      const occupier = occupationByMesoId.get(mesoId);
      if (occupier && occupier !== nationId) {
        continue;
      }
      candidates.push(mesoId);
    }
  }
  return candidates;
}

function pickRebelMacroIds(
  nation: NationRuntime,
  cityMacroId: MacroRegionId,
  macroAdjacency: Map<MacroRegionId, Set<MacroRegionId>>,
  rng: SeededRng,
): Set<MacroRegionId> {
  const nationMacroIds = new Set(nation.macroRegionIds);
  if (!nationMacroIds.has(cityMacroId)) {
    return new Set();
  }

  const rebelMacroIds = new Set<MacroRegionId>([cityMacroId]);
  const neighbors = [...(macroAdjacency.get(cityMacroId) ?? [])].filter((id) =>
    nationMacroIds.has(id),
  );
  for (const neighbor of neighbors) {
    rebelMacroIds.add(neighbor);
  }

  const maxAllowed = nationMacroIds.size - 1;
  if (maxAllowed <= 0) {
    return new Set();
  }
  if (rebelMacroIds.size > maxAllowed) {
    const extras = neighbors.filter((id) => id !== cityMacroId);
    while (rebelMacroIds.size > maxAllowed && extras.length > 0) {
      const removeIndex = rng.nextInt(extras.length);
      const removeId = extras.splice(removeIndex, 1)[0];
      rebelMacroIds.delete(removeId);
    }
  }

  return rebelMacroIds;
}

function reassignUnitsToRebels(
  units: UnitState[],
  nationId: NationId,
  rebelNationId: NationId,
  rebelMesoIds: Set<MesoRegionId>,
): number {
  let assigned = 0;
  for (const unit of units) {
    if (unit.nationId !== nationId) {
      continue;
    }
    if (!rebelMesoIds.has(unit.regionId)) {
      continue;
    }
    unit.nationId = rebelNationId;
    assigned += 1;
  }
  return assigned;
}

function countCityBuildingsForMacros(
  macroRegions: MacroRegion[],
  macroIds: Set<MacroRegionId>,
  mesoById: Map<MesoRegionId, MesoRegion>,
): number {
  let count = 0;
  for (const macro of macroRegions) {
    if (!macroIds.has(macro.id)) {
      continue;
    }
    for (const mesoId of macro.mesoRegionIds) {
      const meso = mesoById.get(mesoId);
      if (!meso || meso.type === "sea") {
        continue;
      }
      if (meso.building === "city" || meso.building === "capital") {
        count += 1;
      }
    }
  }
  return count;
}

function collectMesoIdsForMacros(
  macroRegions: MacroRegion[],
  macroIds: Set<MacroRegionId>,
): Set<MesoRegionId> {
  const mesoIds = new Set<MesoRegionId>();
  for (const macro of macroRegions) {
    if (!macroIds.has(macro.id)) {
      continue;
    }
    for (const mesoId of macro.mesoRegionIds) {
      mesoIds.add(mesoId);
    }
  }
  return mesoIds;
}

function demoteExtraCapitals(
  mesoIds: Set<MesoRegionId>,
  mesoById: Map<MesoRegionId, MesoRegion>,
  newCapitalId: MesoRegionId,
): boolean {
  let changed = false;
  for (const mesoId of mesoIds) {
    if (mesoId === newCapitalId) {
      continue;
    }
    const meso = mesoById.get(mesoId);
    if (!meso || meso.building !== "capital") {
      continue;
    }
    meso.building = "city";
    changed = true;
  }
  return changed;
}

function buildMesoToMacroMap(
  macroRegions: MacroRegion[],
): Map<MesoRegionId, MacroRegionId> {
  const map = new Map<MesoRegionId, MacroRegionId>();
  for (const macro of macroRegions) {
    for (const mesoId of macro.mesoRegionIds) {
      map.set(mesoId, macro.id);
    }
  }
  return map;
}

function buildMacroAdjacency(
  mesoRegions: MesoRegion[],
  mesoToMacro: Map<MesoRegionId, MacroRegionId>,
): Map<MacroRegionId, Set<MacroRegionId>> {
  const adjacency = new Map<MacroRegionId, Set<MacroRegionId>>();
  for (const meso of mesoRegions) {
    const macroId = mesoToMacro.get(meso.id);
    if (!macroId) {
      continue;
    }
    for (const neighbor of meso.neighbors) {
      const neighborMacro = mesoToMacro.get(neighbor.id);
      if (!neighborMacro || neighborMacro === macroId) {
        continue;
      }
      let list = adjacency.get(macroId);
      if (!list) {
        list = new Set();
        adjacency.set(macroId, list);
      }
      list.add(neighborMacro);
    }
  }
  return adjacency;
}

function transferResources(
  resources: NationResources,
  share: number,
): NationResources {
  const ratio = clamp(share, 0, 1);
  if (ratio <= 0) {
    return createNationResources();
  }
  const taken: NationResources = {
    steel: Math.floor(resources.steel * ratio),
    fuel: Math.floor(resources.fuel * ratio),
    manpower: Math.floor(resources.manpower * ratio),
    weapons: Math.floor(resources.weapons * ratio),
  };
  resources.steel = Math.max(0, resources.steel - taken.steel);
  resources.fuel = Math.max(0, resources.fuel - taken.fuel);
  resources.manpower = Math.max(0, resources.manpower - taken.manpower);
  resources.weapons = Math.max(0, resources.weapons - taken.weapons);
  return taken;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
