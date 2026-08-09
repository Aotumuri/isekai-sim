import type { WorldState } from "../../src/sim/world-state";
import type { BenchmarkScenarioName } from "../benchmark/types";
import { createSeededWorld } from "../helpers/seeded-world";
import { setupActiveWar } from "./active-war";
import { setupBaseWorld } from "./base-world";
import { setupCivilWar } from "./civil-war";
import { setupLateGame } from "./late-game";
import { setupManyUnits } from "./many-units";
import { setupRetreatHeavy } from "./retreat-heavy";
import { setupCapitalThreat } from "./capital-threat";
import { setupStrategicReserve } from "./strategic-reserve";
import { setupReorganizationHeavy } from "./reorganization-heavy";
import { setupLongFrontline } from "./long-frontline";
import { setupGapExploitation } from "./gap-exploitation";
import { setupStalemateBreaker } from "./stalemate-breaker";
import type { ScenarioOptions, ScenarioSetup } from "./types";

const scenarioSetups: Record<BenchmarkScenarioName, ScenarioSetup> = {
  "base-world": setupBaseWorld,
  "active-war": setupActiveWar,
  "many-units": setupManyUnits,
  "civil-war": setupCivilWar,
  "late-game": setupLateGame,
  "retreat-heavy": setupRetreatHeavy,
  "capital-threat": setupCapitalThreat,
  "strategic-reserve": setupStrategicReserve,
  "reorganization-heavy": setupReorganizationHeavy,
  "long-frontline": setupLongFrontline,
  "gap-exploitation": setupGapExploitation,
  "stalemate-breaker": setupStalemateBreaker,
};

export function createScenarioWorld(
  name: BenchmarkScenarioName,
  options: ScenarioOptions,
): WorldState {
  const world = createSeededWorld(options);
  world.strategicReserves.enabled = options.reserveEnabled ?? true;
  world.reorganization.enabled = options.reorganizationEnabled ?? true;
  world.offensiveOperations.exploitationEnabled = options.exploitationEnabled ?? true;
  scenarioSetups[name](world, options);
  return world;
}
