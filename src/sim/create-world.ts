import type { WorldConfig } from "../data/world-config";
import { SeededRng } from "../utils/seeded-rng";
import { applyElevation } from "../worldgen/apply-elevation";
import { applySeaLevel } from "../worldgen/apply-sea-level";
import { generateMicroRegions } from "../worldgen/generate-micro-regions";
import type { WorldState } from "./world-state";

export function createWorld(config: WorldConfig): WorldState {
  const rng = new SeededRng(config.seed);
  const microRegions = generateMicroRegions(config, rng);
  applyElevation(microRegions, config, rng);
  applySeaLevel(microRegions, config);

  return {
    width: config.width,
    height: config.height,
    microRegions,
  };
}
