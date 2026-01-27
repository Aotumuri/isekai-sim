export const FAST_TICK_MS = 100;
export const SLOW_TICK_MS = 1000;
export const SPEED_MULTIPLIERS = [0.1, 0.5, 1, 2, 4, 8, 16, 32] as const;
export const DEFAULT_SPEED_INDEX = 1;

export interface SimTime {
  elapsedMs: number;
  fastTick: number;
  slowTick: number;
}

export interface SimClock {
  accumulatorMs: number;
  slowAccumulatorMs: number;
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
    slowAccumulatorMs: 0,
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
