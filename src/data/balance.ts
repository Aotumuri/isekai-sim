export const WORLD_BALANCE = {
  microRegion: {
    density: 1 / 50,
    minCount: 120,
    jitter: 0.85,
  },
  elevation: {
    seedRatio: 0.04,
    seaSeedRatio: 0.32,
    falloff: 0.08,
    spread: 0.18,
    seaLevel: 0,
    range: {
      min: -1,
      max: 1,
    },
    seaRange: {
      min: -1,
      max: -0.2,
    },
    landRange: {
      min: 0.1,
      max: 1,
    },
  },
} as const;
