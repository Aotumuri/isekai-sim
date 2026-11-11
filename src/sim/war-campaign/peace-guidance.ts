import type { NationId } from "../../worldgen/nation";
import type { WorldState } from "../world-state";
import type { PeaceTerms } from "../war-negotiations";
import { getOwnerByMesoId } from "../world-cache";
import { getWarCampaign } from "./state";

/** Evaluate the post-settlement goal, not temporary occupation or demands. */
export function campaignPeaceValue(
  world: WorldState, recipient: NationId, proposer: NationId, terms: PeaceTerms,
): number {
  const campaign = getWarCampaign(world, recipient);
  const goal = campaign?.objectives.find((item) => item.opponentId === proposer);
  if (!campaign || !goal) return 0;
  const owners = getOwnerByMesoId(world);
  const secured = goal.regionIds.length > 0 && goal.regionIds.every((id) =>
    !terms.demandedRegionIds.includes(id) &&
    (owners.get(id) === recipient || terms.offeredRegionIds.includes(id)));
  const exitPressure = campaign.mode === "seek-peace" ? 12 : 0;
  return exitPressure + (secured ? 12 : 0);
}
