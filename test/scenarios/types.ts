import type { WorldConfig } from "../../src/data/world-config";
import type { WorldState } from "../../src/sim/world-state";

export interface ScenarioOptions {
  seed: number;
  width: number;
  height: number;
  quick: boolean;
  config?: Partial<WorldConfig>;
  reserveEnabled?: boolean;
  reorganizationEnabled?: boolean;
  exploitationEnabled?: boolean;
  pocketReductionEnabled?: boolean;
}

export type ScenarioSetup = (world: WorldState, options: ScenarioOptions) => void;
