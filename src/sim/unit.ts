import type { EquipmentKey } from "../data/equipment-catalog";
import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";

export type UnitId = string & { __brand: "UnitId" };

export type LandUnitType = "Infantry" | "Tank";
export type NavalUnitType = "TransportShip" | "CombatShip";
export type UnitType = LandUnitType | NavalUnitType;
export type UnitDomain = "land" | "naval";

export interface UnitEquipmentSlot {
  equipmentKey: EquipmentKey;
  fill: number;
}

export interface UnitState {
  id: UnitId;
  nationId: NationId;
  regionId: MesoRegionId;
  type: UnitType;
  domain: UnitDomain;
  equipment: UnitEquipmentSlot[];
  moveTicksPerRegion: number;
  combatPower: number;
  org: number;
  manpower: number;
  moveTargetId: MesoRegionId | null;
  moveFromId: MesoRegionId | null;
  moveToId: MesoRegionId | null;
  moveProgressMs: number;
}

export function createUnitId(index: number): UnitId {
  return `unit-${index}` as UnitId;
}
