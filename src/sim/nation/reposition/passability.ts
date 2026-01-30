import type { MesoRegion, MesoRegionId } from "../../../worldgen/meso-region";
import type { NationId } from "../../../worldgen/nation";
import type { UnitState } from "../../unit";
import { isAtWar, type WarAdjacency } from "../../war-state";

export function isPassable(meso: MesoRegion): boolean {
  return meso.type !== "sea";
}

export function isOwnedPassable(
  id: MesoRegionId,
  nationId: NationId,
  mesoById: Map<MesoRegionId, MesoRegion>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
): boolean {
  if (ownerByMesoId.get(id) !== nationId) {
    return false;
  }
  const meso = mesoById.get(id);
  return !!meso && isPassable(meso);
}

export function isPassableForNation(
  id: MesoRegionId,
  nationId: NationId,
  mesoById: Map<MesoRegionId, MesoRegion>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  warAdjacency: WarAdjacency,
): boolean {
  const owner = ownerByMesoId.get(id);
  if (!owner) {
    return false;
  }
  const meso = mesoById.get(id);
  if (!meso || !isPassable(meso)) {
    return false;
  }
  if (owner === nationId) {
    return true;
  }
  return isAtWar(nationId, owner, warAdjacency);
}

export function isEnemyTarget(
  id: MesoRegionId,
  nationId: NationId,
  mesoById: Map<MesoRegionId, MesoRegion>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  warAdjacency: WarAdjacency,
): boolean {
  const owner = ownerByMesoId.get(id);
  if (!owner || owner === nationId) {
    return false;
  }
  const meso = mesoById.get(id);
  if (!meso || !isPassable(meso)) {
    return false;
  }
  return isAtWar(nationId, owner, warAdjacency);
}

export function isLiberationTarget(
  id: MesoRegionId,
  nationId: NationId,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  occupationByMesoId: Map<MesoRegionId, NationId>,
  mesoById: Map<MesoRegionId, MesoRegion>,
): boolean {
  const owner = ownerByMesoId.get(id);
  if (!owner || owner !== nationId) {
    return false;
  }
  const occupier = occupationByMesoId.get(id);
  if (!occupier || occupier === nationId) {
    return false;
  }
  const meso = mesoById.get(id);
  return !!meso && isPassable(meso);
}

export function shouldUseWarPath(
  unit: UnitState,
  nationId: NationId,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  occupationByMesoId: Map<MesoRegionId, NationId>,
  mesoById: Map<MesoRegionId, MesoRegion>,
  warAdjacency: WarAdjacency,
): boolean {
  const targetId = unit.moveTargetId;
  if (targetId) {
    if (isEnemyTarget(targetId, nationId, mesoById, ownerByMesoId, warAdjacency)) {
      return true;
    }
    if (
      isLiberationTarget(targetId, nationId, ownerByMesoId, occupationByMesoId, mesoById)
    ) {
      return true;
    }
  }

  const owner = ownerByMesoId.get(unit.regionId);
  if (owner && owner !== nationId) {
    return isAtWar(nationId, owner, warAdjacency);
  }

  const occupier = occupationByMesoId.get(unit.regionId);
  if (occupier && occupier !== nationId) {
    return true;
  }

  return false;
}
