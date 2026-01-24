import { WORLD_BALANCE } from "./balance";

export interface Range {
  min: number;
  max: number;
}

export interface WorldConfig {
  width: number;
  height: number;
  microRegionCount: number;
  seed: number;
  jitter: number;
  elevationSeedRatio: number;
  elevationRidgeCount: number;
  elevationRidgeLengthRatio: number;
  elevationRidgeInertia: number;
  elevationCenterBiasStrength: number;
  elevationEdgeAvoidStrength: number;
  elevationSmoothingStrength: number;
  elevationFalloff: number;
  elevationSpread: number;
  elevationSeaLevel: number;
  elevationRange: Range;
  elevationLandRange: Range;
  elevationRidgePeakRange: Range;
  riverSourceCount: number;
  mesoLandCenterRatio: number;
  mesoSeaCenterRatio: number;
  mesoRiverCenterRatio: number;
  mesoMinCenterCount: number;
  nationEnabled: boolean;
  nationTargetMacroRegionsPerNation: number;
  nationMacroRegionSizeRange: Range;
  nationCityPerMacroRegion: number;
  nationMinCitiesPerNation: number;
}

// const DEFAULT_SEED = 621903618650; // 二つの島
// const DEFAULT_SEED = 114693131459; // ドーナツ
const DEFAULT_SEED = 695919685365; // 二つの大きな島

// ランダムよう
// const DEFAULT_SEED = Math.floor(Math.random() * 1_000_000_000_000);
// console.log("World generation seed:", DEFAULT_SEED);

export function createWorldConfig(width: number, height: number): WorldConfig {
  const { microRegion, elevation, river, mesoRegion, nation } = WORLD_BALANCE;
  const area = Math.max(1, width * height);
  const microRegionCount = Math.max(microRegion.minCount, Math.floor(area * microRegion.density));
  const riverSourceCount = Math.max(
    river.minSourceCount,
    Math.floor(microRegionCount * river.sourceCountRatio),
  );

  return {
    width,
    height,
    microRegionCount,
    seed: DEFAULT_SEED,
    jitter: microRegion.jitter,
    elevationSeedRatio: elevation.seedRatio,
    elevationRidgeCount: elevation.ridgeCount,
    elevationRidgeLengthRatio: elevation.ridgeLengthRatio,
    elevationRidgeInertia: elevation.ridgeInertia,
    elevationCenterBiasStrength: elevation.centerBiasStrength,
    elevationEdgeAvoidStrength: elevation.edgeAvoidStrength,
    elevationSmoothingStrength: elevation.smoothingStrength,
    elevationFalloff: elevation.falloff,
    elevationSpread: elevation.spread,
    elevationSeaLevel: elevation.seaLevel,
    elevationRange: { ...elevation.range },
    elevationLandRange: { ...elevation.landRange },
    elevationRidgePeakRange: { ...elevation.ridgePeakRange },
    riverSourceCount,
    mesoLandCenterRatio: mesoRegion.landCenterRatio,
    mesoSeaCenterRatio: mesoRegion.seaCenterRatio,
    mesoRiverCenterRatio: mesoRegion.riverCenterRatio,
    mesoMinCenterCount: mesoRegion.minCenterCount,
    nationEnabled: nation.enabled,
    nationTargetMacroRegionsPerNation: nation.targetMacroRegionsPerNation,
    nationMacroRegionSizeRange: { ...nation.macroRegionSizeRange },
    nationCityPerMacroRegion: nation.cityPerMacroRegion,
    nationMinCitiesPerNation: nation.minCitiesPerNation,
  };
}
