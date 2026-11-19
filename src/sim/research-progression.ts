// Keep the original technology scale through level 10, then reduce the
// marginal effect smoothly toward a further ten levels' worth of improvement.
export function effectiveResearchLevel(level: number): number {
  const extra = Math.max(0, level - 10);
  return Math.min(level, 10) + 10 * (extra / (10 + extra));
}

export function lateResearchCost(level: number): number {
  return 3 * Math.max(0, level - 10) ** 2;
}

// Preserve values in the ordinary operating range. Near either physical
// limit, approach it gradually with a continuous first derivative.
export function limitEquipmentStat(value: number, min: number, max: number, shoulder: number): number {
  const upper = max - shoulder, lower = min + shoulder;
  if (value > upper) return max - shoulder ** 2 / (shoulder + value - upper);
  if (value < lower) return min + shoulder ** 2 / (shoulder + lower - value);
  return value;
}
