import type { NationId } from "../../worldgen/nation";
import type { NationFrontPlan } from "../nation-front-plans";
import type { WorldState } from "../world-state";
import { getWarCampaign } from "./state";
import { campaignShouldStandDown } from "./peace-guidance";

/** Request the existing focus mechanism; never create a competing allocator. */
export function campaignConcentrationDirective(world: WorldState, nationId: NationId, opponentId: NationId): "request" | "withhold" | "legacy" {
  const campaign = getWarCampaign(world, nationId);
  if (!campaign) return "legacy";
  if (campaignShouldStandDown(world, nationId, opponentId)) return "withhold";
  const effort = campaign.militaryMode ?? campaign.mode;
  if (effort !== "limited-offensive") return "legacy";
  return campaign.primaryOpponentId === opponentId ? "request" : "withhold";
}

/** Concentration may reduce discretionary demand, never emergency demand. */
export function campaignPreservesFrontDemand(world: WorldState, plan: NationFrontPlan): boolean {
  return !!getWarCampaign(world, plan.nationId) && plan.reasonFlags.some((reason) =>
    reason === "capital-threatened" || reason === "major-force-supply-risk" ||
    reason === "supply-corridor" || reason === "bridgehead-campaign");
}
