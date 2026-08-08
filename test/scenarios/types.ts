import type { WorldState } from "../../src/sim/world-state";

export interface ScenarioOptions {
  seed: number;
  width: number;
  height: number;
  quick: boolean;
  reserveEnabled?: boolean;
}

export type ScenarioSetup = (world: WorldState, options: ScenarioOptions) => void;
