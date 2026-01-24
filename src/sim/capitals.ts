import type { MesoRegion, MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import type { WorldState } from "./world-state";
import { getMesoById, getOwnerByMesoId } from "./world-cache";

export function updateCapitals(world: WorldState): void {
  if (world.nations.length === 0 || world.mesoRegions.length === 0) {
    return;
  }

  const mesoById = getMesoById(world);
  const ownerByMesoId = getOwnerByMesoId(world);
  const occupationByMesoId = world.occupation.mesoById;
  let buildingChanged = false;

  for (const nation of world.nations) {
    const capitalId = nation.capitalMesoId;
    const capital = mesoById.get(capitalId);
    if (!capital) {
      continue;
    }

    const owner = ownerByMesoId.get(capitalId);
    const occupier = occupationByMesoId.get(capitalId);
    const isLost = owner !== nation.id || (!!occupier && occupier !== nation.id);
    if (!isLost) {
      continue;
    }

    const nextCapitalId = pickTemporaryCapital(
      nation.id,
      capitalId,
      mesoById,
      ownerByMesoId,
      occupationByMesoId,
    );
    const didFall = capital.building === "capital";
    if (didFall) {
      capital.building = "city";
      buildingChanged = true;
    }
    if (nextCapitalId) {
      const nextCapital = mesoById.get(nextCapitalId);
      if (nextCapital) {
        if (nextCapital.building !== "capital") {
          nextCapital.building = "capital";
          buildingChanged = true;
        }
        nation.capitalMesoId = nextCapitalId;
      }
    }
    if (didFall) {
      nation.capitalFallCount += 1;
    }
  }

  if (buildingChanged) {
    world.buildingVersion += 1;
  }
}

function pickTemporaryCapital(
  nationId: NationId,
  currentCapitalId: MesoRegionId,
  mesoById: Map<MesoRegionId, MesoRegion>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  occupationByMesoId: Map<MesoRegionId, NationId>,
): MesoRegionId | null {
  let candidate: MesoRegionId | null = null;

  for (const [mesoId, meso] of mesoById.entries()) {
    if (mesoId === currentCapitalId) {
      continue;
    }
    if (meso.building !== "city") {
      continue;
    }
    if (ownerByMesoId.get(mesoId) !== nationId) {
      continue;
    }
    const occupier = occupationByMesoId.get(mesoId);
    if (occupier && occupier !== nationId) {
      continue;
    }
    if (!candidate || mesoId < candidate) {
      candidate = mesoId;
    }
  }

  return candidate;
}
