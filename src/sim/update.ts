import { WORLD_BALANCE } from "../data/balance";
import type { WorldState } from "./world-state";
import { updateBattles } from "./battles";
import { updateCapitals } from "./capitals";
import { updateCivilWar } from "./civil-war";
import { updateAmphibiousOperations } from "./amphibious";
import { repositionNavalUnits, repositionUnits } from "./nation/reposition-units";
import { updateOccupation } from "./occupation";
import { updateProduction } from "./production";
import { updateSurrender } from "./surrender";
import { updateWarCooperation } from "./war-cooperation";
import { updateWarDeclarations } from "./war-declaration";
import {
  FAST_TICK_MS,
  SLOW_TICK_MS,
  getSpeedMultiplier,
  type SimClock,
} from "./time";

const MAX_FRAME_MS = 250;
const MAX_FAST_TICKS_PER_FRAME = 8;
const FAST_TICK_BUDGET_MS = 8;

export function updateSimulation(world: WorldState, clock: SimClock, deltaMs: number): void {
  const clampedDelta = Math.min(MAX_FRAME_MS, Math.max(0, deltaMs));
  const scaledMs = clampedDelta * getSpeedMultiplier(clock);
  if (scaledMs <= 0) {
    return;
  }

  clock.accumulatorMs += scaledMs;
  clock.slowAccumulatorMs += scaledMs;

  let processedFastTicks = 0;
  const fastTickBudgetStartedAt =
    clock.accumulatorMs >= FAST_TICK_MS ? performance.now() : 0;
  while (
    clock.accumulatorMs >= FAST_TICK_MS &&
    processedFastTicks < MAX_FAST_TICKS_PER_FRAME
  ) {
    clock.accumulatorMs -= FAST_TICK_MS;
    stepFastTick(world, FAST_TICK_MS);
    processedFastTicks += 1;
    if (performance.now() - fastTickBudgetStartedAt >= FAST_TICK_BUDGET_MS) {
      break;
    }
  }

  const dueSlowTicks = Math.floor(world.time.elapsedMs / SLOW_TICK_MS);
  while (
    clock.slowAccumulatorMs >= SLOW_TICK_MS &&
    world.time.slowTick < dueSlowTicks
  ) {
    clock.slowAccumulatorMs -= SLOW_TICK_MS;
    stepSlowTick(world, SLOW_TICK_MS);
  }
}

function stepFastTick(world: WorldState, dtMs: number): void {
  world.time.fastTick += 1;
  world.time.elapsedMs += dtMs;
  repositionUnits(world, dtMs);
  const navalEnabled = WORLD_BALANCE.unit.naval?.enabled !== false;
  if (navalEnabled) {
    repositionNavalUnits(world, dtMs);
    updateAmphibiousOperations(world);
  }
  updateBattles(world);
  updateOccupation(world);
  updateCapitals(world);
  updateWarCooperation(world);
  updateCivilWar(world);
  updateSurrender(world);
}

function stepSlowTick(world: WorldState, _dtMs: number): void {
  world.time.slowTick += 1;
  updateProduction(world);
  updateWarDeclarations(world);
}
