import type { ScenarioSetup } from "./types";
import { startAdjacentWars } from "./scenario-utils";

export const setupActiveWar: ScenarioSetup = (world) => {
  const added = startAdjacentWars(world, 5);
  if (added < 2) {
    throw new Error(`active-war requires multiple adjacent wars; created ${added}`);
  }
};
