import type { EquipmentKey } from "../data/equipment-catalog";
import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";

export type UnitId = string & { __brand: "UnitId" };

export type UnitType = "Infantry";

export interface UnitEquipmentSlot {
  equipmentKey: EquipmentKey;
  fill: number;
}

export interface UnitState {
  id: UnitId;
  nationId: NationId;
  regionId: MesoRegionId;
  type: UnitType;
  equipment: UnitEquipmentSlot[];
  org: number;
  manpower: number;
  moveTargetId: MesoRegionId | null;
  moveProgressMs: number;
}

export function createUnitId(index: number): UnitId {
  return `unit-${index}` as UnitId;
}
