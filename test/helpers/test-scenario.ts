import type { BenchmarkScenarioName } from "../benchmark/types";
import { STANDARD_BENCHMARK_SEED } from "./seeded-world";
import { createScenarioWorld } from "../scenarios";

export function createTestScenario(name: BenchmarkScenarioName) {
  return createScenarioWorld(name, {
    seed: STANDARD_BENCHMARK_SEED,
    width: 640,
    height: 360,
    quick: true,
  });
}
