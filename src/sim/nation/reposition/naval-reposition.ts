import type { WorldState } from "../../world-state";
import type { UnitState } from "../../unit";
import type { MesoRegion, MesoRegionId } from "../../../worldgen/meso-region";
import type { NationId } from "../../../worldgen/nation";
import type { SeededRng } from "../../../utils/seeded-rng";
import { getMesoById, getNeighborsById, getOwnerByMesoId } from "../../world-cache";
import { moveUnitTowardTarget } from "./movement-engine";

export function repositionNavalUnits(world: WorldState, dtMs: number): void {
  if (world.units.length === 0 || world.mesoRegions.length === 0) {
    return;
  }
  const navalUnits = world.units.filter((unit) => unit.domain === "naval");
  if (navalUnits.length === 0) {
    return;
  }

  const mesoById = getMesoById(world);
  const neighborsById = getNeighborsById(world);
  const ownerByMesoId = getOwnerByMesoId(world);

  for (const unit of navalUnits) {
    const current = mesoById.get(unit.regionId);
    if (!current || !isNavalNode(current, unit.nationId, ownerByMesoId)) {
      resetMovement(unit);
      continue;
    }

    if (!unit.moveTargetId || unit.regionId === unit.moveTargetId) {
      const target = pickNavalTarget(
        unit.regionId,
        unit.nationId,
        neighborsById,
        mesoById,
        ownerByMesoId,
        world.simRng,
      );
      unit.moveTargetId = target;
    }

    if (!unit.moveTargetId) {
      resetMovement(unit);
      continue;
    }

    moveUnitTowardTarget(
      unit,
      dtMs,
      neighborsById,
      (id) => {
        const meso = mesoById.get(id);
        return !!meso && isNavalNode(meso, unit.nationId, ownerByMesoId);
      },
      () => false,
    );
  }
}

function isNavalNode(
  meso: MesoRegion,
  nationId: NationId,
  ownerByMesoId: Map<MesoRegionId, NationId>,
): boolean {
  if (meso.type === "sea") {
    return true;
  }
  if (meso.building === "port") {
    return ownerByMesoId.get(meso.id) === nationId;
  }
  return false;
}

function pickNavalTarget(
  startId: MesoRegionId,
  nationId: NationId,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  mesoById: Map<MesoRegionId, MesoRegion>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  rng: SeededRng,
): MesoRegionId | null {
  const neighbors = neighborsById.get(startId) ?? [];
  const candidates: MesoRegionId[] = [];
  for (const neighborId of neighbors) {
    const neighbor = mesoById.get(neighborId);
    if (!neighbor) {
      continue;
    }
    if (!isNavalNode(neighbor, nationId, ownerByMesoId)) {
      continue;
    }
    candidates.push(neighborId);
  }
  if (candidates.length === 0) {
    return null;
  }
  return candidates.length === 1 ? candidates[0] : candidates[rng.nextInt(candidates.length)];
}

function resetMovement(unit: UnitState): void {
  unit.moveTargetId = null;
  unit.moveFromId = null;
  unit.moveToId = null;
  unit.moveProgressMs = 0;
}
