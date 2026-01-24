import type { WorldConfig } from "../data/world-config";
import { SeededRng } from "../utils/seeded-rng";
import { applyElevation } from "../worldgen/apply/elevation";
import { applyRivers } from "../worldgen/apply/rivers";
import { applySeaLevel } from "../worldgen/apply/sea-level";
import { createMicroRegionEdges } from "../worldgen/create-micro-region-edges";
import { generateMicroRegions } from "../worldgen/generate/micro-regions";
import { generateMesoRegions } from "../worldgen/generate/meso-regions";
import { generateNations } from "../worldgen/generate/nations";
import type { BattleState } from "./battles";
import { createInitialUnits } from "./create-units";
import type { NationRuntime } from "./nation-runtime";
import { createOccupationState } from "./occupation";
import { addTestWar } from "./test-war";
import { createSimTime } from "./time";
import type { WarState } from "./war-state";
import type { WorldState } from "./world-state";

export function createWorld(config: WorldConfig): WorldState {
  const rng = new SeededRng(config.seed);
  const microRegions = generateMicroRegions(config, rng);
  const microRegionEdges = createMicroRegionEdges(microRegions);
  applyElevation(microRegions, config, rng);
  applySeaLevel(microRegions, config);
  applyRivers(microRegions, microRegionEdges, rng, config.riverSourceCount);
  const mesoRegions = generateMesoRegions(microRegions, config, rng);
  const { macroRegions, nations } = generateNations(mesoRegions, config, rng);
  const runtimeNations: NationRuntime[] = nations.map((nation) => ({
    ...nation,
    unitRoles: {
      defenseUnitIds: [],
      occupationUnitIds: [],
    },
  }));
  const units = createInitialUnits(runtimeNations);
  const time = createSimTime();
  const wars: WarState[] = [];
  addTestWar(wars, mesoRegions, macroRegions, rng, time.fastTick);
  addTestWar(wars, mesoRegions, macroRegions, rng, time.fastTick);
  addTestWar(wars, mesoRegions, macroRegions, rng, time.fastTick);
  addTestWar(wars, mesoRegions, macroRegions, rng, time.fastTick);
  addTestWar(wars, mesoRegions, macroRegions, rng, time.fastTick);
  addTestWar(wars, mesoRegions, macroRegions, rng, time.fastTick);
  const battles: BattleState[] = [];
  const occupation = createOccupationState();
  const territoryVersion = 0;

  return {
    width: config.width,
    height: config.height,
    microRegions,
    microRegionEdges,
    mesoRegions,
    macroRegions,
    nations: runtimeNations,
    wars,
    battles,
    occupation,
    territoryVersion,
    units,
    time,
  };
}
