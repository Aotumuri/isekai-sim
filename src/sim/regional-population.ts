import type { MesoRegionId } from "../worldgen/meso-region";
import { identityHash } from "./nation-identity";
import { connectedRegionGroups } from "./peace-borders";
import type { WorldState } from "./world-state";

export const POPULATION_DIMENSIONS = ["ancestry", "culture", "faith"] as const;
export type PopulationDimension = typeof POPULATION_DIMENSIONS[number];

const colors = [0xefaa52, 0x68d5bf, 0xae9bf4, 0xe98099, 0x9cce67, 0x70b7ef];
export const POPULATION_GROUPS = {
  ancestry: ["オーヴレン", "ヴェヤリ", "ケスレン", "オルーヴィ", "ナライ", "イストレン"],
  culture: ["葦の宮廷", "潮の組合", "螺旋庭園", "灯火街道", "環状列石", "風の文庫"],
  faith: ["残火の盟約", "九つの泉", "静寂の軌道", "曙の織機", "鏡の夜警", "虚ろな星"],
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
  const land = new Set(world.mesoRegions.filter(({ type }) => type !== "sea").map(({ id }) => id));
  const populations = new Map<MesoRegionId, RegionalPopulation>();
  const regions = new Map(world.mesoRegions.map((region) => [region.id, region]));
  const neighbors = new Map(world.mesoRegions.map(({ id, neighbors }) =>
    [id, neighbors.map((neighbor) => neighbor.id)] as const));
  const components = connectedRegionGroups(land, neighbors).sort((a, b) => b.length - a.length);
  const seed = world.worldSeed ?? 0;
  const groupOrders = POPULATION_DIMENSIONS.map((dimension) =>
    POPULATION_GROUPS[dimension].map((_, group) => ({ group, order: identityHash(`${seed}:${dimension}:group:${group}`) }))
      .sort((a, b) => a.order - b.order).map(({ group }) => group));
  let groupOffset = 0;
  for (const component of components) {
    const spread = Math.max(1, Math.sqrt(component.length) * 0.22);
    const origins = POPULATION_DIMENSIONS.map((dimension, index) => {
      const order = groupOrders[index]!;
      const count = Math.min(component.length, Math.max(1, Math.round(order.length * component.length / land.size)));
      const groups = Array.from({ length: count }, (_, i) => order[(groupOffset + i) % order.length]!);
      return findGroupOrigins(component, groups, identityHash(`${seed}:${dimension}:${component[0]}`), land, neighbors);
    });
    groupOffset += origins[0]!.length;
    for (const id of component) {
      const { building } = regions.get(id)!;
      const size = building === "capital" ? 8 : building === "city" ? 5 : building === "port" ? 3 : 1;
      const distributions = origins.map((sources, index) => {
        const weights = groupOrders[index]!.map(() => 0);
        for (const { group, distances } of sources) {
          weights[group] = 1 / (1 + (distances.get(id)! / spread) ** 3);
        }
        const total = weights.reduce((sum, weight) => sum + weight, 0);
        return weights.map((weight) => size * weight / total);
      });
      populations.set(id, { size, ancestry: distributions[0]!, culture: distributions[1]!, faith: distributions[2]! });
    }
  }
  return world.regionalPopulations = populations;
}

function findGroupOrigins(
  component: MesoRegionId[],
  groups: number[],
  seed: number,
  land: Set<MesoRegionId>,
  neighbors: Map<MesoRegionId, MesoRegionId[]>,
): { group: number; distances: Map<MesoRegionId, number> }[] {
  if (groups.length === 1) return [{ group: groups[0]!, distances: new Map(component.map((id) => [id, 0])) }];
  let origin = component[seed % component.length]!;
  const nearest = new Map<MesoRegionId, number>();
  return groups.map((group) => {
    const distances = new Map([[origin, 0]]);
    const queue = [origin];
    for (const id of queue) {
      const distance = distances.get(id)! + 1;
      for (const next of neighbors.get(id) ?? []) {
        if (!land.has(next) || distances.has(next)) continue;
        distances.set(next, distance);
        queue.push(next);
      }
    }
    // Give each group a distinct homeland before blending populations along land routes.
    let farthestDistance = -1;
    for (const [id, distance] of distances) {
      const closest = Math.min(nearest.get(id) ?? Infinity, distance);
      nearest.set(id, closest);
      if (closest > farthestDistance) {
        farthestDistance = closest;
        origin = id;
      }
    }
    return { group, distances };
  });
}
