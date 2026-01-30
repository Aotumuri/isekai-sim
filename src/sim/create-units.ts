import { WORLD_BALANCE } from "../data/balance";
import type { SeededRng } from "../utils/seeded-rng";
import type { MacroRegion } from "../worldgen/macro-region";
import type { MesoRegion, MesoRegionId } from "../worldgen/meso-region";
import type { Nation, NationId } from "../worldgen/nation";
import {
  createUnitId,
  type UnitEquipmentSlot,
  type UnitId,
  type UnitState,
  type UnitType,
  type LandUnitType,
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

export function createTransportShip(
  id: UnitId,
  nationId: NationId,
  regionId: MesoRegionId,
): UnitState {
  return createUnitForType(id, nationId, regionId, "TransportShip");
}

export function createCombatShip(
  id: UnitId,
  nationId: NationId,
  regionId: MesoRegionId,
): UnitState {
  return createUnitForType(id, nationId, regionId, "CombatShip");
}

export function createUnitForType(
  id: UnitId,
  nationId: NationId,
  regionId: MesoRegionId,
  type: UnitType,
): UnitState {
  const settings = WORLD_BALANCE.unit.types[type];
  const domain = settings.domain ?? "land";
  const equipment =
    domain === "naval" ? [] : DEFAULT_EQUIPMENT.map((slot) => ({ ...slot }));
  const transportCapacity = Math.max(0, Math.round(settings.transportCapacity ?? 0));
  return {
    id,
    nationId,
    regionId,
    type,
    domain,
    equipment,
    moveTicksPerRegion: Math.max(1, Math.round(settings.moveTicksPerRegion)),
    combatPower: Math.max(0, settings.combatPower),
    org: clamp(settings.org, 0, 1),
    manpower: Math.max(0, settings.manpower),
    landingDebuffTicks: 0,
    landingDebuffMultiplier: 1,
    transportCapacity,
    cargoUnitIds: [],
    cargoOriginId: null,
    moveTargetId: null,
    moveFromId: null,
    moveToId: null,
    moveProgressMs: 0,
  };
}

export function pickUnitType(rng: SeededRng): LandUnitType {
  const tankShare = clamp(WORLD_BALANCE.unit.tankShare, 0, 1);
  return rng.nextFloat() < tankShare ? "Tank" : "Infantry";
}

export function createInitialUnits(
  nations: Nation[],
  mesoRegions: MesoRegion[],
  macroRegions: MacroRegion[],
  rng: SeededRng,
): UnitState[] {
  const units: UnitState[] = [];
  let unitIndex = 0;
  const mesoById = new Map<MesoRegionId, MesoRegion>();
  for (const meso of mesoRegions) {
    mesoById.set(meso.id, meso);
  }
  const ownerByMesoId = buildOwnerByMesoId(macroRegions);
  const portsByNation = collectPortsByNation(mesoRegions, ownerByMesoId);
  const coastalSeasByNation = collectCoastalSeasByNation(
    mesoRegions,
    mesoById,
    ownerByMesoId,
  );

  for (const nation of nations) {
    const count = Math.max(1, Math.floor(nation.macroRegionIds.length / 0.5));
    for (let i = 0; i < count; i += 1) {
      const unitId = createUnitId(unitIndex);
      const unitType = pickUnitType(rng);
      units.push(createUnitForType(unitId, nation.id, nation.capitalMesoId, unitType));
      unitIndex += 1;
    }

    const navalSpawnId = pickNavalSpawnId(
      nation.id,
      nation.capitalMesoId,
      portsByNation,
      coastalSeasByNation,
      rng,
    );
    if (navalSpawnId) {
      const unitId = createUnitId(unitIndex);
      units.push(createCombatShip(unitId, nation.id, navalSpawnId));
      unitIndex += 1;
    }
  }

  return units;
}

function buildOwnerByMesoId(
  macroRegions: MacroRegion[],
): Map<MesoRegionId, NationId> {
  const ownerByMesoId = new Map<MesoRegionId, NationId>();
  for (const macro of macroRegions) {
    for (const mesoId of macro.mesoRegionIds) {
      ownerByMesoId.set(mesoId, macro.nationId);
    }
  }
  return ownerByMesoId;
}

function collectPortsByNation(
  mesoRegions: MesoRegion[],
  ownerByMesoId: Map<MesoRegionId, NationId>,
): Map<NationId, MesoRegionId[]> {
  const portsByNation = new Map<NationId, MesoRegionId[]>();
  for (const meso of mesoRegions) {
    if (meso.building !== "port") {
      continue;
    }
    const owner = ownerByMesoId.get(meso.id);
    if (!owner) {
      continue;
    }
    const list = portsByNation.get(owner);
    if (list) {
      list.push(meso.id);
    } else {
      portsByNation.set(owner, [meso.id]);
    }
  }
  return portsByNation;
}

function collectCoastalSeasByNation(
  mesoRegions: MesoRegion[],
  mesoById: Map<MesoRegionId, MesoRegion>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
): Map<NationId, MesoRegionId[]> {
  const seasByNation = new Map<NationId, Set<MesoRegionId>>();
  for (const meso of mesoRegions) {
    if (meso.type === "sea") {
      continue;
    }
    const owner = ownerByMesoId.get(meso.id);
    if (!owner) {
      continue;
    }
    for (const neighbor of meso.neighbors) {
      const neighborMeso = mesoById.get(neighbor.id);
      if (!neighborMeso || neighborMeso.type !== "sea") {
        continue;
      }
      let set = seasByNation.get(owner);
      if (!set) {
        set = new Set<MesoRegionId>();
        seasByNation.set(owner, set);
      }
      set.add(neighborMeso.id);
    }
  }
  const result = new Map<NationId, MesoRegionId[]>();
  for (const [nationId, set] of seasByNation.entries()) {
    result.set(nationId, [...set]);
  }
  return result;
}

function pickNavalSpawnId(
  nationId: NationId,
  fallbackId: MesoRegionId,
  portsByNation: Map<NationId, MesoRegionId[]>,
  coastalSeasByNation: Map<NationId, MesoRegionId[]>,
  rng: SeededRng,
): MesoRegionId | null {
  const ports = portsByNation.get(nationId) ?? [];
  if (ports.length > 0) {
    return ports[rng.nextInt(ports.length)];
  }
  const seas = coastalSeasByNation.get(nationId) ?? [];
  if (seas.length > 0) {
    return seas[rng.nextInt(seas.length)];
  }
  return fallbackId;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
