import type { MesoRegionId } from "../worldgen/meso-region";
import { identityHash } from "./nation-identity";
import type { WorldState } from "./world-state";

export const POPULATION_DIMENSIONS = ["ancestry", "culture", "faith"] as const;
export type PopulationDimension = typeof POPULATION_DIMENSIONS[number];

const colors = [0xefaa52, 0x68d5bf, 0xae9bf4, 0xe98099, 0x9cce67, 0x70b7ef];
export const POPULATION_GROUPS = {
  ancestry: ["Auvren", "Veyari", "Kethren", "Orruvi", "Nhalai", "Istren"],
  culture: ["Reed Courts", "Tide Guilds", "Spiral Gardens", "Lantern Roads", "Stone Circles", "Wind Archives"],
  faith: ["Ember Covenant", "Nine Wells", "Silent Orbit", "Dawn Loom", "Mirror Vigil", "Hollow Star"],
};
export const populationColor = (index: number): number => colors[index]!;

export interface RegionalPopulation {
  // All three distributions are measured in the same abstract population units.
  size: number;
  ancestry: number[];
  culture: number[];
  faith: number[];
}

export function groupAffinity(a: number, b: number): number {
  const distance = Math.abs(a - b);
  return 1 - Math.min(distance, colors.length - distance) / (colors.length / 2);
}

export function dominantGroup(distribution: readonly number[]): number {
  return distribution.reduce((best, value, index) => value > distribution[best]! ? index : best, 0);
}

export function getRegionalPopulations(world: WorldState): Map<MesoRegionId, RegionalPopulation> {
  if (world.regionalPopulations) return world.regionalPopulations;
  const land = world.mesoRegions.filter((region) => region.type !== "sea");
  const populations = new Map<MesoRegionId, RegionalPopulation>();
  const anchors = POPULATION_DIMENSIONS.map((dimension) => colors.map((_, index) =>
    land[identityHash(`${world.worldSeed ?? 0}:${dimension}:${index}`) % land.length]));
  for (const region of land) {
    const size = region.building === "capital" ? 8 : region.building === "city" ? 5 : region.building === "port" ? 3 : 1;
    const spread = Math.max(1, Math.min(world.width, world.height) * 0.12);
    const distributions = anchors.map((points) => {
      const weights = points.map((point) => 1 / (1 + (Math.hypot(
        region.center.x - point!.center.x, region.center.y - point!.center.y) / spread) ** 3));
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      return weights.map((weight) => size * weight / total);
    });
    populations.set(region.id, { size, ancestry: distributions[0]!, culture: distributions[1]!, faith: distributions[2]! });
  }
  return world.regionalPopulations = populations;
}
