export const BENCHMARK_SCENARIOS = [
  "base-world",
  "active-war",
  "many-units",
  "civil-war",
  "late-game",
] as const;

export type BenchmarkScenarioName = (typeof BENCHMARK_SCENARIOS)[number];
export type BenchmarkMode = "throughput" | "frame-loop";

export interface BenchmarkOptions {
  scenario: BenchmarkScenarioName;
  seed: number;
  ticks: number;
  width: number;
  height: number;
  speed: number;
  mode: BenchmarkMode;
  frameDeltaMs: number;
  quick: boolean;
}

export interface MetricSummary {
  count: number;
  totalMs: number;
  averageMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  retainedSamples: number;
}

export interface WorldSummary {
  nations: number;
  activeNations: number;
  extinctNations: number;
  units: number;
  landUnits: number;
  wars: number;
  battles: number;
  occupations: number;
  landFronts: number;
  microRegions: number;
  mesoRegions: number;
  macroRegions: number;
  territoryVersion: number;
  occupationVersion: number;
  buildingVersion: number;
}

export interface BenchmarkResult {
  schemaVersion: 1;
  generatedAt: string;
  scenario: BenchmarkScenarioName;
  seed: number;
  mode: BenchmarkMode;
  requestedTicks: number;
  processedFastTicks: number;
  processedSlowTicks: number;
  speed: number;
  frameDeltaMs: number;
  virtualElapsedMs: number;
  wallClockMs: number;
  effectiveSimulationSpeed: number;
  throughputTicksPerSecond: number;
  startWorld: WorldSummary;
  endWorld: WorldSummary;
  metrics: Record<string, MetricSummary>;
  counters: Record<string, number>;
}
