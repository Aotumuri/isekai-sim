import type { MesoRegion, MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import type { UnitId, UnitState } from "./unit";
import type { WorldState } from "./world-state";
import { buildWarAdjacency, isAtWar } from "./war-state";
import { getMesoById, getNeighborsById, getOwnerByMesoId } from "./world-cache";

const LANDING_DEBUFF_TICKS = 120;
const FORCED_LANDING_DEBUFF_MULTIPLIER = 0.4;

export function updateTransports(world: WorldState): void {
  if (world.units.length === 0) {
    return;
  }

  const mesoById = getMesoById(world);
  const neighborsById = getNeighborsById(world);
  const ownerByMesoId = getOwnerByMesoId(world);
  const occupationByMesoId = world.occupation.mesoById;
  const warAdjacency = buildWarAdjacency(world.wars);
  const landUnitsByRegion = collectLandUnitsByRegion(world.units);
  const combatShipsByRegion = collectCombatShipsByRegion(world.units);
  const toRemove = new Set<UnitId>();
  const toAdd: UnitState[] = [];

  for (const unit of world.units) {
    if (unit.type !== "TransportShip" || unit.domain !== "naval") {
      continue;
    }
    const meso = mesoById.get(unit.regionId);
    if (!meso) {
      continue;
    }
    const occupier = occupationByMesoId.get(meso.id);
    const isOwnedPort =
      meso.building === "port" &&
      ownerByMesoId.get(meso.id) === unit.nationId &&
      (!occupier || occupier === unit.nationId);

    if (unit.cargoUnitIds.length > 0) {
      if (meso.type === "sea" && unit.cargoOriginId) {
        unit.cargoOriginId = null;
      }
      if (isOwnedPort && !unit.cargoOriginId) {
        unloadCargo(unit, world.embarkedUnits, toAdd);
      } else if (meso.type === "sea" && !unit.cargoOriginId) {
        if (unit.moveTargetId && unit.moveTargetId !== unit.regionId) {
          continue;
        }
        const decision = getLandingDecision(unit, combatShipsByRegion, warAdjacency);
        if (!decision.canLand) {
          continue;
        }
        const targetId = pickAmphibiousTarget(
          unit.regionId,
          neighborsById,
          mesoById,
          ownerByMesoId,
          warAdjacency,
          unit.nationId,
        );
        if (targetId) {
          unloadCargoToRegion(
            unit,
            targetId,
            decision.debuffMultiplier,
            world.embarkedUnits,
            toAdd,
          );
        }
      }
    } else if (isOwnedPort) {
      loadCargo(
        unit,
        landUnitsByRegion,
        toRemove,
        world.embarkedUnits,
      );
    }
  }

  if (toRemove.size > 0) {
    world.units = world.units.filter((unit) => !toRemove.has(unit.id));
  }
  if (toAdd.length > 0) {
    world.units.push(...toAdd);
  }
  tickLandingDebuffs(world.units);
  tickLandingDebuffs(world.embarkedUnits.values());
}

function collectLandUnitsByRegion(
  units: UnitState[],
): Map<MesoRegionId, UnitState[]> {
  const byRegion = new Map<MesoRegionId, UnitState[]>();
  for (const unit of units) {
    if (unit.domain !== "land") {
      continue;
    }
    const list = byRegion.get(unit.regionId);
    if (list) {
      list.push(unit);
    } else {
      byRegion.set(unit.regionId, [unit]);
    }
  }
  return byRegion;
}

function collectCombatShipsByRegion(
  units: UnitState[],
): Map<MesoRegionId, Map<NationId, number>> {
  const byRegion = new Map<MesoRegionId, Map<NationId, number>>();
  for (const unit of units) {
    if (unit.type !== "CombatShip") {
      continue;
    }
    let byNation = byRegion.get(unit.regionId);
    if (!byNation) {
      byNation = new Map<NationId, number>();
      byRegion.set(unit.regionId, byNation);
    }
    byNation.set(unit.nationId, (byNation.get(unit.nationId) ?? 0) + 1);
  }
  return byRegion;
}

function getLandingDecision(
  transport: UnitState,
  combatShipsByRegion: Map<MesoRegionId, Map<NationId, number>>,
  warAdjacency: ReturnType<typeof buildWarAdjacency>,
): { canLand: boolean; debuffMultiplier: number } {
  const byNation = combatShipsByRegion.get(transport.regionId);
  if (!byNation) {
    return { canLand: true, debuffMultiplier: 1 };
  }
  let enemy = 0;
  for (const [nationId, count] of byNation.entries()) {
    if (isAtWar(transport.nationId, nationId, warAdjacency)) {
      enemy += count;
    }
  }
  if (enemy <= 0) {
    return { canLand: true, debuffMultiplier: 1 };
  }
  return { canLand: true, debuffMultiplier: FORCED_LANDING_DEBUFF_MULTIPLIER };
}

function pickAmphibiousTarget(
  seaId: MesoRegionId,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  mesoById: Map<MesoRegionId, MesoRegion>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  warAdjacency: ReturnType<typeof buildWarAdjacency>,
  nationId: NationId,
): MesoRegionId | null {
  const neighbors = neighborsById.get(seaId) ?? [];
  let fallback: MesoRegionId | null = null;
  for (const neighborId of neighbors) {
    const meso = mesoById.get(neighborId);
    if (!meso || meso.type === "sea") {
      continue;
    }
    if (!fallback) {
      fallback = neighborId;
    }
    const owner = ownerByMesoId.get(neighborId);
    if (owner && owner !== nationId && isAtWar(nationId, owner, warAdjacency)) {
      return neighborId;
    }
  }
  return fallback;
}

function loadCargo(
  transport: UnitState,
  landUnitsByRegion: Map<MesoRegionId, UnitState[]>,
  toRemove: Set<UnitId>,
  embarkedUnits: Map<UnitId, UnitState>,
): void {
  const capacity = Math.max(0, transport.transportCapacity);
  if (capacity <= 0) {
    return;
  }
  const candidates = landUnitsByRegion.get(transport.regionId) ?? [];
  if (candidates.length === 0) {
    return;
  }
  const available = candidates.filter(
    (unit) =>
      unit.nationId === transport.nationId &&
      !toRemove.has(unit.id) &&
      !embarkedUnits.has(unit.id),
  );
  if (available.length === 0) {
    return;
  }

  const remaining = capacity - transport.cargoUnitIds.length;
  if (remaining <= 0) {
    return;
  }

  const selected = available.slice(0, remaining);
  if (selected.length === 0) {
    return;
  }

  for (const unit of selected) {
    resetUnitMovement(unit);
    toRemove.add(unit.id);
    embarkedUnits.set(unit.id, unit);
    transport.cargoUnitIds.push(unit.id);
  }
  if (!transport.cargoOriginId) {
    transport.cargoOriginId = transport.regionId;
  }
}

function unloadCargo(
  transport: UnitState,
  embarkedUnits: Map<UnitId, UnitState>,
  toAdd: UnitState[],
): void {
  if (transport.cargoUnitIds.length === 0) {
    return;
  }
  for (const unitId of transport.cargoUnitIds) {
    const unit = embarkedUnits.get(unitId);
    if (!unit) {
      continue;
    }
    unit.regionId = transport.regionId;
    resetUnitMovement(unit);
    embarkedUnits.delete(unitId);
    toAdd.push(unit);
  }
  transport.cargoUnitIds = [];
  transport.cargoOriginId = null;
}

function unloadCargoToRegion(
  transport: UnitState,
  targetId: MesoRegionId,
  debuffMultiplier: number,
  embarkedUnits: Map<UnitId, UnitState>,
  toAdd: UnitState[],
): void {
  if (transport.cargoUnitIds.length === 0) {
    return;
  }
  for (const unitId of transport.cargoUnitIds) {
    const unit = embarkedUnits.get(unitId);
    if (!unit) {
      continue;
    }
    unit.regionId = targetId;
    const multiplier = clamp(debuffMultiplier, 0, 1);
    unit.landingDebuffTicks = multiplier < 1 ? LANDING_DEBUFF_TICKS : 0;
    unit.landingDebuffMultiplier = multiplier;
    resetUnitMovement(unit);
    embarkedUnits.delete(unitId);
    toAdd.push(unit);
  }
  transport.cargoUnitIds = [];
  transport.cargoOriginId = null;
}

function resetUnitMovement(unit: UnitState): void {
  unit.moveTargetId = null;
  unit.moveFromId = null;
  unit.moveToId = null;
  unit.moveProgressMs = 0;
}

function tickLandingDebuffs(units: Iterable<UnitState>): void {
  for (const unit of units) {
    if (unit.domain !== "land") {
      continue;
    }
    if (unit.landingDebuffTicks <= 0) {
      continue;
    }
    unit.landingDebuffTicks = Math.max(0, unit.landingDebuffTicks - 1);
    if (unit.landingDebuffTicks === 0) {
      unit.landingDebuffMultiplier = 1;
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
