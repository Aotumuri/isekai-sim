import { WORLD_BALANCE } from "../data/balance";
import type { MesoRegion, MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import type { UnitId, UnitState } from "./unit";
import type { WorldState } from "./world-state";
import { getMesoById, getNeighborsById, getOwnerByMesoId } from "./world-cache";
import { buildWarAdjacency, isAtWar, type WarAdjacency } from "./war-state";

export function updateAmphibiousOperations(world: WorldState): void {
  if (world.units.length === 0) {
    return;
  }

  const transportCapacity = Math.max(
    0,
    Math.round(WORLD_BALANCE.unit.navalTransportCapacity ?? 10),
  );
  const invasionLossRatio = clamp(
    WORLD_BALANCE.unit.amphibiousInvasionLossRatio ?? 0.6,
    0,
    1,
  );

  const mesoById = getMesoById(world);
  const neighborsById = getNeighborsById(world);
  const ownerByMesoId = getOwnerByMesoId(world);
  const warAdjacency = buildWarAdjacency(world.wars);

  const landUnitsByMeso = new Map<MesoRegionId, Map<NationId, UnitState[]>>();
  for (const unit of world.units) {
    if (!isEmbarkCandidate(unit)) {
      continue;
    }
    let byNation = landUnitsByMeso.get(unit.regionId);
    if (!byNation) {
      byNation = new Map<NationId, UnitState[]>();
      landUnitsByMeso.set(unit.regionId, byNation);
    }
    const list = byNation.get(unit.nationId);
    if (list) {
      list.push(unit);
    } else {
      byNation.set(unit.nationId, [unit]);
    }
  }
  for (const byNation of landUnitsByMeso.values()) {
    for (const list of byNation.values()) {
      list.sort((a, b) => a.id.localeCompare(b.id));
    }
  }

  const removedLandUnitIds = new Set<UnitId>();
  const landedUnits: UnitState[] = [];

  for (const unit of world.units) {
    if (!isTransportShip(unit)) {
      continue;
    }

    const meso = mesoById.get(unit.regionId);
    if (!meso) {
      continue;
    }

    if (transportCapacity > 0 && isEmbarkPort(meso, unit.nationId, ownerByMesoId)) {
      const candidatesByNation = landUnitsByMeso.get(unit.regionId);
      const candidates = candidatesByNation?.get(unit.nationId);
      if (candidates && candidates.length > 0) {
        const available = transportCapacity - unit.cargoUnits.length;
        if (available > 0) {
          const embarked = candidates.splice(0, available);
          for (const landUnit of embarked) {
            removedLandUnitIds.add(landUnit.id);
            resetMovement(landUnit);
            landUnit.regionId = unit.regionId;
            landUnit.amphibiousEmbarkRequested = false;
            unit.cargoUnits.push(landUnit);
          }
        }
      }
    }

    if (
      unit.cargoUnits.length === 0 ||
      meso.type !== "sea" ||
      !unit.amphibiousLandRequested
    ) {
      continue;
    }

    const coastalTargets = collectCoastalTargets(unit.regionId, neighborsById, mesoById);
    if (coastalTargets.length === 0) {
      continue;
    }

    const targetId = pickLandingTarget(
      coastalTargets,
      unit.nationId,
      ownerByMesoId,
      warAdjacency,
    );
    if (!targetId) {
      continue;
    }

    const suffersInvasionLoss = hasEnemyCombatShip(
      unit.regionId,
      unit.nationId,
      world.units,
      warAdjacency,
    );
    const lossRatio = suffersInvasionLoss ? invasionLossRatio : 0;

    for (const landUnit of unit.cargoUnits) {
      if (lossRatio > 0) {
        applyLandingLoss(landUnit, lossRatio);
      }
      if (landUnit.manpower <= 0 || landUnit.org <= 0) {
        continue;
      }
      landUnit.regionId = targetId;
      resetMovement(landUnit);
      landedUnits.push(landUnit);
    }
    unit.cargoUnits = [];
    unit.amphibiousLandRequested = false;
  }

  if (removedLandUnitIds.size > 0) {
    world.units = world.units.filter((unit) => !removedLandUnitIds.has(unit.id));
  }

  if (landedUnits.length > 0) {
    world.units.push(...landedUnits);
  }
}

function isTransportShip(unit: UnitState): boolean {
  return unit.domain === "naval" && unit.type === "TransportShip";
}

function isEmbarkCandidate(unit: UnitState): boolean {
  if (unit.domain !== "land") {
    return false;
  }
  if (!unit.amphibiousEmbarkRequested) {
    return false;
  }
  return !unit.moveTargetId || unit.moveTargetId === unit.regionId;
}

function isEmbarkPort(
  meso: MesoRegion,
  nationId: NationId,
  ownerByMesoId: Map<MesoRegionId, NationId>,
): boolean {
  if (meso.building !== "port") {
    return false;
  }
  return ownerByMesoId.get(meso.id) === nationId;
}

function collectCoastalTargets(
  seaMesoId: MesoRegionId,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  mesoById: Map<MesoRegionId, MesoRegion>,
): MesoRegionId[] {
  const neighbors = neighborsById.get(seaMesoId) ?? [];
  const targets: MesoRegionId[] = [];
  for (const neighborId of neighbors) {
    const neighbor = mesoById.get(neighborId);
    if (!neighbor || neighbor.type === "sea") {
      continue;
    }
    targets.push(neighborId);
  }
  return targets;
}

function pickLandingTarget(
  targets: MesoRegionId[],
  nationId: NationId,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  warAdjacency: WarAdjacency,
): MesoRegionId | null {
  const enemy: MesoRegionId[] = [];
  const neutral: MesoRegionId[] = [];
  const friendly: MesoRegionId[] = [];
  for (const target of targets) {
    const owner = ownerByMesoId.get(target);
    if (!owner) {
      neutral.push(target);
      continue;
    }
    if (owner === nationId) {
      friendly.push(target);
      continue;
    }
    if (isAtWar(nationId, owner, warAdjacency)) {
      enemy.push(target);
      continue;
    }
    neutral.push(target);
  }
  if (enemy.length > 0) {
    return enemy[0];
  }
  if (neutral.length > 0) {
    return neutral[0];
  }
  return friendly.length > 0 ? friendly[0] : null;
}

function hasEnemyCombatShip(
  seaMesoId: MesoRegionId,
  nationId: NationId,
  units: UnitState[],
  warAdjacency: WarAdjacency,
): boolean {
  for (const unit of units) {
    if (unit.domain !== "naval" || unit.type !== "CombatShip") {
      continue;
    }
    if (unit.regionId !== seaMesoId) {
      continue;
    }
    if (isAtWar(nationId, unit.nationId, warAdjacency)) {
      return true;
    }
  }
  return false;
}

function applyLandingLoss(unit: UnitState, lossRatio: number): void {
  const ratio = clamp(lossRatio, 0, 1);
  if (ratio <= 0) {
    return;
  }
  unit.manpower = Math.max(0, unit.manpower * (1 - ratio));
  unit.org = Math.max(0, unit.org * (1 - ratio));
}

function resetMovement(unit: UnitState): void {
  unit.moveTargetId = null;
  unit.moveFromId = null;
  unit.moveToId = null;
  unit.moveProgressMs = 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
