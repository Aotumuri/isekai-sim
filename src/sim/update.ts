import type { WorldState } from "./world-state";
import { repositionUnits } from "./nation/reposition-units";
import {
  FAST_TICK_MS,
  SLOW_TICK_MS,
  getSpeedMultiplier,
  type SimClock,
} from "./time";

const MAX_FRAME_MS = 250;

export function updateSimulation(world: WorldState, clock: SimClock, deltaMs: number): void {
  const clampedDelta = Math.min(MAX_FRAME_MS, Math.max(0, deltaMs));
  const scaledMs = clampedDelta * getSpeedMultiplier(clock);
  if (scaledMs <= 0) {
    return;
  }

  clock.accumulatorMs += scaledMs;
  clock.slowAccumulatorMs += scaledMs;

  while (clock.accumulatorMs >= FAST_TICK_MS) {
    clock.accumulatorMs -= FAST_TICK_MS;
    stepFastTick(world, FAST_TICK_MS);
  }

  while (clock.slowAccumulatorMs >= SLOW_TICK_MS) {
    clock.slowAccumulatorMs -= SLOW_TICK_MS;
    stepSlowTick(world, SLOW_TICK_MS);
  }
}

function stepFastTick(world: WorldState, dtMs: number): void {
  world.time.fastTick += 1;
  world.time.elapsedMs += dtMs;
  repositionUnits(world, dtMs);
  // TODO: combat updates.
}

function stepSlowTick(world: WorldState, _dtMs: number): void {
  world.time.slowTick += 1;
  // TODO: resource/production updates.
}
