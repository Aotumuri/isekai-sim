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
import { updateLandFronts } from "./land-fronts";
import { updateNationFrontPlans } from "./nation-front-plans";
import { updateNationFrontAllocations } from "./nation-front-allocations";
import {
  cancelOffensiveOperationsForCapitalEmergency,
  updateOffensiveOperations,
} from "./offensive-operations";
import { updateRetreatPlans } from "./retreat-plans";
import { updateCapitalDefense } from "./capital-defense";
import { updateStrategicReserves } from "./strategic-reserves";
import { updateReorganization } from "./reorganization";
import { updateFrontlineCoverage } from "./frontline-coverage";
import {
  beginAiGeographyEvaluation,
  prepareFrontDistanceFields,
} from "./ai-geography";
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

export function stepFastTick(world: WorldState, dtMs: number): void {
  const instrumentation = world.instrumentation;
  const occupationVersionBefore = instrumentation
    ? world.occupation.version
    : 0;
  const territoryVersionBefore = instrumentation ? world.territoryVersion : 0;
  world.time.fastTick += 1;
  world.time.elapsedMs += dtMs;

  let startedAt = instrumentation ? performance.now() : 0;
  repositionUnits(world, dtMs);
  if (instrumentation) {
    instrumentation.recordDuration("repositionUnits", performance.now() - startedAt);
  }
  const navalEnabled = WORLD_BALANCE.unit.naval?.enabled !== false;
  if (navalEnabled) {
    repositionNavalUnits(world, dtMs);
    updateAmphibiousOperations(world);
  }
  updateBattles(world);

  startedAt = instrumentation ? performance.now() : 0;
  updateOccupation(world);
  if (instrumentation) {
    instrumentation.recordDuration("updateOccupation", performance.now() - startedAt);
    instrumentation.incrementCounter("occupation.fullRegionScans");
    instrumentation.incrementCounter(
      "occupation.regionsScanned",
      world.mesoRegions.length,
    );
  }

  startedAt = instrumentation ? performance.now() : 0;
  updateCapitals(world);
  if (instrumentation) {
    instrumentation.recordDuration("updateCapitals", performance.now() - startedAt);
  }
  updateWarCooperation(world);
  updateCivilWar(world);

  startedAt = instrumentation ? performance.now() : 0;
  updateSurrender(world);
  if (instrumentation) {
    instrumentation.recordDuration("surrender", performance.now() - startedAt);
    instrumentation.incrementCounter(
      "world.occupationChanges",
      world.occupation.version - occupationVersionBefore,
    );
    instrumentation.incrementCounter(
      "world.territoryChanges",
      world.territoryVersion - territoryVersionBefore,
    );
  }
}

export function stepSlowTick(world: WorldState, _dtMs: number): void {
  world.time.slowTick += 1;
  updateProduction(world);
  updateWarDeclarations(world);
  beginAiGeographyEvaluation(world);
  updateLandFronts(world);
  prepareFrontDistanceFields(world);
  updateCapitalDefense(world);
  updateNationFrontPlans(world);
  updateRetreatPlans(world);
  cancelOffensiveOperationsForCapitalEmergency(world);
  updateStrategicReserves(world);
  updateReorganization(world);
  updateNationFrontAllocations(world);
  updateFrontlineCoverage(world);
  updateOffensiveOperations(world);
}
