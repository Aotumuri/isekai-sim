import { FAST_TICK_MS, fastTicksToDays } from "./time";
import type { UnitState } from "./unit";

export function getMoveTicksPerRegion(unit: UnitState): number {
  return Math.max(1, Math.max(1, Math.round(unit.moveTicksPerRegion)) / (unit.design?.mobility ?? 1));
}
/** Land movement carries fractional progress through intermediate regions. */
export function estimateLandTravelDays(unit: UnitState, regions: number): number {
  return fastTicksToDays(Math.ceil(regions * getMoveTicksPerRegion(unit)));
}

// Legacy movement accumulation uses fixed engine scheduling units.
export function getMoveMsPerRegion(unit: UnitState): number { return getMoveTicksPerRegion(unit) * FAST_TICK_MS; }
