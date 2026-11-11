import type { NationId } from "../../worldgen/nation";
import type { CampaignMode } from "./policy";

/** Values are fractions of national territory and opening field strength.
 * These are short-horizon estimates, not simulated or guaranteed outcomes. */
export interface CampaignAlternative {
  mode: CampaignMode;
  opponentId: NationId;
  benefit: number;
  resourceCost: number;
  failureRisk: number;
  uncertainty: number;
  changeCost: number;
  score: number;
}
export interface CampaignOpportunity {
  opponentId: NationId;
  availableStrength: number;
  opposition: number;
  arrivalSeconds: number;
  objectiveValue: number;
  securedValue: number;
  homelandAtRisk: number;
  lossFractionPerSecond: number;
  replacementFraction: number;
  peaceProbability: number;
  settlementValue: number;
  militaryGoalHeld: boolean;
  uncertainty: number;
  committedFraction: number;
}
const HORIZON_SECONDS = 30;
const clamp = (n: number) => Math.max(0, Math.min(1, n));

export function evaluateCampaignAlternatives(
  opportunities: CampaignOpportunity[], aggression: number,
  current?: { mode: CampaignMode; primaryOpponentId: NationId | null },
): CampaignAlternative[] {
  const alternatives: CampaignAlternative[] = [];
  for (const input of opportunities) {
    const ratio = input.availableStrength / Math.max(1, input.opposition);
    const arrival = Number.isFinite(input.arrivalSeconds)
      ? clamp(1 - input.arrivalSeconds / HORIZON_SECONDS) : 0;
    // A bounded relative-power estimate; terrain and hidden future commitments
    // remain explicitly uncertain. No combat rule or random draw is changed.
    const success = clamp(ratio * ratio / (1 + ratio * ratio) * arrival);
    const loss = clamp(input.lossFractionPerSecond * HORIZON_SECONDS);
    const attackCost = loss + (1 - success) * clamp(input.availableStrength /
      Math.max(1, input.availableStrength + input.opposition)) * 0.1;
    const options: Omit<CampaignAlternative, "opponentId" | "changeCost" | "score">[] = [
      { mode: "limited-offensive", benefit: input.securedValue + success * input.objectiveValue,
        resourceCost: attackCost, failureRisk: input.homelandAtRisk * (1 - success),
        uncertainty: input.uncertainty * input.objectiveValue },
      { mode: "defend", benefit: input.securedValue,
        resourceCost: loss * 0.5, failureRisk: input.homelandAtRisk * clamp(1 - ratio),
        uncertainty: input.uncertainty * input.homelandAtRisk },
    ];
    if (input.peaceProbability > 0) options.push({
      mode: input.militaryGoalHeld && input.settlementValue > 0 ? "consolidate" : "seek-peace",
      benefit: input.settlementValue * input.peaceProbability,
      resourceCost: loss * (1 - input.peaceProbability) * 0.5,
      failureRisk: input.homelandAtRisk * (1 - input.peaceProbability),
      uncertainty: input.uncertainty * input.settlementValue * (1 - input.peaceProbability),
    });
    for (const option of options) {
      const changed = current && (current.mode !== option.mode || current.primaryOpponentId !== input.opponentId);
      // Real committed force and travel opportunity cost, not a fixed ban on
      // changing decisions. Strong evidence can outweigh the sunk plan.
      const changeCost = changed ? input.committedFraction *
        clamp(input.arrivalSeconds / HORIZON_SECONDS) * 0.1 : 0;
      const riskAversion = 1.5 - aggression;
      const replacementRisk = Math.max(0, loss - input.replacementFraction) *
        (option.mode === "limited-offensive" ? 1 : option.mode === "defend" ? 0.5 : 1 - input.peaceProbability);
      alternatives.push({ ...option, opponentId: input.opponentId, changeCost,
        score: option.benefit - option.resourceCost * riskAversion -
          (option.failureRisk + replacementRisk) * riskAversion - option.uncertainty * 0.25 - changeCost });
    }
  }
  return alternatives.sort((a, b) => b.score - a.score ||
    Number(b.mode === current?.mode && b.opponentId === current?.primaryOpponentId) -
    Number(a.mode === current?.mode && a.opponentId === current?.primaryOpponentId) ||
    a.opponentId.localeCompare(b.opponentId) || a.mode.localeCompare(b.mode));
}
