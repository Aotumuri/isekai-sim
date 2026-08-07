import type { ScenarioSetup } from "./types";
import { ensureLandUnitCount, startAdjacentWars } from "./scenario-utils";

export const setupManyUnits: ScenarioSetup = (world, options) => {
  startAdjacentWars(world, 5);
  ensureLandUnitCount(world, options.quick ? 240 : 600);
};
