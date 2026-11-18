/** Existing auto-peace trend scale, shared with campaign continuation values. */
export const PEACE_OUTLOOK_LIMIT = 0.5;
export const PEACE_OUTLOOK_WEIGHT = 45;

export function boundedContinuationPressure(incrementalValue: number): number {
  const bounded = Math.max(-PEACE_OUTLOOK_LIMIT, Math.min(PEACE_OUTLOOK_LIMIT, incrementalValue));
  return bounded === 0 ? 0 : -bounded * PEACE_OUTLOOK_WEIGHT;
}
