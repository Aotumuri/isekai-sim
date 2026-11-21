import type { MacroRegionId } from "../worldgen/macro-region";
import type { MesoRegionId } from "../worldgen/meso-region";
import { getRegionalIdentityGrievance, grievanceLevel } from "./identity-grievances";
import type { NationRuntime } from "./nation-runtime";
import { hasPoliticalTurbulence } from "./simulation-settings";
import { getMesoById } from "./world-cache";
import type { WorldState } from "./world-state";

export interface RevolutionOrigin {
  districtId: MesoRegionId;
  provinceId: MacroRegionId;
  dimension: import("./regional-population").PopulationDimension;
  group: number;
  score: number;
}

export function rankRevolutionOrigins(world: WorldState, nation: NationRuntime): RevolutionOrigin[] {
  const populations = world.regionalPopulations;
  if (!populations || !hasPoliticalTurbulence(world)) return [];

  const regions = getMesoById(world);
  const origins: RevolutionOrigin[] = [];
  for (const province of world.macroRegions) {
    if (province.nationId !== nation.id || province.mesoRegionIds.includes(nation.capitalMesoId)) continue;
    if (province.mesoRegionIds.some((id) => {
      const occupier = world.occupation.mesoById.get(id);
      return occupier && occupier !== nation.id;
    })) continue;

    let size = 0, burden = 0;
    for (const id of province.mesoRegionIds) {
      const population = populations.get(id);
      if (!population?.size) continue;
      size += population.size;
      burden += population.size * grievanceLevel(getRegionalIdentityGrievance(world, id, nation.id));
    }
    if (!size || burden / size < 0.12) continue;
    for (const id of province.mesoRegionIds) {
      const region = regions.get(id), state = getRegionalIdentityGrievance(world, id, nation.id);
      const population = populations.get(id);
      if (!region || (region.building !== "city" && !(region.type === "land" && region.building === null)) ||
          !state || !population?.size || grievanceLevel(state) < 0.16) continue;
      // A historical grievance can survive migration. Avoid attributing a revolt to an absent community.
      const share = population[state.dimension][state.group]! / population.size;
      if (share < 0.12 || state.exclusion + state.entrenched < 0.08) continue;
      origins.push({ districtId: id, provinceId: province.id, dimension: state.dimension, group: state.group,
        score: burden / size + grievanceLevel(state) + share * 0.1 + (region.building === "city" ? 0.05 : 0) });
    }
  }
  return origins.sort((a, b) => b.score - a.score || a.districtId.localeCompare(b.districtId));
}
