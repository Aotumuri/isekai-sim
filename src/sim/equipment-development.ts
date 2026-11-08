import { WORLD_BALANCE } from "../data/balance";
import { isAmphibiousOwnedUnit } from "./amphibious";
import { getNationalDesign, getResearchState, type WeaponDesign } from "./research";
import { isNationActive } from "./nation-active";
import { isNationRegionSupplied } from "./supply-assessment";
import { recordSimulationEvent } from "./simulation-settings";
import type { UnitId, UnitState, UnitType } from "./unit";
import { getMesoById, getOwnerByMesoId } from "./world-cache";
import type { WorldState } from "./world-state";

export function getDevelopedUnitWeaponCost(type: UnitType, design?: WeaponDesign): number {
  return Math.ceil(WORLD_BALANCE.unit.types[type].weaponCost * (design?.weaponCost ?? 1) - 1e-9);
}
export function equipNewUnit(world: WorldState, unit: UnitState): UnitState {
  if (world.research?.byNationId.has(unit.nationId)) unit.design = getNationalDesign(world, unit.nationId);
  return unit;
}
export function canRefitUnit(world: WorldState, unit: UnitState): boolean {
  const region = getMesoById(world).get(unit.regionId);
  const owner = world.occupation.mesoById.get(unit.regionId) ?? getOwnerByMesoId(world).get(unit.regionId);
  return unit.manpower > 0 && unit.org >= 0.55 && !unit.moveToId && owner === unit.nationId &&
    !!region?.building && isNationRegionSupplied(world, unit.nationId, unit.regionId) &&
    !isAmphibiousOwnedUnit(world, unit.id) && !world.battles.some((battle) => battle.mesoId === unit.regionId &&
      (battle.attackerNationId === unit.nationId || battle.defenderNationId === unit.nationId));
}
export function refitUnit(world: WorldState, unitId: UnitId): boolean {
  if (!world.settings?.researchEnabled) return false;
  const unit = world.units.find((item) => item.id === unitId);
  if (!unit || !canRefitUnit(world, unit)) return false;
  const design = getNationalDesign(world, unit.nationId);
  if (design.generation <= (unit.design?.generation ?? 0)) return false;
  // An imported weapon is kept until the domestic design actually catches up.
  if (unit.design && design.firepower * design.reliability < unit.design.firepower * unit.design.reliability * 0.95) return false;
  const nation = world.nations.find((item) => item.id === unit.nationId && isNationActive(item));
  if (!nation) return false;
  const weapons = Math.max(1, Math.ceil(getDevelopedUnitWeaponCost(unit.type, design) * 0.25));
  const steel = Math.max(1, (design.generation - (unit.design?.generation ?? 0)) * 0.5);
  if (nation.resources.weapons < weapons + 6 || nation.resources.steel < steel + 6) return false;
  nation.resources.weapons -= weapons; nation.resources.steel -= steel;
  nation.resourceFlow.usage.weapons += weapons; nation.resourceFlow.delta.weapons -= weapons;
  nation.resourceFlow.usage.steel += steel; nation.resourceFlow.delta.steel -= steel;
  unit.design = design; unit.org = Math.max(0.55, unit.org - 0.03);
  const research = getResearchState(world);
  research.retrofits += 1;
  if (research.refitAnnouncedGenerationByNationId.get(unit.nationId) !== design.generation) {
    research.refitAnnouncedGenerationByNationId.set(unit.nationId, design.generation);
    recordSimulationEvent(world, { category: "research", nationIds: [unit.nationId],
      message: `${unit.nationId} began fielding generation ${design.generation} equipment; supplied units refit gradually.` });
  }
  return true;
}
export function updateEquipmentRefits(world: WorldState): void {
  if (!world.settings?.researchEnabled) return;
  const state = getResearchState(world);
  if (world.time.slowTick - state.lastRetrofitSlowTick < 10) return;
  state.lastRetrofitSlowTick = world.time.slowTick;
  const counts = new Map<string, number>();
  for (const unit of [...world.units].sort((a, b) => a.id.localeCompare(b.id))) {
    if ((counts.get(unit.nationId) ?? 0) >= 2) continue;
    if (refitUnit(world, unit.id)) counts.set(unit.nationId, (counts.get(unit.nationId) ?? 0) + 1);
  }
}
