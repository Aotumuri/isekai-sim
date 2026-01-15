export interface WorldConfig {
  width: number;
  height: number;
  microRegionCount: number;
  seed: number;
  jitter: number;
}

const MICRO_REGION_DENSITY = 1 / 50;
const DEFAULT_SEED = 20250115;
const DEFAULT_JITTER = 0.85;

export function createWorldConfig(width: number, height: number): WorldConfig {
  const area = Math.max(1, width * height);
  const microRegionCount = Math.max(120, Math.floor(area * MICRO_REGION_DENSITY));

  return {
    width,
    height,
    microRegionCount,
    seed: DEFAULT_SEED,
    jitter: DEFAULT_JITTER,
  };
}
