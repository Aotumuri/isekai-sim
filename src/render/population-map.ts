import { dominantGroup, getRegionalPopulations, populationColor, POPULATION_DIMENSIONS, POPULATION_GROUPS, type PopulationDimension } from "../sim/regional-population";
import type { WorldState } from "../sim/world-state";
import type { MesoRegionId } from "../worldgen/meso-region";

export const MIXED_POPULATION_THRESHOLD = 0.2;

export const POPULATION_LABELS = { ancestry: "系統", culture: "文化", faith: "宗教" };

export function isPopulationMode(mode: string): mode is PopulationDimension {
  return POPULATION_DIMENSIONS.some((dimension) => mode === dimension);
}

export function getPopulationMapStyle(world: WorldState, id: MesoRegionId, mode: PopulationDimension) {
  const population = getRegionalPopulations(world).get(id);
  if (!population) return null;
  const group = dominantGroup(population[mode]);
  const runnerUp = population[mode].reduce((best, count, index) =>
    index !== group && (best === -1 || count > population[mode][best]!) ? index : best, -1);
  const mixed = runnerUp >= 0 && population[mode][runnerUp]! >= population.size * MIXED_POPULATION_THRESHOLD;
  return { color: populationColor(group), alpha: 0.65 + 0.35 * population[mode][group]! / population.size,
    secondaryColor: mixed ? populationColor(runnerUp) : undefined };
}

export function formatPopulationDistrict(world: WorldState, id: MesoRegionId, mode: PopulationDimension): string[] {
  const population = getRegionalPopulations(world).get(id);
  if (!population) return [];
  const groups = population[mode].map((count, index) => ({
    name: POPULATION_GROUPS[mode][index]!, share: Math.round(100 * count / population.size),
  })).sort((a, b) => b.share - a.share);
  return [POPULATION_LABELS[mode], ...groups.map(({ name, share }) => `${name} · ${share}%`)];
}
