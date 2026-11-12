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
  securedValue?: number;
  /** Local incremental outlook, excluding the baseline from unrelated wars. */
  opponentContinuationValue?: number;
  defensiveExposure?: number;
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
  settlementReady?: boolean;
}
const HORIZON_SECONDS = 30;
const clamp = (n: number) => Math.max(0, Math.min(1, n));

export function evaluateCampaignAlternatives(
  opportunities: CampaignOpportunity[], aggression: number,
  current?: { mode: CampaignMode; primaryOpponentId: NationId | null; militaryMode?: "defend" | "limited-offensive" },
): CampaignAlternative[] {
  const opposition = opportunities.reduce((sum, input) => sum + Math.max(0, input.opposition), 0);
  const alternatives = opportunities.flatMap((input) => localCampaignAlternatives(input, aggression, current,
    opposition > 0 ? Math.max(0, input.opposition) / opposition : 1 / opportunities.length));
  const defensive = alternatives.filter((option) => option.mode === "defend");
  const total = (read: (option: CampaignAlternative) => number) => defensive.reduce((sum, option) => sum + read(option), 0);
  const baselineScore = total((option) => option.score + option.changeCost);
  const baseline = { benefit: total((o) => o.benefit), resourceCost: total((o) => o.resourceCost),
    failureRisk: total((o) => o.failureRisk), uncertainty: total((o) => o.uncertainty),
    securedValue: total((o) => o.securedValue ?? 0) };
  const portfolios = alternatives.map((option) => {
    const localDefense = defensive.find((item) => item.opponentId === option.opponentId)!;
    return { ...option,
      benefit: baseline.benefit + option.benefit - localDefense.benefit,
      resourceCost: baseline.resourceCost + option.resourceCost - localDefense.resourceCost,
      failureRisk: baseline.failureRisk + option.failureRisk - localDefense.failureRisk,
      uncertainty: baseline.uncertainty + option.uncertainty - localDefense.uncertainty,
      securedValue: baseline.securedValue + (option.securedValue ?? 0) - (localDefense.securedValue ?? 0),
      score: baselineScore + (option.score - (localDefense.score + localDefense.changeCost)),
    };
  });
  return portfolios.sort((a, b) => b.score - a.score ||
    (a.mode === "defend" && b.mode === "defend" ? (b.defensiveExposure ?? 0) - (a.defensiveExposure ?? 0) : 0) ||
    Number(b.mode === current?.mode && b.opponentId === current?.primaryOpponentId) -
    Number(a.mode === current?.mode && a.opponentId === current?.primaryOpponentId) ||
    a.opponentId.localeCompare(b.opponentId) || a.mode.localeCompare(b.mode));
}

function localCampaignAlternatives(
  input: CampaignOpportunity, aggression: number,
  current: Parameters<typeof evaluateCampaignAlternatives>[2], nationalCostShare: number,
): CampaignAlternative[] {
  const alternatives: CampaignAlternative[] = [];
  const ratio = input.availableStrength / Math.max(1, input.opposition);
  const arrival = Number.isFinite(input.arrivalSeconds)
    ? clamp(1 - input.arrivalSeconds / HORIZON_SECONDS) : 0;
  // A bounded relative-power estimate; terrain and hidden future commitments
  // remain explicitly uncertain. No combat rule or random draw is changed.
  const success = clamp(ratio * ratio / (1 + ratio * ratio) * arrival);
  const loss = clamp(input.lossFractionPerSecond * HORIZON_SECONDS) * nationalCostShare;
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
    const military = option.mode === "defend" || option.mode === "limited-offensive";
    const existingMode = military ? current?.militaryMode ?? current?.mode : current?.mode;
    const changed = current && (existingMode !== option.mode ||
      option.mode === "limited-offensive" && current.primaryOpponentId !== input.opponentId);
    // Real committed force and travel opportunity cost, not a fixed ban on
    // changing decisions. Strong evidence can outweigh the sunk plan.
    const changeCost = changed && military ? input.committedFraction *
      clamp(input.arrivalSeconds / HORIZON_SECONDS) * 0.1 : 0;
    const riskAversion = 1.5 - aggression;
    const replacementRisk = Math.max(0, loss - input.replacementFraction * nationalCostShare) *
      (option.mode === "limited-offensive" ? 1 : option.mode === "defend" ? 0.5 : 1 - input.peaceProbability);
    const score = option.benefit - option.resourceCost * riskAversion -
      (option.failureRisk + replacementRisk) * riskAversion - option.uncertainty * 0.25 - changeCost;
    alternatives.push({ ...option, opponentId: input.opponentId, changeCost, securedValue: input.securedValue,
      opponentContinuationValue: score - input.securedValue,
      defensiveExposure: input.homelandAtRisk * input.opposition / Math.max(1, input.availableStrength + input.opposition), score });
  }
  return alternatives;
}

/** Negotiating does not remove the need for a military fallback. */
export function selectCampaignMilitaryEffort(alternatives: CampaignAlternative[], mode: CampaignMode, constrained: boolean) {
  const options = alternatives.filter((option) => option.mode === "defend" || option.mode === "limited-offensive");
  const choice = mode === "defend" || constrained ? options.find((option) => option.mode === "defend")
    : mode === "limited-offensive" ? options.find((option) => option.mode === "limited-offensive") : options[0];
  return { mode: choice?.mode === "limited-offensive" ? "limited-offensive" as const : "defend" as const,
    opponentId: choice?.opponentId ?? null };
}

export function hasClearCampaignImprovement(candidate: CampaignAlternative | undefined, current: CampaignAlternative | undefined): boolean {
  return !!candidate && !!current && candidate.score - current.score > (candidate.uncertainty + current.uncertainty) * 0.25;
}
