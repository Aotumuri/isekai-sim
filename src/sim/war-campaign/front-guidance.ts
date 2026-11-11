import type { NationFrontPlan } from "../nation-front-plans";
import type { WorldState } from "../world-state";
import { getOpposingFrontSide } from "../land-fronts";
import { getWarCampaign } from "./state";

/** Strategic intent changes discretionary effort, never the safety floor. */
export function applyCampaignFrontGuidance(world: WorldState, plan: NationFrontPlan): NationFrontPlan {
  const campaign = getWarCampaign(world, plan.nationId);
  const front = world.landFronts.operationalSectorsById.get(plan.frontId);
  if (!campaign || !front) return plan;
  const enemy = getOpposingFrontSide(front, plan.nationId);
  const emergency = plan.reasonFlags.some((reason) =>
    reason === "capital-threatened" || reason === "major-force-supply-risk" ||
    reason === "supply-corridor" || reason === "bridgehead-campaign");
  if (emergency || plan.posture === "retreat") return plan;
  const primary = enemy?.nationId === campaign.primaryOpponentId;
  const attackAllowed = campaign.mode === "limited-offensive" && primary;
  return {
    ...plan,
    posture: plan.posture === "attack" && !attackAllowed ? "hold" : plan.posture,
    priority: Math.max(0, Math.min(100, plan.priority + (primary ? 10 : 0))),
    reasonFlags: [...plan.reasonFlags, primary ? "campaign-primary" : "campaign-economy-of-force"],
  };
}
