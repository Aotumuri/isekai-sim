import type { UnitState } from "./unit";

export function getUnitCombatStrength(unit: UnitState): number {
  return getUnitDamageWeight(unit) * Math.max(0, unit.combatPower);
}

export function getUnitDamageWeight(unit: UnitState): number {
  const avgFill = getAverageEquipmentFill(unit);
  const orgFactor = 0.5 + unit.org * 0.5;
  const equipmentFactor = 0.5 + avgFill * 0.5;
  return Math.max(0, unit.manpower) * orgFactor * equipmentFactor;
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
