/** Existing automatic acceptance timing, independent of offer desirability. */
export function isPeaceNegotiationMature(ageSeconds: number, exchangedBlows: boolean, urgency: number): boolean {
  return ageSeconds >= 90 || (ageSeconds >= 30 && (exchangedBlows || urgency >= 0.8));
}
