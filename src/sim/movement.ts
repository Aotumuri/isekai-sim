import { FAST_TICK_MS } from "./time";
import type { UnitState } from "./unit";

export function getMoveTicksPerRegion(unit: UnitState): number {
  return Math.max(1, Math.max(1, Math.round(unit.moveTicksPerRegion)) / (unit.design?.mobility ?? 1));
}
export function getMoveMsPerRegion(unit: UnitState): number { return getMoveTicksPerRegion(unit) * FAST_TICK_MS; }
