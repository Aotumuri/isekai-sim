/** Pure national policy. Combat and movement rules are deliberately absent. */
export type CampaignMode = "defend" | "limited-offensive" | "consolidate" | "seek-peace";
export interface CampaignConstraints {
  strengthRatio: number;
  casualtyFraction: number;
  costTolerance: number;
  foodSeconds: number;
  replacementConstrained: boolean;
  capitalCritical: boolean;
  objectivesSecured: boolean;
  aggression: number;
}
export interface CampaignDecision {
  mode: CampaignMode;
  reason: string;
}

export function evaluateCampaignPolicy(input: CampaignConstraints): CampaignDecision {
  if (input.capitalCritical) return { mode: "defend", reason: "capital-emergency" };
  if (input.casualtyFraction >= input.costTolerance || input.foodSeconds < 45) {
    return { mode: "seek-peace", reason: input.foodSeconds < 45 ? "food-runway" : "cost-limit" };
  }
  if (input.objectivesSecured) return { mode: "consolidate", reason: "objectives-secured" };
  if (input.strengthRatio < 0.8 || input.replacementConstrained) {
    return { mode: "defend", reason: input.replacementConstrained ? "replacement-shortage" : "national-force-deficit" };
  }
  if (input.strengthRatio >= 1.05 + (1 - input.aggression) * 0.25) {
    return { mode: "limited-offensive", reason: "affordable-opportunity" };
  }
  return { mode: "defend", reason: "preserve-force" };
}
