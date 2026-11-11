import { hasMinimumPeaceAge } from "../peace-maturity";
import type { NationId } from "../../worldgen/nation";
import type { WorldState } from "../world-state";
import type { PeaceTerms } from "../war-negotiations";
import { getOwnerByMesoId } from "../world-cache";
import { getWarDeclarationMode } from "../simulation-settings";
import { findWar } from "../war-state";
import { campaignCostLimitReached } from "./policy";
import { getWarCampaign } from "./state";

/** Evaluate the post-settlement goal, not temporary occupation or demands. */
export function campaignPeaceValue(
  world: WorldState, recipient: NationId, proposer: NationId, terms: PeaceTerms,
): number {
  const campaign = getWarCampaign(world, recipient);
  const goal = campaign?.objectives.find((item) => item.opponentId === proposer);
  if (!campaign || !goal) return 0;
  const owners = getOwnerByMesoId(world);
  const territorial = goal.regionIds.length > 0 && goal.regionIds.every((id) =>
    !terms.demandedRegionIds.includes(id) &&
    (owners.get(id) === recipient || terms.offeredRegionIds.includes(id)));
  const secured = territorial || goal.political?.purpose === "coercive-settlement" &&
    terms.offeredWeapons - terms.demandedWeapons >= goal.political.weaponTarget &&
    terms.demandedRegionIds.length === 0;
  const exitPressure = campaign.mode === "seek-peace" ? 12 : 0;
  return exitPressure + (secured ? 12 : 0);
}

/** A capital emergency may override posture without resetting the exit budget.
 * Test/legacy wars retain their military exit because negotiation is unavailable. */
export function campaignPrefersSettlement(world: WorldState, nationId: NationId, opponentId: NationId): boolean {
  const campaign = getWarCampaign(world, nationId);
  if (!campaign || getWarDeclarationMode(world) !== "diplomacy") return false;
  const war = findWar(world.wars, nationId, opponentId);
  if (!war || war.isTest) return false;
  if (campaign.mode === "seek-peace" || campaignCostLimitReached(campaign.constraints)) return true;
  return hasMinimumPeaceAge(world.time.fastTick, war.startedAtFastTick) &&
    campaign.mode === "consolidate";
}
