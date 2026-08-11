import { createScenarioWorld } from "../scenarios";
import { runSimulation } from "../helpers/simulation-driver";
import { summarizeWorld } from "../helpers/world-summary";
import type { BenchmarkOptions, BenchmarkResult } from "./types";

export function runBenchmark(options: BenchmarkOptions): BenchmarkResult {
  const originalInfo = console.info;
  console.info = () => undefined;
  try {
    const world = createScenarioWorld(options.scenario, options);
    const startWorld = summarizeWorld(world);
    const cpuStart = process.cpuUsage();
    const run = runSimulation(world, options);
    const cpu = process.cpuUsage(cpuStart);
    const memory = process.memoryUsage();

    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      scenario: options.scenario,
      seed: options.seed,
      mode: options.mode,
      requestedTicks: options.ticks,
      processedFastTicks: run.processedFastTicks,
      processedSlowTicks: run.processedSlowTicks,
      speed: options.speed,
      frameDeltaMs: options.frameDeltaMs,
      reserveEnabled: options.reserveEnabled,
      reorganizationEnabled: options.reorganizationEnabled,
      exploitationEnabled: options.exploitationEnabled,
      pocketReductionEnabled: options.pocketReductionEnabled,
      virtualElapsedMs: run.virtualElapsedMs,
      wallClockMs: run.wallClockMs,
      cpuUserMs: cpu.user / 1_000,
      cpuSystemMs: cpu.system / 1_000,
      heapUsedBytes: memory.heapUsed,
      maxRssBytes: process.resourceUsage().maxRSS * 1_024,
      effectiveSimulationSpeed: run.effectiveSimulationSpeed,
      throughputTicksPerSecond: run.throughputTicksPerSecond,
      startWorld,
      endWorld: summarizeWorld(world),
      metrics: run.metrics.getMetricSummaries(),
      counters: run.metrics.getCounters(),
      productionBlockedByComponentId: Object.fromEntries(
        [...world.productionDiagnostics.blockedByComponentId.entries()].sort(
          ([a], [b]) => a.localeCompare(b),
        ),
      ),
    };
  } finally {
    console.info = originalInfo;
  }
}
