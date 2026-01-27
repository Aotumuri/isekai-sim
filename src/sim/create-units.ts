import { WORLD_BALANCE } from "../data/balance";
import type { SeededRng } from "../utils/seeded-rng";
import type { MesoRegionId } from "../worldgen/meso-region";
import type { Nation, NationId } from "../worldgen/nation";
import {
  createUnitId,
  type UnitEquipmentSlot,
  type UnitId,
  type UnitState,
  type UnitType,
} from "./unit";

const DEFAULT_EQUIPMENT: UnitEquipmentSlot[] = [
  { equipmentKey: "rifle_m1", fill: 0.8 },
  { equipmentKey: "rifle_m2", fill: 0.2 },
];

export function createDefaultUnit(
  id: UnitId,
  nationId: NationId,
  regionId: MesoRegionId,
): UnitState {
  return createUnitForType(id, nationId, regionId, "Infantry");
}

export function createTankUnit(
  id: UnitId,
  nationId: NationId,
  regionId: MesoRegionId,
): UnitState {
  return createUnitForType(id, nationId, regionId, "Tank");
}

export function createUnitForType(
  id: UnitId,
  nationId: NationId,
  regionId: MesoRegionId,
  type: UnitType,
): UnitState {
  const settings = WORLD_BALANCE.unit.types[type];
  return {
    id,
    nationId,
    regionId,
    type,
    equipment: DEFAULT_EQUIPMENT.map((slot) => ({ ...slot })),
    moveTicksPerRegion: Math.max(1, Math.round(settings.moveTicksPerRegion)),
    combatPower: Math.max(0, settings.combatPower),
    org: clamp(settings.org, 0, 1),
    manpower: Math.max(0, settings.manpower),
    moveTargetId: null,
    moveFromId: null,
    moveToId: null,
    moveProgressMs: 0,
  };
}

export function pickUnitType(rng: SeededRng): UnitType {
  const tankShare = clamp(WORLD_BALANCE.unit.tankShare, 0, 1);
  return rng.nextFloat() < tankShare ? "Tank" : "Infantry";
}

export function createInitialUnits(nations: Nation[], rng: SeededRng): UnitState[] {
  const units: UnitState[] = [];
  let unitIndex = 0;

  for (const nation of nations) {
    const count = Math.max(1, Math.floor(nation.macroRegionIds.length / 0.5));
    for (let i = 0; i < count; i += 1) {
      const unitId = createUnitId(unitIndex);
      const unitType = pickUnitType(rng);
      units.push(createUnitForType(unitId, nation.id, nation.capitalMesoId, unitType));
      unitIndex += 1;
    }
  }

  return units;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
