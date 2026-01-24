import type { MacroRegion } from "../worldgen/macro-region";
import type { MesoRegion, MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import type { WorldState } from "./world-state";

export function updateCapitals(world: WorldState): void {
  if (world.nations.length === 0 || world.mesoRegions.length === 0) {
    return;
  }

  const mesoById = new Map<MesoRegionId, MesoRegion>();
  for (const meso of world.mesoRegions) {
    mesoById.set(meso.id, meso);
  }

  const ownerByMesoId = buildOwnerByMesoId(world.macroRegions);
  const occupationByMesoId = world.occupation.mesoById;

  for (const nation of world.nations) {
    const capitalId = nation.capitalMesoId;
    const capital = mesoById.get(capitalId);
    if (!capital) {
      continue;
    }

    const occupier = occupationByMesoId.get(capitalId);
    if (!occupier || occupier === nation.id) {
      continue;
    }

    const nextCapitalId = pickTemporaryCapital(
      nation.id,
      capitalId,
      mesoById,
      ownerByMesoId,
      occupationByMesoId,
    );
    if (!nextCapitalId) {
      continue;
    }

    if (capital.building === "capital") {
      capital.building = "city";
    }
    const nextCapital = mesoById.get(nextCapitalId);
    if (nextCapital) {
      nextCapital.building = "capital";
    }
    nation.capitalMesoId = nextCapitalId;
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
