export const WORLD_BALANCE = {
  microRegion: {
    density: 1 / 25,
    minCount: 120,
    jitter: 0.85,
  },
  elevation: {
    seedRatio: 0.004,
    falloff: 0.03,
    spread: 0.10,
    seaLevel: 0.05,
    range: {
      min: -1,
      max: 1,
    },
    landRange: {
      min: 0.00001,
      max: 1,
    },
  },
} as const;
