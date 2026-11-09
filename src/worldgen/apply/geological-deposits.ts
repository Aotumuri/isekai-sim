import type { WorldConfig } from "../../data/world-config";
import type { MesoRegion } from "../meso-region";
import type { MicroRegion } from "../micro-region";
import type { SeededRng } from "../../utils/seeded-rng";

export function rankGeologicalDeposits(
  mesoRegions: MesoRegion[],
  microRegions: MicroRegion[],
  candidates: number[],
  steelCount: number,
  fuelCount: number,
  config: WorldConfig,
  rng: SeededRng,
): { steelIndices: number[]; fuelIndices: number[] } {
  const reliefByMeso = new Map<MesoRegion["id"], { sum: number; count: number }>();
  for (const micro of microRegions) {
    if (micro.isSea || !micro.mesoRegionId) continue;
    const relief = reliefByMeso.get(micro.mesoRegionId) ?? { sum: 0, count: 0 };
    relief.sum += micro.elevation - config.elevationSeaLevel;
    relief.count += 1;
    reliefByMeso.set(micro.mesoRegionId, relief);
  }

  const seaIds = new Set(mesoRegions.filter((region) => region.type === "sea").map((region) => region.id));
  const scores = candidates.map((index) => {
    const region = mesoRegions[index];
    const relief = reliefByMeso.get(region.id);
    const height = relief ? relief.sum / relief.count : 0;
    const coastal = region.neighbors.some(({ id }) => seaIds.has(id));
    return {
      index,
      steel: height + rng.range(0, 0.22),
      fuel: 0.10 * Number(coastal) - height + rng.range(0, 0.20),
    };
  });
  scores.sort((a, b) => b.steel - a.steel);
  const steelIndices = scores.slice(0, steelCount).map(({ index }) => index);
  const fuelIndices = scores.slice(steelCount).sort((a, b) => b.fuel - a.fuel)
    .slice(0, fuelCount).map(({ index }) => index);
  return { steelIndices, fuelIndices };
}
