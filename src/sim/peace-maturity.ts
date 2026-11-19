import { fastTicksToDays } from "./time";

const MINIMUM_PEACE_AGE_DAYS = 300;

/** Shared existing auto-acceptance timing, independent of offer desirability. */
export function isPeaceNegotiationMature(ageDays: number, exchangedBlows: boolean, urgency: number): boolean {
  return ageDays >= 900 || ageDays >= MINIMUM_PEACE_AGE_DAYS && (exchangedBlows || urgency >= 0.8);
}

/** Before this necessary minimum, consolidation cannot yet end the war. */
export function hasMinimumPeaceAge(fastTick: number, startedAtFastTick: number): boolean {
  return fastTicksToDays(fastTick - startedAtFastTick) >= MINIMUM_PEACE_AGE_DAYS;
}
