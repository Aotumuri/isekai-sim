import { splitTreasury } from "./treasury";
import { updateDomesticUnrest, canRevolt, recordRevolution } from "./domestic-unrest";
import { establishRevolutionaryGovernment } from "./politics";
import { getNationName } from "./nation-identity";
import { recordSimulationEvent } from "./simulation-settings";
import { WORLD_BALANCE } from "../data/balance";
import type { MacroRegion, MacroRegionId } from "../worldgen/macro-region";
import type { MesoRegion, MesoRegionId } from "../worldgen/meso-region";
import { createNationId, type NationId } from "../worldgen/nation";
import { connectedRegionGroups } from "./peace-borders";
import {
  createNationResourceFlow,
  createNationResources,
  type NationRuntime,
  type NationResources,
} from "./nation-runtime";
import { nextScheduledTickRange } from "./schedule";
import { inheritTerritorialClaims, updateTerritorialClaims } from "./territorial-claims";
import type { UnitState } from "./unit";
import { declareWar } from "./war-state";
import type { WorldState } from "./world-state";
import { getMacroAdjacency, getMesoById, getNeighborsById } from "./world-cache";

export function updateCivilWar(world: WorldState): void {
  if (world.nations.length === 0) {
    return;
  }

  const cooperationBalance = WORLD_BALANCE.war.cooperation;
  const civilWarBalance = WORLD_BALANCE.war.civilWar;
  if (!civilWarBalance.enabled) {
    return;
  }
  updateDomesticUnrest(world);
  const mesoById = getMesoById(world);
  const mesoToMacro = buildMesoToMacroMap(world.macroRegions);
  const macroAdjacency = getMacroAdjacency(world);

  const nationsSnapshot = [...world.nations];
  let territoryChanged = false;
  let buildingChanged = false;

  for (const nation of nationsSnapshot) {
    if (!canRevolt(world, nation.id)) {
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
    let uprising = pickRebelTerritory(world, nation, cityCandidates, mesoToMacro, macroAdjacency);
    if (!uprising) {
      const alternateSeats = world.macroRegions.filter((macro) => macro.nationId === nation.id)
        .flatMap((macro) => {
          const seat = macro.mesoRegionIds.find((id) => mesoById.get(id)?.type === "land" &&
            mesoById.get(id)?.building === null && !world.occupation.mesoById.has(id));
          return seat ? [seat] : [];
        });
      uprising = pickRebelTerritory(world, nation, alternateSeats, mesoToMacro, macroAdjacency);
    }
    if (!uprising) continue;
    const { cityMesoId, rebelMacroIds } = uprising;

    const rebelMesoIds = collectMesoIdsForMacros(
      world.macroRegions,
      rebelMacroIds,
    );
    if (demoteExtraCapitals(rebelMesoIds, mesoById, cityMesoId)) {
      buildingChanged = true;
    }
    const newNationId = createNationId(world.nations.length);
    // Record tenure through the split while the old borders are still intact.
    if (!territoryChanged) updateTerritorialClaims(world);
    inheritTerritorialClaims(world, nation.id, newNationId, rebelMesoIds);
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
    const declareBalance = WORLD_BALANCE.war.declare;
    const declareRange = declareBalance.slowTickRange;
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
      treasury: splitTreasury(nation.treasury, rebelShare),
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
    establishRevolutionaryGovernment(world, nation, newNation);
    recordRevolution(world, nation.id, newNationId);
    recordSimulationEvent(world, { category: "diplomacy", nationIds: [nation.id, newNationId],
      message: `Revolution in ${getNationName(world, nation.id)} after sustained domestic unrest; ${getNationName(world, newNationId)} declared independence.` });

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

function pickRebelTerritory(
  world: WorldState,
  nation: NationRuntime,
  cities: MesoRegionId[],
  mesoToMacro: Map<MesoRegionId, MacroRegionId>,
  macroAdjacency: Map<MacroRegionId, Set<MacroRegionId>>,
): { cityMesoId: MesoRegionId; rebelMacroIds: Set<MacroRegionId> } | undefined {
  if (!cities.length) return;
  const capitalProvince = mesoToMacro.get(nation.capitalMesoId);
  const provinces = new Map(world.macroRegions.filter((macro) => macro.nationId === nation.id)
    .map((macro) => [macro.id, macro.mesoRegionIds]));
  const regions = getMesoById(world), neighbors = getNeighborsById(world);
  const parentLand = new Set([...provinces.values()].flat().filter((id) => regions.get(id)?.type !== "sea"));
  const originalComponents = connectedRegionGroups(parentLand, neighbors);
  const split = (macroIds: Set<MacroRegionId>) => {
    const rebelLand = new Set([...macroIds].flatMap((id) => provinces.get(id) ?? []).filter((id) => parentLand.has(id)));
    if (connectedRegionGroups(rebelLand, neighbors).length !== 1) return null;
    for (const component of originalComponents) {
      if (!component.some((id) => rebelLand.has(id))) continue;
      const remaining = new Set(component.filter((id) => !rebelLand.has(id)));
      if (connectedRegionGroups(remaining, neighbors).length > 1) return null;
    }
    return rebelLand;
  };

  // Try the randomly chosen city first, then another when it would sever a corridor.
  const first = world.simRng.nextInt(cities.length);
  let inlandUprising: ReturnType<typeof pickRebelTerritory>;
  for (let offset = 0; offset < cities.length; offset += 1) {
    const cityMesoId = cities[(first + offset) % cities.length];
    const seed = mesoToMacro.get(cityMesoId);
    if (!seed || seed === capitalProvince) continue;
    const rebelMacroIds = new Set([seed]);
    let rebelLand = split(rebelMacroIds);
    for (const id of macroAdjacency.get(seed) ?? []) {
      if (id === capitalProvince || !provinces.has(id) || rebelMacroIds.size >= provinces.size - 1) continue;
      const expanded = split(new Set([...rebelMacroIds, id]));
      if (expanded) {
        rebelMacroIds.add(id);
        rebelLand = expanded;
      }
    }
    if (!rebelLand) continue;
    const uprising = { cityMesoId, rebelMacroIds };
    if ([...rebelLand].some((id) => (neighbors.get(id) ?? []).some((next) => !parentLand.has(next)))) return uprising;
    inlandUprising ??= uprising;
  }
  return inlandUprising;
}

function reassignUnitsToRebels(
  units: UnitState[],
  nationId: NationId,
  rebelNationId: NationId,
  rebelMesoIds: Set<MesoRegionId>,
): number {
  let assigned = 0;
  for (const unit of units) {
    if (unit.nationId !== nationId || unit.volunteerOriginId || unit.exileOriginId) {
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
