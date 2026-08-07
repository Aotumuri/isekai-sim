import { FAST_TICK_MS, SLOW_TICK_MS, createSimClock, setSpeedIndex } from "../../src/sim/time";
import { stepFastTick, stepSlowTick, updateSimulation } from "../../src/sim/update";
import type { WorldState } from "../../src/sim/world-state";
import { BenchmarkMetrics } from "../benchmark/metrics";
import type { BenchmarkMode } from "../benchmark/types";

export interface SimulationDriverOptions {
  ticks: number;
  mode?: BenchmarkMode;
  speed?: number;
  frameDeltaMs?: number;
  metrics?: BenchmarkMetrics;
}

export interface SimulationDriverResult {
  metrics: BenchmarkMetrics;
  processedFastTicks: number;
  processedSlowTicks: number;
  virtualElapsedMs: number;
  wallClockMs: number;
  frameCount: number;
  effectiveSimulationSpeed: number;
  throughputTicksPerSecond: number;
}

export function runSimulation(
  world: WorldState,
  options: SimulationDriverOptions,
): SimulationDriverResult {
  const ticks = Math.max(0, Math.floor(options.ticks));
  const mode = options.mode ?? "throughput";
  const speed = options.speed ?? 32;
  const frameDeltaMs = options.frameDeltaMs ?? 1_000 / 60;
  const metrics = options.metrics ?? new BenchmarkMetrics();
  const startFastTick = world.time.fastTick;
  const startSlowTick = world.time.slowTick;
  const startElapsedMs = world.time.elapsedMs;
  let frameCount = 0;

  world.instrumentation = metrics;
  const startedAt = performance.now();
  metrics.measure("simulation.total", () => {
    if (mode === "throughput") {
      runThroughputTicks(world, ticks);
      return;
    }
    frameCount = runFrameLoop(world, ticks, speed, frameDeltaMs, metrics);
  });
  const wallClockMs = performance.now() - startedAt;
  const processedFastTicks = world.time.fastTick - startFastTick;
  const processedSlowTicks = world.time.slowTick - startSlowTick;
  const virtualElapsedMs = world.time.elapsedMs - startElapsedMs;
  const simulatedRealMs = mode === "frame-loop" ? frameCount * frameDeltaMs : wallClockMs;

  return {
    metrics,
    processedFastTicks,
    processedSlowTicks,
    virtualElapsedMs,
    wallClockMs,
    frameCount,
    effectiveSimulationSpeed:
      simulatedRealMs > 0 ? virtualElapsedMs / simulatedRealMs : 0,
    throughputTicksPerSecond:
      wallClockMs > 0 ? (processedFastTicks / wallClockMs) * 1_000 : 0,
  };
}

function runThroughputTicks(world: WorldState, ticks: number): void {
  for (let i = 0; i < ticks; i += 1) {
    stepFastTick(world, FAST_TICK_MS);
    const dueSlowTicks = Math.floor(world.time.elapsedMs / SLOW_TICK_MS);
    while (world.time.slowTick < dueSlowTicks) {
      stepSlowTick(world, SLOW_TICK_MS);
    }
  }
}

function runFrameLoop(
  world: WorldState,
  ticks: number,
  speed: number,
  frameDeltaMs: number,
  metrics: BenchmarkMetrics,
): number {
  const clock = createSimClock();
  const speedIndex = [0.1, 0.5, 1, 2, 4, 8, 16, 32].indexOf(speed);
  if (speedIndex < 0 || !setSpeedIndex(clock, speedIndex)) {
    if (speedIndex < 0) {
      throw new Error(`Unsupported frame-loop speed: ${speed}`);
    }
  }
  const targetFastTick = world.time.fastTick + ticks;
  let frames = 0;
  const maxFrames = Math.max(1_000, ticks * 100);
  while (world.time.fastTick < targetFastTick) {
    metrics.measure("simulation.frame", () => {
      updateSimulation(world, clock, frameDeltaMs);
    });
    frames += 1;
    if (frames > maxFrames) {
      throw new Error(`frame-loop did not reach ${ticks} ticks after ${frames} frames`);
    }
  }
  return frames;
}
