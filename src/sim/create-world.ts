import type { WorldConfig } from "../data/world-config";
import { SeededRng } from "../utils/seeded-rng";
import { applyElevation } from "../worldgen/apply-elevation";
import { applyRivers } from "../worldgen/apply-rivers";
import { applySeaLevel } from "../worldgen/apply-sea-level";
import { createMicroRegionEdges } from "../worldgen/create-micro-region-edges";
import { generateMicroRegions } from "../worldgen/generate-micro-regions";
import { generateMesoRegions } from "../worldgen/generate-meso-regions";
import type { WorldState } from "./world-state";

export function createWorld(config: WorldConfig): WorldState {
  const rng = new SeededRng(config.seed);
  const microRegions = generateMicroRegions(config, rng);
  const microRegionEdges = createMicroRegionEdges(microRegions);
  applyElevation(microRegions, config, rng);
  applySeaLevel(microRegions, config);
  applyRivers(microRegions, microRegionEdges, rng, config.riverSourceCount);
  const mesoRegions = generateMesoRegions(microRegions, config, rng);

  return {
    width: config.width,
    height: config.height,
    microRegions,
    microRegionEdges,
    mesoRegions,
  };
}
