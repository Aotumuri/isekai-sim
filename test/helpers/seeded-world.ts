import { createWorldConfig, type WorldConfig } from "../../src/data/world-config";
import { createWorld } from "../../src/sim/create-world";
import type { WorldState } from "../../src/sim/world-state";

export const STANDARD_BENCHMARK_SEED = 822_748_319_788;

export interface SeededWorldOptions {
  seed?: number;
  width?: number;
  height?: number;
  quick?: boolean;
  config?: Partial<WorldConfig>;
}

export function createSeededWorld(options: SeededWorldOptions = {}): WorldState {
  const width = options.width ?? 1_920;
  const height = options.height ?? 1_080;
  const base = createWorldConfig(width, height);
  const quickOverrides: Partial<WorldConfig> = options.quick
    ? {
        microRegionCount: 6_000,
        mesoLandCenterRatio: 0.04,
        mesoSeaCenterRatio: 0.004,
        mesoRiverCenterRatio: 0.06,
        nationTargetMacroRegionsPerNation: 3,
        nationMacroRegionSizeRange: { min: 4, max: 8 },
      }
    : {};
  const config: WorldConfig = {
    ...base,
    ...quickOverrides,
    ...options.config,
    seed: options.seed ?? STANDARD_BENCHMARK_SEED,
    width,
    height,
  };
  return createWorld(config);
}
