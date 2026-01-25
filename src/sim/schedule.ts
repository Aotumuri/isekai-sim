import type { SeededRng } from "../utils/seeded-rng";

export function nextScheduledTickRange(
  currentTick: number,
  minTicks: number,
  maxTicks: number,
  rng: SeededRng,
): number {
  const safeMin = Math.max(1, Math.round(minTicks));
  const safeMax = Math.max(safeMin, Math.round(maxTicks));
  const span = safeMax - safeMin;
  const offset = span > 0 ? rng.nextInt(span + 1) : 0;
  return currentTick + safeMin + offset;
}
