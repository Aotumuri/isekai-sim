import type { UnitState } from "../../unit";
import type {
  MesoRegion,
  MesoRegionBuilding,
  MesoRegionId,
} from "../../../worldgen/meso-region";
import type { NationId } from "../../../worldgen/nation";
import { isAtWar, type WarAdjacency } from "../../war-state";
import { isPassable } from "./passability";

export function collectOwnedTargets(
  nationId: NationId,
  mesoById: Map<MesoRegionId, MesoRegion>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
): MesoRegionId[] {
  const targets: MesoRegionId[] = [];
  for (const [mesoId, owner] of ownerByMesoId.entries()) {
    if (owner !== nationId) {
      continue;
    }
    const meso = mesoById.get(mesoId);
    if (meso && isPassable(meso)) {
      targets.push(mesoId);
    }
  }
  return targets;
}

export function collectBuildingTargets(
  nationId: NationId,
  building: MesoRegionBuilding,
  mesoById: Map<MesoRegionId, MesoRegion>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
): MesoRegionId[] {
  const targets: MesoRegionId[] = [];
  for (const [mesoId, owner] of ownerByMesoId.entries()) {
    if (owner !== nationId) {
      continue;
    }
    const meso = mesoById.get(mesoId);
    if (!meso || !isPassable(meso)) {
      continue;
    }
    if (meso.building === building) {
      targets.push(mesoId);
    }
  }
  return targets;
}

export function collectIntrusionTargetsByNation(
  units: UnitState[],
  ownerByMesoId: Map<MesoRegionId, NationId>,
  mesoById: Map<MesoRegionId, MesoRegion>,
  warAdjacency: WarAdjacency,
): Map<NationId, MesoRegionId[]> {
  const targets = new Map<NationId, Set<MesoRegionId>>();
  for (const unit of units) {
    const owner = ownerByMesoId.get(unit.regionId);
    if (!owner || owner === unit.nationId) {
      continue;
    }
    if (!isAtWar(unit.nationId, owner, warAdjacency)) {
      continue;
    }
    const meso = mesoById.get(unit.regionId);
    if (!meso || !isPassable(meso)) {
      continue;
    }
    const set = targets.get(owner);
    if (set) {
      set.add(unit.regionId);
    } else {
      targets.set(owner, new Set([unit.regionId]));
    }
  }
  const result = new Map<NationId, MesoRegionId[]>();
  for (const [nationId, set] of targets.entries()) {
    result.set(nationId, [...set]);
  }
  return result;
}

export function collectOccupationTargetsByNation(
  mesoRegions: MesoRegion[],
  ownerByMesoId: Map<MesoRegionId, NationId>,
  occupationByMesoId: Map<MesoRegionId, NationId>,
  warAdjacency: WarAdjacency,
): Map<NationId, MesoRegionId[]> {
  const targets = new Map<NationId, Set<MesoRegionId>>();
  for (const meso of mesoRegions) {
    if (!isPassable(meso)) {
      continue;
    }
    const owner = ownerByMesoId.get(meso.id);
    if (!owner) {
      continue;
    }
    if (occupationByMesoId.has(meso.id)) {
      continue;
    }
    const enemies = warAdjacency.get(owner);
    if (!enemies || enemies.size === 0) {
      continue;
    }
    for (const enemyId of enemies) {
      const set = targets.get(enemyId);
      if (set) {
        set.add(meso.id);
      } else {
        targets.set(enemyId, new Set([meso.id]));
      }
    }
  }
  const result = new Map<NationId, MesoRegionId[]>();
  for (const [nationId, set] of targets.entries()) {
    result.set(nationId, [...set]);
  }
  return result;
}

export function collectLiberationTargetsByNation(
  occupationByMesoId: Map<MesoRegionId, NationId>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  mesoById: Map<MesoRegionId, MesoRegion>,
): Map<NationId, MesoRegionId[]> {
  const result = new Map<NationId, MesoRegionId[]>();
  for (const [mesoId, occupier] of occupationByMesoId.entries()) {
    const owner = ownerByMesoId.get(mesoId);
    if (!owner || occupier === owner) {
      continue;
    }
    const meso = mesoById.get(mesoId);
    if (!meso || !isPassable(meso)) {
      continue;
    }
    const list = result.get(owner);
    if (list) {
      list.push(mesoId);
    } else {
      result.set(owner, [mesoId]);
    }
  }
  return result;
}
