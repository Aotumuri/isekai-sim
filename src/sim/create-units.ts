import type { Nation } from "../worldgen/nation";
import { createUnitId, type UnitEquipmentSlot, type UnitState } from "./unit";

const DEFAULT_EQUIPMENT: UnitEquipmentSlot[] = [
  { equipmentKey: "rifle_m1", fill: 0.8 },
  { equipmentKey: "rifle_m2", fill: 0.2 },
];

export function createInitialUnits(nations: Nation[]): UnitState[] {
  return nations.map((nation, index) => ({
    id: createUnitId(index),
    nationId: nation.id,
    regionId: nation.capitalMesoId,
    type: "Infantry",
    equipment: DEFAULT_EQUIPMENT.map((slot) => ({ ...slot })),
    org: 0.75,
    manpower: 1200,
  }));
}
