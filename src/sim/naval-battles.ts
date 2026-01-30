import type { MesoRegion, MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import type { UnitId, UnitState } from "./unit";
import type { WorldState } from "./world-state";
import {
  addWarContribution,
  buildWarAdjacency,
  isAtWar,
} from "./war-state";
import { getMesoById } from "./world-cache";

const DAMAGE_PER_TICK = 4;
const DAMAGE_SCALE = 10_000;
const ORG_DAMAGE_PER_TICK = 0.5;
const ORG_DAMAGE_SCALE = 10_000;

export function updateNavalBattles(world: WorldState): void {
  const navalUnits = world.units.filter((unit) => unit.domain === "naval");
  if (world.wars.length === 0 || navalUnits.length < 2) {
    return;
  }

  const mesoById = getMesoById(world);
  const unitsBySea = collectNavalUnitsBySeaAndNation(navalUnits, mesoById);
  if (unitsBySea.size === 0) {
    return;
  }

  const warAdjacency = buildWarAdjacency(world.wars);
  const removedUnitIds = new Set<UnitId>();

  for (const [, byNation] of unitsBySea.entries()) {
    const entries = [...byNation.entries()];
    if (entries.length < 2) {
      continue;
    }
    for (let i = 0; i < entries.length; i += 1) {
      const [nationA, unitsA] = entries[i];
      for (let j = i + 1; j < entries.length; j += 1) {
        const [nationB, unitsB] = entries[j];
        if (!isAtWar(nationA, nationB, warAdjacency)) {
          continue;
        }
        const aliveA = collectAliveUnits(unitsA, removedUnitIds);
        const aliveB = collectAliveUnits(unitsB, removedUnitIds);
        if (aliveA.length === 0 || aliveB.length === 0) {
          continue;
        }
        const outcome = resolveNavalEngagement(
          aliveA,
          aliveB,
          removedUnitIds,
        );
        if (outcome) {
          addWarContribution(
            world.wars,
            nationA,
            nationB,
            outcome.defenderManpowerLoss,
          );
          addWarContribution(
            world.wars,
            nationB,
            nationA,
            outcome.attackerManpowerLoss,
          );
        }
      }
    }
  }

  if (removedUnitIds.size > 0) {
    world.units = world.units.filter((unit) => {
      if (!removedUnitIds.has(unit.id)) {
        return true;
      }
      if (unit.type === "TransportShip" && unit.cargoUnitIds.length > 0) {
        for (const cargoId of unit.cargoUnitIds) {
          world.embarkedUnits.delete(cargoId);
        }
      }
      return false;
    });
  }
}

function collectNavalUnitsBySeaAndNation(
  units: UnitState[],
  mesoById: Map<MesoRegionId, MesoRegion>,
): Map<MesoRegionId, Map<NationId, UnitState[]>> {
  const unitsByMesoId = new Map<MesoRegionId, Map<NationId, UnitState[]>>();
  for (const unit of units) {
    const meso = mesoById.get(unit.regionId);
    if (!meso || meso.type !== "sea") {
      continue;
    }
    let byNation = unitsByMesoId.get(unit.regionId);
    if (!byNation) {
      byNation = new Map<NationId, UnitState[]>();
      unitsByMesoId.set(unit.regionId, byNation);
    }
    const list = byNation.get(unit.nationId);
    if (list) {
      list.push(unit);
    } else {
      byNation.set(unit.nationId, [unit]);
    }
  }
  return unitsByMesoId;
}

function resolveNavalEngagement(
  unitsA: UnitState[],
  unitsB: UnitState[],
  removedUnitIds: Set<UnitId>,
): { attackerManpowerLoss: number; defenderManpowerLoss: number } | null {
  const attackersA = pickCombatUnits(unitsA);
  const attackersB = pickCombatUnits(unitsB);
  const targetsA = pickEscortedTargets(unitsA);
  const targetsB = pickEscortedTargets(unitsB);

  const strengthA = sumStrength(attackersA);
  const strengthB = sumStrength(attackersB);
  if (strengthA <= 0 && strengthB <= 0) {
    return null;
  }

  const damageToA = strengthB > 0 ? DAMAGE_PER_TICK * (strengthB / DAMAGE_SCALE) : 0;
  const damageToB = strengthA > 0 ? DAMAGE_PER_TICK * (strengthA / DAMAGE_SCALE) : 0;
  const orgDamageToA =
    strengthB > 0 ? ORG_DAMAGE_PER_TICK * (strengthB / ORG_DAMAGE_SCALE) : 0;
  const orgDamageToB =
    strengthA > 0 ? ORG_DAMAGE_PER_TICK * (strengthA / ORG_DAMAGE_SCALE) : 0;

  const lossA = applyNavalDamage(targetsA, damageToA, orgDamageToA, removedUnitIds);
  const lossB = applyNavalDamage(targetsB, damageToB, orgDamageToB, removedUnitIds);

  return {
    attackerManpowerLoss: lossA.manpowerLoss,
    defenderManpowerLoss: lossB.manpowerLoss,
  };
}

function pickCombatUnits(units: UnitState[]): UnitState[] {
  const combatUnits = units.filter((unit) => unit.type === "CombatShip");
  return combatUnits.length > 0 ? combatUnits : units;
}

function pickEscortedTargets(units: UnitState[]): UnitState[] {
  const combatUnits = units.filter((unit) => unit.type === "CombatShip");
  return combatUnits.length > 0 ? combatUnits : units;
}

function collectAliveUnits(
  units: UnitState[],
  removedUnitIds: Set<UnitId>,
): UnitState[] {
  return units.filter((unit) => isUnitAlive(unit, removedUnitIds));
}

function isUnitAlive(unit: UnitState, removedUnitIds: Set<UnitId>): boolean {
  return unit.manpower > 0 && unit.org > 0 && !removedUnitIds.has(unit.id);
}

function sumStrength(units: UnitState[]): number {
  let total = 0;
  for (const unit of units) {
    total += getUnitStrength(unit);
  }
  return total;
}

function getUnitStrength(unit: UnitState): number {
  const avgFill = getAverageEquipmentFill(unit);
  const orgFactor = 0.5 + unit.org * 0.5;
  const equipmentFactor = 0.5 + avgFill * 0.5;
  const landingFactor = getLandingDebuffMultiplier(unit);
  return (
    Math.max(0, unit.manpower) * orgFactor * equipmentFactor * Math.max(0, unit.combatPower)
    * landingFactor
  );
}

function getAverageEquipmentFill(unit: UnitState): number {
  if (unit.equipment.length === 0) {
    return 1;
  }
  let sum = 0;
  for (const slot of unit.equipment) {
    sum += slot.fill;
  }
  return sum / unit.equipment.length;
}

function applyNavalDamage(
  units: UnitState[],
  manpowerDamage: number,
  orgDamage: number,
  removedUnitIds: Set<UnitId>,
): { manpowerLoss: number; orgLoss: number } {
  if (units.length === 0 || (manpowerDamage <= 0 && orgDamage <= 0)) {
    return { manpowerLoss: 0, orgLoss: 0 };
  }

  let totalWeight = 0;
  const weights = new Map<UnitId, number>();
  for (const unit of units) {
    const strength = getUnitStrength(unit);
    const weight = strength > 0 ? strength : Math.max(1, unit.manpower);
    weights.set(unit.id, weight);
    totalWeight += weight;
  }
  if (totalWeight <= 0) {
    return { manpowerLoss: 0, orgLoss: 0 };
  }

  let manpowerLoss = 0;
  let orgLoss = 0;
  for (const unit of units) {
    if (!isUnitAlive(unit, removedUnitIds)) {
      continue;
    }
    const weight = weights.get(unit.id) ?? 0;
    if (weight <= 0) {
      continue;
    }
    const share = weight / totalWeight;
    const prevManpower = unit.manpower;
    const prevOrg = unit.org;
    if (manpowerDamage > 0) {
      unit.manpower = Math.max(0, unit.manpower - manpowerDamage * share);
    }
    if (orgDamage > 0) {
      unit.org = Math.max(0, unit.org - orgDamage * share);
    }
    manpowerLoss += Math.max(0, prevManpower - unit.manpower);
    orgLoss += Math.max(0, prevOrg - unit.org);
    if (unit.manpower <= 0 || unit.org <= 0) {
      removedUnitIds.add(unit.id);
    }
  }

  return { manpowerLoss, orgLoss };
}

function getLandingDebuffMultiplier(unit: UnitState): number {
  if (unit.domain !== "land") {
    return 1;
  }
  if (unit.landingDebuffTicks <= 0) {
    return 1;
  }
  const value = unit.landingDebuffMultiplier;
  return clamp(value, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
