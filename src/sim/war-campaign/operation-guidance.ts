import type { NationId } from "../../worldgen/nation";
import type { NationFrontPlan } from "../nation-front-plans";
import type { WorldState } from "../world-state";
import { getWarCampaign } from "./state";

/** Rank only already eligible candidates; emergency supply relief stays first.
 * Existing topology, preparation feasibility and Schwerpunkt break ties. */
export function campaignOperationRank(world: WorldState, nationId: NationId, plan: NationFrontPlan): number {
  const campaign = getWarCampaign(world, nationId);
  if (!campaign || !plan.reasonFlags.includes("campaign-primary")) return 0;
  return plan.reasonFlags.includes("declared-war-objective") ? 2 : 1;
}
