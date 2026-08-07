import type { WorldState } from "../../src/sim/world-state";
import type { BenchmarkScenarioName } from "../benchmark/types";
import { createSeededWorld } from "../helpers/seeded-world";
import { setupActiveWar } from "./active-war";
import { setupBaseWorld } from "./base-world";
import { setupCivilWar } from "./civil-war";
import { setupLateGame } from "./late-game";
import { setupManyUnits } from "./many-units";
import type { ScenarioOptions, ScenarioSetup } from "./types";

const scenarioSetups: Record<BenchmarkScenarioName, ScenarioSetup> = {
  "base-world": setupBaseWorld,
  "active-war": setupActiveWar,
  "many-units": setupManyUnits,
  "civil-war": setupCivilWar,
  "late-game": setupLateGame,
};

export function createScenarioWorld(
  name: BenchmarkScenarioName,
  options: ScenarioOptions,
): WorldState {
  const world = createSeededWorld(options);
  scenarioSetups[name](world, options);
  return world;
}
