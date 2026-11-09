import { dominantGroup, getRegionalPopulations, populationColor, POPULATION_DIMENSIONS, POPULATION_GROUPS, type PopulationDimension } from "../sim/regional-population";
import type { WorldState } from "../sim/world-state";
import type { MesoRegionId } from "../worldgen/meso-region";

export const POPULATION_LABELS = { ancestry: "Ancestry", culture: "Culture", faith: "Religion" };

export function isPopulationMode(mode: string): mode is PopulationDimension {
  return POPULATION_DIMENSIONS.some((dimension) => mode === dimension);
}

export function getPopulationMapStyle(world: WorldState, id: MesoRegionId, mode: PopulationDimension) {
  const population = getRegionalPopulations(world).get(id);
  if (!population) return null;
  const group = dominantGroup(population[mode]);
  return { color: populationColor(group), alpha: 0.45 + 0.55 * population[mode][group]! / population.size };
}

export function formatPopulationDistrict(world: WorldState, id: MesoRegionId, mode: PopulationDimension): string[] {
  const population = getRegionalPopulations(world).get(id);
  if (!population) return [];
  const groups = population[mode].map((count, index) => ({
    name: POPULATION_GROUPS[mode][index]!, share: Math.round(100 * count / population.size),
  })).sort((a, b) => b.share - a.share);
  return [POPULATION_LABELS[mode], ...groups.map(({ name, share }) => `${name} · ${share}%`)];
}
