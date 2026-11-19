import { daysToSlowTicks, yearsToDays } from "./time";

export const DEFAULT_TRUCE_DAYS = yearsToDays(5);
export const EXTENDED_PEACE_DAYS = yearsToDays(10);
export const MAX_TRUCE_DAYS = yearsToDays(15);
export const CRISIS_TRUCE_SLOW_TICKS = daysToSlowTicks(1200);

export const TREATY_DURATION_SLOW_TICKS = {
  alliance: daysToSlowTicks(yearsToDays(8)),
  trade: daysToSlowTicks(yearsToDays(5)),
  "non-aggression": daysToSlowTicks(yearsToDays(5)),
} as const;
