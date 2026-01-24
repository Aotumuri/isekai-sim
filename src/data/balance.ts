export const WORLD_BALANCE = {
  microRegion: {
    density: 1 / 10,
    minCount: 120,
    jitter: 0.85,
  },
  elevation: {
    seedRatio: 0.004,
    ridgeCount: 2,
    ridgeLengthRatio: 0.05,
    ridgeInertia: 0.75,
    centerBiasStrength: 0.3,
    edgeAvoidStrength: 1,
    smoothingStrength: 0.5,
    falloff: 0.01,
    spread: 0.15,
    seaLevel: 0.05,
    range: {
      min: -1,
      max: 1,
    },
    landRange: {
      min: 0.00001,
      max: 1,
    },
    ridgePeakRange: {
      min: 0.7,
      max: 1,
    },
  },
  river: {
    sourceCountRatio: 0.0001,
    minSourceCount: 3,
  },
  mesoRegion: {
    landCenterRatio: 0.02,
    seaCenterRatio: 0.001,
    riverCenterRatio: 0.04,
    minCenterCount: 1,
  },
  nation: {
    enabled: true,
    targetMacroRegionsPerNation: 10,
    macroRegionSizeRange: {
      min: 10,
      max: 20,
    },
  },
  war: {
    macroOccupationRatio: 0.6,
  },
} as const;
