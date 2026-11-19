import { getDesignTransportCapacity, getDesignUtility } from "./unit-capabilities";
import { WORLD_BALANCE } from "../data/balance";
import { isAmphibiousOwnedUnit } from "./amphibious";
import { getNationalDesign, getResearchState, FAMILY_RESEARCH_BRANCHES, type WeaponDesign } from "./research";
import type { NationRuntime } from "./nation-runtime";
import { effectiveResearchLevel } from "./research-progression";
import { isNationActive } from "./nation-active";
import { isNationRegionSupplied } from "./supply-assessment";
import { recordSimulationEvent } from "./simulation-settings";
import type { UnitId, UnitState, UnitType } from "./unit";
import { getMesoById, getOwnerByMesoId } from "./world-cache";
import type { WorldState } from "./world-state";

const REFIT_IMPROVEMENT_MULTIPLIER = 1.02;

export function getDevelopedUnitWeaponCost(type: UnitType, design?: WeaponDesign): number {
  return Math.ceil(WORLD_BALANCE.unit.types[type].weaponCost * (design?.weaponCost ?? 1) - 1e-9);
}
export function equipNewUnit(world: WorldState, unit: UnitState, design?: WeaponDesign): UnitState {
  if (world.research?.byNationId.has(unit.nationId)) unit.design = design ?? getNationalDesign(world, unit.nationId, unit.type);
  return unit;
}
export function canRefitUnit(world: WorldState, unit: UnitState): boolean {
  const region = getMesoById(world).get(unit.regionId);
  const owner = world.occupation.mesoById.get(unit.regionId) ?? getOwnerByMesoId(world).get(unit.regionId);
  return !unit.cargoUnits.length && unit.manpower > 0 && unit.org >= 0.55 && !unit.moveToId && owner === unit.nationId &&
    !!region?.building && isNationRegionSupplied(world, unit.nationId, unit.regionId) &&
    !isAmphibiousOwnedUnit(world, unit.id) && !world.battles.some((battle) => battle.mesoId === unit.regionId &&
      (battle.attackerNationId === unit.nationId || battle.defenderNationId === unit.nationId));
}
export function refitUnit(world: WorldState, unitId: UnitId): boolean {
  if (!world.settings?.researchEnabled) return false;
  const unit = world.units.find((item) => item.id === unitId);
  const nation = unit && world.nations.find((item) => item.id === unit.nationId && isNationActive(item));
  if (!unit || !nation) return false;
  return applyRefit(world, unit, nation, getNationalDesign(world, nation.id, unit.type), false);
}

function hasMaterialUpgrade(type: UnitType, design: WeaponDesign, current: WeaponDesign | undefined): boolean {
  // The fleet fields incremental improvements together once one is large enough
  // to justify paying for the retrofit. Check rounded costs and actual payload.
  return design.recovery > (current?.recovery ?? 1) * REFIT_IMPROVEMENT_MULTIPLIER ||
    (current?.fuelUse ?? 1) > design.fuelUse * REFIT_IMPROVEMENT_MULTIPLIER ||
    (current?.steelCost ?? 1) > design.steelCost * REFIT_IMPROVEMENT_MULTIPLIER ||
    getDevelopedUnitWeaponCost(type, design) < getDevelopedUnitWeaponCost(type, current) ||
    (type === "TransportShip" && getDesignTransportCapacity(design) > getDesignTransportCapacity(current));
}

function applyRefit(world: WorldState, unit: UnitState, nation: NationRuntime, design: WeaponDesign, automatic: boolean): boolean {
  const current = unit.design;
  if (current?.family && design.generation <= current.generation) return false;
  let addedEffect = 0;
  for (const branch of FAMILY_RESEARCH_BRANCHES[unit.type]) {
    const deployedLevel = current?.levels[branch] ?? 0;
    if (design.levels[branch] > deployedLevel) {
      addedEffect += effectiveResearchLevel(design.levels[branch]) - effectiveResearchLevel(deployedLevel);
    }
  }
  if (addedEffect <= 0) return false;
  // A legacy global generation can include levels outside this equipment family.
  const utility = getDesignUtility(design), currentUtility = getDesignUtility(current);
  if (design.generation <= (current?.generation ?? 0) && utility <= currentUtility * REFIT_IMPROVEMENT_MULTIPLIER) return false;
  // An imported weapon is kept until the domestic design actually catches up.
  if (current && utility < currentUtility * 0.95) return false;
  // Preserve early fielding and batch late advances once they are perceptible.
  if (automatic && utility <= currentUtility * REFIT_IMPROVEMENT_MULTIPLIER &&
      FAMILY_RESEARCH_BRANCHES[unit.type].some((branch) => design.levels[branch] > 10) &&
      !hasMaterialUpgrade(unit.type, design, current)) return false;
  const weapons = Math.max(1, Math.ceil(getDevelopedUnitWeaponCost(unit.type, design) * 0.25));
  const steel = Math.max(1, addedEffect * 0.5 * design.steelCost);
  if (nation.resources.weapons < weapons + 6 || nation.resources.steel < steel + 6 || !canRefitUnit(world, unit)) return false;
  nation.resources.weapons -= weapons; nation.resources.steel -= steel;
  nation.resourceFlow.usage.weapons += weapons; nation.resourceFlow.delta.weapons -= weapons;
  nation.resourceFlow.usage.steel += steel; nation.resourceFlow.delta.steel -= steel;
  unit.design = design; unit.org = Math.max(0.55, unit.org - 0.03);
  const research = getResearchState(world);
  research.retrofits += 1;
  if (research.refitAnnouncedGenerationByNationId.get(`${unit.nationId}|${unit.type}`) !== design.generation) {
    research.refitAnnouncedGenerationByNationId.set(`${unit.nationId}|${unit.type}`, design.generation);
    recordSimulationEvent(world, { category: "research", nationIds: [unit.nationId],
      message: `${unit.nationId} began fielding generation ${design.generation} ${unit.type} equipment; supplied units refit gradually.` });
  }
  return true;
}
export function updateEquipmentRefits(world: WorldState): void {
  if (!world.settings?.researchEnabled) return;
  const state = getResearchState(world);
  if (world.time.slowTick - state.lastRetrofitSlowTick < 10) return;
  state.lastRetrofitSlowTick = world.time.slowTick;
  const counts = new Map<string, number>();
  const nations = new Map(world.nations.filter(isNationActive).map((nation) => [nation.id, nation]));
  const designs = new Map<string, WeaponDesign>();
  for (const unit of [...world.units].sort((a, b) => a.id.localeCompare(b.id))) {
    if ((counts.get(unit.nationId) ?? 0) >= 2) continue;
    const nation = nations.get(unit.nationId);
    if (!nation || !state.byNationId.has(nation.id)) continue;
    const key = `${nation.id}|${unit.type}`;
    let design = designs.get(key);
    if (!design) {
      design = getNationalDesign(world, nation.id, unit.type);
      designs.set(key, design);
    }
    if (applyRefit(world, unit, nation, design, true)) counts.set(nation.id, (counts.get(nation.id) ?? 0) + 1);
  }
}
