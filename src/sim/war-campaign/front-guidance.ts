import type { NationFrontPlan } from "../nation-front-plans";
import { WORLD_BALANCE } from "../../data/balance";
import type { WorldState } from "../world-state";
import { getFrontSide, getOpposingFrontSide } from "../land-fronts";
import { getWarDeclarationMode } from "../simulation-settings";
import { findWar } from "../war-state";
import { getOffensiveOperationForFront } from "../offensive-operations";
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
  const friendly = getFrontSide(front, plan.nationId);
  const war = enemy && findWar(world.wars, plan.nationId, enemy.nationId);
  const canNegotiate = getWarDeclarationMode(world) === "diplomacy" && war && !war.isTest;
  // Legacy/test wars have no negotiated exit. Reaching a limited goal cannot
  // permanently suspend their only legal route to a terminal state.
  const militaryResolution = !canNegotiate &&
    (campaign.mode === "consolidate" || campaign.mode === "seek-peace");
  const defensiveOpportunity = campaign.mode === "defend" && friendly && enemy &&
    friendly.strength >= enemy.strength * WORLD_BALANCE.war.landFront.plan.attackContinueRatio &&
    !campaign.constraints.replacementConstrained;
  const committed = getOffensiveOperationForFront(world, front.id, plan.nationId);
  const preserveCommitment = committed && committed.phase !== "recovering" &&
    !campaign.constraints.capitalCritical && campaign.mode !== "seek-peace";
  const attackAllowed = preserveCommitment || primary &&
    (campaign.mode === "limited-offensive" || militaryResolution || defensiveOpportunity);
  return {
    ...plan,
    posture: plan.posture === "attack" && !attackAllowed ? "hold" : plan.posture,
    priority: Math.max(0, Math.min(100, plan.priority + (primary ? 10 : 0))),
    reasonFlags: [...plan.reasonFlags, primary ? "campaign-primary" : "campaign-economy-of-force"],
  };
}
