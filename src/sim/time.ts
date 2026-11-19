export const DAYS_PER_FAST_TICK = 1;
export const DAYS_PER_SLOW_TICK = 10;
export const DAYS_PER_YEAR = 365;
export const FAST_TICKS_PER_SLOW_TICK = DAYS_PER_SLOW_TICK / DAYS_PER_FAST_TICK;

// Engine scheduling units only.
export const FAST_TICK_MS = 100;
export const SLOW_TICK_MS = 1000;
export const SPEED_MULTIPLIERS = [0.1, 0.5, 1, 2, 4, 8, 16, 32] as const;
export const DEFAULT_SPEED_INDEX = 1;

export interface SimTime {
  /** Elapsed engine scheduling time. Use fastTick for the world date. */
  elapsedMs: number;
  fastTick: number;
  slowTick: number;
}

export interface SimClock {
  paused?: boolean;
  accumulatorMs: number;
  speedIndex: number;
}

export function createSimTime(): SimTime {
  return {
    elapsedMs: 0,
    fastTick: 0,
    slowTick: 0,
  };
}

export function createSimClock(): SimClock {
  return {
    accumulatorMs: 0,
    speedIndex: DEFAULT_SPEED_INDEX,
  };
}

export function getSpeedMultiplier(clock: SimClock): number {
  return SPEED_MULTIPLIERS[clock.speedIndex] ?? SPEED_MULTIPLIERS[DEFAULT_SPEED_INDEX];
}

export function setSpeedIndex(clock: SimClock, index: number): boolean {
  const clamped = clamp(index, 0, SPEED_MULTIPLIERS.length - 1);
  if (clock.speedIndex === clamped) {
    return false;
  }
  if (clamped < clock.speedIndex) {
    // Keep partial progress, but stop catching up on ticks queued at the old speed.
    const pendingMs = clock.accumulatorMs - (clock.accumulatorMs % FAST_TICK_MS);
    clock.accumulatorMs -= pendingMs;
  }
  clock.speedIndex = clamped;
  return true;
}

export function increaseSpeed(clock: SimClock): boolean {
  return setSpeedIndex(clock, clock.speedIndex + 1);
}

export function decreaseSpeed(clock: SimClock): boolean {
  return setSpeedIndex(clock, clock.speedIndex - 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export const yearsToDays = (years: number): number => years * DAYS_PER_YEAR;
export const fastTicksToDays = (ticks: number): number => ticks * DAYS_PER_FAST_TICK;
export const slowTicksToDays = (ticks: number): number => ticks * DAYS_PER_SLOW_TICK;

/** Round durations up to a whole tick of the selected cadence. */
export const daysToFastTicks = (days: number): number => durationTicks(days, DAYS_PER_FAST_TICK);
export const daysToSlowTicks = (days: number): number => durationTicks(days, DAYS_PER_SLOW_TICK);
export const completedSlowTicks = (fastTick: number): number =>
  Math.floor(fastTick / FAST_TICKS_PER_SLOW_TICK);

function durationTicks(days: number, daysPerTick: number): number {
  if (!Number.isFinite(days)) throw new RangeError("Duration must be finite");
  return Math.max(0, Math.ceil(days / daysPerTick));
}

export function remainingDays(nowFastTick: number, deadlineFastTick: number): number {
  return fastTicksToDays(Math.max(0, deadlineFastTick - nowFastTick));
}

export function remainingDaysUntilSlowTick(nowFastTick: number, deadlineSlowTick: number): number {
  return remainingDays(nowFastTick, deadlineSlowTick * FAST_TICKS_PER_SLOW_TICK);
}

export function formatWorldDate(fastTick: number): string {
  if (!Number.isSafeInteger(fastTick) || fastTick < 0) return "Unknown date";
  const days = fastTicksToDays(fastTick);
  return `Year ${Math.floor(days / DAYS_PER_YEAR) + 1}, day ${days % DAYS_PER_YEAR + 1}`;
}
