import { hasMinimumPeaceAge } from "../peace-maturity";
import type { NationFrontPlan } from "../nation-front-plans";
import { WORLD_BALANCE } from "../../data/balance";
import type { WorldState } from "../world-state";
import { getFrontSide, getOpposingFrontSide } from "../land-fronts";
import { getWarDeclarationMode } from "../simulation-settings";
import { findWar } from "../war-state";
import { getOffensiveOperationForFront } from "../offensive-operations";
import { campaignShouldStandDown } from "./peace-guidance";
import { campaignCostLimitReached } from "./policy";
import { getWarCampaign } from "./state";
import { getOwnerByMesoId } from "../world-cache";

/** Strategic intent changes discretionary effort, never the safety floor. */
export function applyCampaignFrontGuidance(world: WorldState, plan: NationFrontPlan): NationFrontPlan {
  const campaign = getWarCampaign(world, plan.nationId);
  const front = world.landFronts.operationalSectorsById.get(plan.frontId);
  if (!campaign || !front) return plan;
  const enemy = getOpposingFrontSide(front, plan.nationId);
  const settling = !!enemy && campaignShouldStandDown(world, plan.nationId, enemy.nationId);
  const mode = !settling && (campaign.mode === "seek-peace" || campaign.mode === "consolidate")
    ? campaign.militaryMode ?? "defend" : campaign.mode;
  const emergency = plan.reasonFlags.some((reason) =>
    reason === "capital-threatened" || reason === "major-force-supply-risk" ||
    reason === "supply-corridor" || reason === "bridgehead-campaign" && !settling);
  if (emergency || plan.posture === "retreat") return plan;
  const primary = enemy?.nationId === campaign.primaryOpponentId;
  const friendly = getFrontSide(front, plan.nationId);
  const war = enemy && findWar(world.wars, plan.nationId, enemy.nationId);
  const canNegotiate = getWarDeclarationMode(world) === "diplomacy" && war && !war.isTest &&
    hasMinimumPeaceAge(world.time.fastTick, war.startedAtFastTick);
  // Legacy/test wars have no negotiated exit. Reaching a limited goal cannot
  // permanently suspend their only legal route to a terminal state. Normal
  // wars also need a military route before the minimum peace age.
  const militaryResolution = !canNegotiate &&
    (campaign.mode === "consolidate" || campaign.mode === "seek-peace");
  const owners = getOwnerByMesoId(world);
  const homelandRecovery = !!enemy?.borderRegionIds.some((id) => owners.get(id) === plan.nationId &&
    world.occupation.mesoById.get(id) === enemy.nationId);
  const defensiveOpportunity = mode === "defend" && homelandRecovery && friendly && enemy &&
    friendly.strength >= enemy.strength * WORLD_BALANCE.war.landFront.plan.attackContinueRatio &&
    !campaign.constraints.replacementConstrained;
  const committed = getOffensiveOperationForFront(world, front.id, plan.nationId);
  const preserveCommitment = committed && committed.phase !== "recovering" &&
    (mode !== "defend" || homelandRecovery) &&
    !campaign.constraints.capitalCritical && mode !== "seek-peace" &&
    (!settling || committed.phase === "attacking" && !campaignCostLimitReached(campaign.constraints));
  const attackAllowed = preserveCommitment || !settling && primary &&
    (mode === "limited-offensive" || militaryResolution || defensiveOpportunity);
  return {
    ...plan,
    posture: plan.posture === "attack" && !attackAllowed ? "hold" : plan.posture,
    priority: Math.max(0, Math.min(100, plan.priority + (primary ? 10 : 0))),
    reasonFlags: [...plan.reasonFlags, primary ? "campaign-primary" : "campaign-economy-of-force",
      ...(militaryResolution && !settling ? ["campaign-military-exit" as const] : [])],
  };
}
