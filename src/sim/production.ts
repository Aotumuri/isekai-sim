import { WORLD_BALANCE } from "../data/balance";
import type { MacroRegion } from "../worldgen/macro-region";
import type { MesoRegion, MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import { createUnitForType } from "./create-units";
import type { NationResources } from "./nation-runtime";
import { nextScheduledTickRange } from "./schedule";
import { createUnitId, type UnitState, type UnitType } from "./unit";
import type { WorldState } from "./world-state";
import { getCityTargetsByNation, getOwnerByMesoId } from "./world-cache";

export function updateProduction(world: WorldState): void {
  if (world.nations.length === 0) {
    return;
  }

  const ownerByMesoId = getOwnerByMesoId(world);
  const occupationByMesoId = world.occupation.mesoById;
  const resourceOutputs = collectResourceOutputs(
    world.mesoRegions,
    ownerByMesoId,
    occupationByMesoId,
  );
  const fuelDemandByNation = collectFuelDemandByNation(world.units);
  const fuelAvailableByNation = applyResourceOutputs(
    world.nations,
    resourceOutputs,
    fuelDemandByNation,
  );

  const production = WORLD_BALANCE.production;
  const unitRange = production.unitSlowTickRange;
  if (unitRange.min <= 0 || unitRange.max <= 0) {
    applyFuelStatus(world.units, fuelAvailableByNation);
    return;
  }
  const minInterval = unitRange.min;
  const maxInterval = unitRange.max;
  const occupiedMacroById = world.occupation.macroById;
  const cityTargetsByNation = getCityTargetsByNation(world);
  const unitCountsByNation = collectUnitCountsByNation(world.units);

  const newUnits: UnitState[] = [];
  const cityUnitsPerCycle = Math.max(0, Math.round(production.cityUnitsPerCycle));
  const maxUnitsPerNation = Math.max(0, Math.round(production.maxUnitsPerNation));
  const hasCap = maxUnitsPerNation > 0;

  for (const nation of world.nations) {
    if (world.time.slowTick < nation.nextUnitProductionTick) {
      continue;
    }
    let currentCount = unitCountsByNation.get(nation.id) ?? 0;
    const capacity = hasCap ? maxUnitsPerNation : Number.POSITIVE_INFINITY;
    if (currentCount >= capacity) {
      nation.nextUnitProductionTick = nextScheduledTickRange(
        world.time.slowTick,
        minInterval,
        maxInterval,
        world.simRng,
      );
      continue;
    }

    const addUnit = (regionId: MesoRegionId): boolean => {
      if (currentCount >= capacity) {
        return false;
      }
      const unitType = pickAffordableUnitType(nation.resources, world.simRng);
      if (!unitType) {
        return false;
      }
      if (!consumeResourcesForUnit(nation.resources, unitType)) {
        return false;
      }
      newUnits.push(createUnitForWorld(world, nation.id, regionId, unitType));
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
    nation.nextUnitProductionTick = nextScheduledTickRange(
      world.time.slowTick,
      minInterval,
      maxInterval,
      world.simRng,
    );
  }

  if (newUnits.length > 0) {
    world.units.push(...newUnits);
  }
  applyFuelStatus(world.units, fuelAvailableByNation);
}

function createUnitForWorld(
  world: WorldState,
  nationId: NationId,
  regionId: MesoRegionId,
  unitType: UnitType,
): UnitState {
  const unitId = createUnitId(world.unitIdCounter);
  world.unitIdCounter += 1;
  return createUnitForType(unitId, nationId, regionId, unitType);
}

interface ResourceOutput {
  steel: number;
  fuel: number;
  manpower: number;
  weaponCapacity: number;
}

function collectResourceOutputs(
  mesoRegions: MesoRegion[],
  ownerByMesoId: Map<MesoRegionId, NationId>,
  occupationByMesoId: Map<MesoRegionId, NationId>,
): Map<NationId, ResourceOutput> {
  const outputBalance = WORLD_BALANCE.resources.output;
  const steelPerDeposit = Math.max(0, Math.round(outputBalance.steelPerDeposit));
  const fuelPerDeposit = Math.max(0, Math.round(outputBalance.fuelPerDeposit));
  const manpowerPerCity = Math.max(0, Math.round(outputBalance.manpowerPerCity));
  const manpowerPerCapital = Math.max(0, Math.round(outputBalance.manpowerPerCapital));
  const manpowerPerCityMicro = Math.max(0, outputBalance.manpowerPerCityMicro);
  const manpowerPerCapitalMicro = Math.max(0, outputBalance.manpowerPerCapitalMicro);
  const weaponsPerCity = Math.max(0, outputBalance.weaponsPerCity);
  const weaponsPerCapital = Math.max(0, outputBalance.weaponsPerCapital);

  const outputs = new Map<NationId, ResourceOutput>();
  const ensureOutput = (nationId: NationId): ResourceOutput => {
    const existing = outputs.get(nationId);
    if (existing) {
      return existing;
    }
    const created = { steel: 0, fuel: 0, manpower: 0, weaponCapacity: 0 };
    outputs.set(nationId, created);
    return created;
  };

  for (const meso of mesoRegions) {
    if (meso.type === "sea") {
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

    const output = ensureOutput(owner);
    if (meso.resource === "steel") {
      output.steel += steelPerDeposit;
    } else if (meso.resource === "fuel") {
      output.fuel += fuelPerDeposit;
    }

    const microCount = meso.microRegionIds.length;
    if (meso.building === "city") {
      output.manpower += manpowerPerCity + manpowerPerCityMicro * microCount;
      output.weaponCapacity += weaponsPerCity;
    } else if (meso.building === "capital") {
      output.manpower += manpowerPerCapital + manpowerPerCapitalMicro * microCount;
      output.weaponCapacity += weaponsPerCapital;
    }
  }

  return outputs;
}

function collectFuelDemandByNation(units: UnitState[]): Map<NationId, number> {
  const demands = new Map<NationId, number>();
  for (const unit of units) {
    const fuelUse = getUnitFuelUse(unit.type);
    if (fuelUse <= 0) {
      continue;
    }
    demands.set(unit.nationId, (demands.get(unit.nationId) ?? 0) + fuelUse);
  }
  return demands;
}

function applyResourceOutputs(
  nations: WorldState["nations"],
  outputs: Map<NationId, ResourceOutput>,
  fuelDemandByNation: Map<NationId, number>,
): Map<NationId, boolean> {
  const outputBalance = WORLD_BALANCE.resources.output;
  const steelPerWeapon = Math.max(0, Math.round(outputBalance.steelPerWeapon));
  const fuelAvailability = new Map<NationId, boolean>();

  for (const nation of nations) {
    const resources = nation.resources;
    const output = outputs.get(nation.id);
    if (output) {
      resources.steel = Math.max(0, resources.steel + output.steel);
      resources.fuel = Math.max(0, resources.fuel + output.fuel);
      resources.manpower = Math.max(0, resources.manpower + output.manpower);

      const weaponCapacity = Math.max(0, output.weaponCapacity);
      const maxWeapons = Math.floor(weaponCapacity);
      const maxBySteel =
        steelPerWeapon > 0
          ? Math.floor(resources.steel / steelPerWeapon)
          : maxWeapons;
      const weaponsProduced = Math.max(0, Math.min(maxWeapons, maxBySteel));
      if (weaponsProduced > 0) {
        if (steelPerWeapon > 0) {
          resources.steel = Math.max(
            0,
            resources.steel - weaponsProduced * steelPerWeapon,
          );
        }
        resources.weapons = Math.max(0, resources.weapons + weaponsProduced);
      }
    }

    const fuelDemand = fuelDemandByNation.get(nation.id) ?? 0;
    const hasFuel = resources.fuel > 0;
    if (fuelDemand > 0) {
      resources.fuel = Math.max(0, resources.fuel - fuelDemand);
    }
    fuelAvailability.set(nation.id, hasFuel);
  }

  return fuelAvailability;
}

function applyFuelStatus(
  units: UnitState[],
  fuelAvailableByNation: Map<NationId, boolean>,
): void {
  for (const unit of units) {
    const fuelUse = getUnitFuelUse(unit.type);
    if (fuelUse <= 0) {
      continue;
    }
    const hasFuel = fuelAvailableByNation.get(unit.nationId) ?? true;
    if (hasFuel) {
      unit.moveTicksPerRegion = getBaseMoveTicks(unit.type);
      unit.combatPower = getBaseCombatPower(unit.type);
      continue;
    }
    unit.moveTicksPerRegion = Number.POSITIVE_INFINITY;
    unit.combatPower = 0;
    unit.moveTargetId = null;
    unit.moveFromId = null;
    unit.moveToId = null;
    unit.moveProgressMs = 0;
  }
}

function pickAffordableUnitType(
  resources: NationResources,
  rng: WorldState["simRng"],
): UnitType | null {
  const canInfantry = canAffordUnit(resources, "Infantry");
  const canTank = canAffordUnit(resources, "Tank");
  if (canInfantry && canTank) {
    const tankShare = clamp(WORLD_BALANCE.unit.tankShare, 0, 1);
    return rng.nextFloat() < tankShare ? "Tank" : "Infantry";
  }
  if (canTank) {
    return "Tank";
  }
  if (canInfantry) {
    return "Infantry";
  }
  return null;
}

function consumeResourcesForUnit(
  resources: NationResources,
  unitType: UnitType,
): boolean {
  if (!canAffordUnit(resources, unitType)) {
    return false;
  }
  const weaponCost = getUnitWeaponCost(unitType);
  const manpowerCost = getUnitManpowerCost(unitType);
  resources.weapons = Math.max(0, resources.weapons - weaponCost);
  resources.manpower = Math.max(0, resources.manpower - manpowerCost);
  return true;
}

function canAffordUnit(resources: NationResources, unitType: UnitType): boolean {
  const weaponCost = getUnitWeaponCost(unitType);
  const manpowerCost = getUnitManpowerCost(unitType);
  return resources.weapons >= weaponCost && resources.manpower >= manpowerCost;
}

function getUnitWeaponCost(unitType: UnitType): number {
  const value = WORLD_BALANCE.unit.types[unitType].weaponCost ?? 0;
  return Math.max(0, Math.round(value));
}

function getUnitManpowerCost(unitType: UnitType): number {
  const value = WORLD_BALANCE.unit.types[unitType].manpower ?? 0;
  return Math.max(0, Math.round(value));
}

function getUnitFuelUse(unitType: UnitType): number {
  const value = WORLD_BALANCE.unit.types[unitType].fuelUse ?? 0;
  return Math.max(0, Math.round(value));
}

function getBaseMoveTicks(unitType: UnitType): number {
  const value = WORLD_BALANCE.unit.types[unitType].moveTicksPerRegion ?? 1;
  return Math.max(1, Math.round(value));
}

function getBaseCombatPower(unitType: UnitType): number {
  const value = WORLD_BALANCE.unit.types[unitType].combatPower ?? 0;
  return Math.max(0, value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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
