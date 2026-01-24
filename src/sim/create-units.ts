import type { MesoRegionId } from "../worldgen/meso-region";
import type { Nation, NationId } from "../worldgen/nation";
import { createUnitId, type UnitEquipmentSlot, type UnitId, type UnitState } from "./unit";

const DEFAULT_EQUIPMENT: UnitEquipmentSlot[] = [
  { equipmentKey: "rifle_m1", fill: 0.8 },
  { equipmentKey: "rifle_m2", fill: 0.2 },
];

export function createDefaultUnit(
  id: UnitId,
  nationId: NationId,
  regionId: MesoRegionId,
): UnitState {
  return {
    id,
    nationId,
    regionId,
    type: "Infantry",
    equipment: DEFAULT_EQUIPMENT.map((slot) => ({ ...slot })),
    org: 0.75,
    manpower: 1200,
    moveTargetId: null,
    moveFromId: null,
    moveToId: null,
    moveProgressMs: 0,
  };
}

export function createInitialUnits(nations: Nation[]): UnitState[] {
  const units: UnitState[] = [];
  let unitIndex = 0;

  for (const nation of nations) {
    const count = Math.max(1, Math.floor(nation.macroRegionIds.length / 0.5));
    for (let i = 0; i < count; i += 1) {
      const unitId = createUnitId(unitIndex);
      units.push(createDefaultUnit(unitId, nation.id, nation.capitalMesoId));
      unitIndex += 1;
    }
  }

  return units;
}
