/** Pure national policy. Combat and movement rules are deliberately absent. */
import type { CampaignAlternative } from "./alternatives";
export const MINIMUM_CAMPAIGN_FOOD_DAYS = 450;

export type CampaignMode = "defend" | "limited-offensive" | "consolidate" | "seek-peace";
export interface CampaignConstraints {
  strengthRatio: number;
  casualtyFraction: number;
  costTolerance: number;
  foodDays: number;
  replacementConstrained: boolean;
  capitalCritical: boolean;
  objectivesSecured: boolean;
  aggression: number;
}
export interface CampaignDecision {
  mode: CampaignMode;
  reason: string;
}

export function requiresCampaignReview(
  current: CampaignConstraints, previous: CampaignConstraints | undefined,
  ageTicks: number, membershipChanged: boolean,
): boolean {
  if (!previous || membershipChanged || ageTicks >= 80) return true;
  return current.capitalCritical && !previous.capitalCritical ||
    current.foodDays < MINIMUM_CAMPAIGN_FOOD_DAYS && previous.foodDays >= MINIMUM_CAMPAIGN_FOOD_DAYS ||
    current.casualtyFraction >= current.costTolerance && previous.casualtyFraction < previous.costTolerance ||
    current.objectivesSecured !== previous.objectivesSecured;
}

export function campaignCostLimitReached(input: CampaignConstraints): boolean {
  return input.casualtyFraction >= input.costTolerance || input.foodDays < MINIMUM_CAMPAIGN_FOOD_DAYS;
}

export function evaluateCampaignPolicy(input: CampaignConstraints, alternatives?: CampaignAlternative[]): CampaignDecision {
  if (input.capitalCritical) return { mode: "defend", reason: "capital-emergency" };
  if (campaignCostLimitReached(input)) {
    return { mode: "seek-peace", reason: input.foodDays < MINIMUM_CAMPAIGN_FOOD_DAYS ? "food-runway" : "cost-limit" };
  }
  if (alternatives?.length) {
    const choice = alternatives[0];
    return { mode: choice.mode, reason: `expected-value:${choice.mode}:${choice.opponentId}` };
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
