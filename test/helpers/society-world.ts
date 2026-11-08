import { createSimulationSettings } from "../../src/sim/simulation-settings";
import { createSeededWorld } from "./seeded-world";

export function createSocietyWorld() {
  const world = createSeededWorld({ seed: 101, width: 640, height: 360, config: {
    microRegionCount: 1_200, nationTargetMacroRegionsPerNation: 2,
    nationMacroRegionSizeRange: { min: 2, max: 5 },
  } });
  world.settings = createSimulationSettings();
  return world;
}
