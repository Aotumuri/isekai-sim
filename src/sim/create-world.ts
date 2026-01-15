import type { WorldConfig } from "../data/world-config";
import { SeededRng } from "../utils/seeded-rng";
import { generateMicroRegions } from "../worldgen/generate-micro-regions";
import type { WorldState } from "./world-state";

export function createWorld(config: WorldConfig): WorldState {
  const rng = new SeededRng(config.seed);
  const microRegions = generateMicroRegions(config, rng);

  return {
    width: config.width,
    height: config.height,
    microRegions,
  };
}
