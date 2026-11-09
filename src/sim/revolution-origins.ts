import type { MacroRegionId } from "../worldgen/macro-region";
import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationRuntime } from "./nation-runtime";
import { POPULATION_DIMENSIONS, POPULATION_GROUPS, type PopulationDimension } from "./regional-population";
import { hasPoliticalTurbulence } from "./simulation-settings";
import { getSubjectOverlord } from "./subject-governments";
import { getMesoById } from "./world-cache";
import type { WorldState } from "./world-state";

export interface RevolutionOrigin {
  districtId: MesoRegionId;
  provinceId: MacroRegionId;
  dimension: PopulationDimension;
  group: number;
  score: number;
}

export function rankRevolutionOrigins(world: WorldState, nation: NationRuntime): RevolutionOrigin[] {
  const populations = world.regionalPopulations;
  const overlord = hasPoliticalTurbulence(world) && nation.governance?.policy === "assimilation" ? getSubjectOverlord(world, nation.id) : undefined;
  const reference = overlord ? world.nations.find(({ id }) => id === overlord)?.capitalMesoId : undefined;
  const capital = populations?.get(reference ?? nation.capitalMesoId);
  if (!populations || !capital?.size) return [];

  const regions = getMesoById(world);
  const policy = nation.populationPolicy;
  const favoredDimension = policy?.type === "homeland" ? "ancestry" : policy?.type === "religious" ? "faith" : undefined;
  const order = nation.displacementOrder;
  const origins: RevolutionOrigin[] = [];
  for (const province of world.macroRegions) {
    if (province.nationId !== nation.id || province.mesoRegionIds.includes(nation.capitalMesoId)) continue;
    if (province.mesoRegionIds.some((id) => {
      const occupier = world.occupation.mesoById.get(id);
      return occupier && occupier !== nation.id;
    })) continue;

    const districts = province.mesoRegionIds.flatMap((id) => {
      const region = regions.get(id), population = populations.get(id);
      return region && region.type !== "sea" && population && population.size > 0 ? [{ region, population }] : [];
    });
    const size = districts.reduce((sum, { population }) => sum + population.size, 0);
    if (!size) continue;

    for (const dimension of POPULATION_DIMENSIONS) {
      for (const [group] of POPULATION_GROUPS[dimension].entries()) {
        if (dimension === favoredDimension && group === policy?.group) continue;
        const targeted = order?.dimension === dimension && order.group === group && order.until > world.time.slowTick;
        const capitalShare = (capital[dimension][group] ?? 0) / capital.size;
        const share = districts.reduce((sum, { population }) => sum + (population[dimension][group] ?? 0), 0) / size;
        const minimumShare = targeted ? 0.25 : 0.5;
        if (share < minimumShare || (!targeted && share - capitalShare < 0.25)) continue;
        for (const { region, population } of districts) {
          if (region.building !== "city" && (region.type !== "land" || region.building !== null)) continue;
          const localShare = (population[dimension][group] ?? 0) / population.size;
          if (localShare < minimumShare) continue;
          origins.push({ districtId: region.id, provinceId: province.id, dimension, group,
            score: share + localShare - capitalShare + (targeted ? 2 : 0) + (region.building === "city" ? 0.05 : 0) });
        }
      }
    }
  }
  return origins.sort((a, b) => b.score - a.score || a.districtId.localeCompare(b.districtId));
}
