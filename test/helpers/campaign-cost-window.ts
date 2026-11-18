export interface CampaignCostWindowPoint {
  openingWarKey: string;
  planPresent: boolean;
  objectivePresent: boolean;
  openingWarActive: boolean;
  activeWarMembershipKey: string;
  campaignMembershipKey: string;
  openingDenominator: number | null;
  militaryMode: string | null;
  primaryOpponentId: string | null;
  observation: { tick: number; casualtyFraction: number; lossRate: number } | null;
}

export interface CampaignCostWindowResult {
  eligible: boolean;
  censorReason: string | null;
  censorReasons: string[];
  predictedLossFractionFromObservedRate: number | null;
  actualCasualtyFractionIncrease: number | null;
}

export function classifyCampaignCostWindow(
  origin: CampaignCostWindowPoint,
  future: CampaignCostWindowPoint | null,
  intermediate: readonly (CampaignCostWindowPoint | null)[],
): CampaignCostWindowResult {
  const reasons = new Set<string>();
  if (!origin.openingWarActive) reasons.add("opening-war-ended-at-origin");
  if (!origin.planPresent) reasons.add("campaign-plan-missing-at-origin");
  if (origin.planPresent && !origin.objectivePresent) reasons.add("opening-objective-missing-at-origin");
  if (!origin.observation) reasons.add("campaign-observation-missing-at-origin");
  if (!future) reasons.add("future-observation-missing");
  if (future) {
    if (future.openingWarKey !== origin.openingWarKey) reasons.add("opening-war-key-changed");
    if (!future.openingWarActive) reasons.add("opening-war-ended-before-future");
    if (!future.planPresent) reasons.add("campaign-plan-missing-at-future");
    if (future.planPresent && !future.objectivePresent) reasons.add("opening-objective-missing-at-future");
    if (!future.observation) reasons.add("campaign-observation-missing-at-future");
  }
  for (const point of intermediate) {
    if (!point) { reasons.add("intermediate-observation-missing"); continue; }
    if (point.openingWarKey !== origin.openingWarKey) reasons.add("opening-war-key-changed");
    if (!point.openingWarActive) reasons.add("opening-war-ended-before-future");
    if (!point.planPresent || !point.objectivePresent || !point.observation) reasons.add("campaign-plan-missing-in-window");
    if (point.activeWarMembershipKey !== origin.activeWarMembershipKey ||
      point.campaignMembershipKey !== origin.campaignMembershipKey) reasons.add("war-membership-changed");
    if (point.openingDenominator !== origin.openingDenominator) reasons.add("opening-denominator-changed");
    if (point.militaryMode !== origin.militaryMode) reasons.add("military-mode-changed");
    if (point.primaryOpponentId !== origin.primaryOpponentId) reasons.add("priority-opponent-changed");
  }
  if (future) {
    if (future.activeWarMembershipKey !== origin.activeWarMembershipKey ||
      future.campaignMembershipKey !== origin.campaignMembershipKey) reasons.add("war-membership-changed");
    if (future.openingDenominator !== origin.openingDenominator) reasons.add("opening-denominator-changed");
    if (future.militaryMode !== origin.militaryMode) reasons.add("military-mode-changed");
    if (future.primaryOpponentId !== origin.primaryOpponentId) reasons.add("priority-opponent-changed");
  }
  const censorReasons = [...reasons];
  const eligible = censorReasons.length === 0;
  return { eligible, censorReason: censorReasons[0] ?? null, censorReasons,
    predictedLossFractionFromObservedRate: origin.observation
      ? Math.min(1, origin.observation.lossRate * 30) : null,
    actualCasualtyFractionIncrease: eligible && future && origin.observation && future.observation
      ? future.observation.casualtyFraction - origin.observation.casualtyFraction : null };
}
