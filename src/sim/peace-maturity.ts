import { FAST_TICK_MS } from "./time";

const MINIMUM_PEACE_AGE_SECONDS = 30;

/** Shared existing auto-acceptance timing, independent of offer desirability. */
export function isPeaceNegotiationMature(ageSeconds: number, exchangedBlows: boolean, urgency: number): boolean {
  return ageSeconds >= 90 || ageSeconds >= MINIMUM_PEACE_AGE_SECONDS && (exchangedBlows || urgency >= 0.8);
}

/** Before this necessary minimum, consolidation cannot yet end the war. */
export function hasMinimumPeaceAge(fastTick: number, startedAtFastTick: number): boolean {
  return (fastTick - startedAtFastTick) * FAST_TICK_MS / 1000 >= MINIMUM_PEACE_AGE_SECONDS;
}
