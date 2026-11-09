import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import { getRegionalPopulations } from "./regional-population";
import { getTerritorialClaim } from "./territorial-claims";
import { getMesoById, getOwnerByMesoId } from "./world-cache";
import type { WorldState } from "./world-state";

export function getTerritorialValue(world: WorldState, nation: NationId, ids: readonly MesoRegionId[]): number {
  const regions = getMesoById(world), population = getRegionalPopulations(world);
  return ids.reduce((total, id) => {
    const region = regions.get(id);
    if (!region || region.type === "sea") return total;
    const infrastructure = region.building === "port" ? 3 : region.building === "capital" ? 8 : region.building === "city" ? 2 : 0;
    return total + (0.5 + (population.get(id)?.size ?? 0) + infrastructure + (region.resource ? 2 : 0)) *
      (1 + getTerritorialClaim(world, nation, id) / 100);
  }, 0);
}

export function getNationalTerritorialValue(world: WorldState, nation: NationId): number {
  const ids = [...getOwnerByMesoId(world)].filter(([, owner]) => owner === nation).map(([id]) => id);
  return Math.max(1, getTerritorialValue(world, nation, ids));
}
