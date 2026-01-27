import { FAST_TICK_MS } from "./time";
import type { UnitState } from "./unit";

export function getMoveMsPerRegion(unit: UnitState): number {
  const ticks = Math.max(1, Math.round(unit.moveTicksPerRegion));
  return ticks * FAST_TICK_MS;
}
