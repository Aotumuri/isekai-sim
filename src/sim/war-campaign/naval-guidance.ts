import type { NationId } from "../../worldgen/nation";
import type { MesoRegionId } from "../../worldgen/meso-region";
import type { WorldState } from "../world-state";
import { getOwnerByMesoId } from "../world-cache";
import { WORLD_BALANCE } from "../../data/balance";
import { getWarCampaign } from "./state";

interface NavalIntent {
  type: string;
  priority: number;
  reasonFlags: string[];
  emergency?: boolean;
  targetLinkId?: string;
  targetPortId?: MesoRegionId;
  targetCoastId?: MesoRegionId;
}
/** Keep all emergency/logistics missions and their commitment hysteresis. */
export function applyCampaignNavalGuidance<T extends NavalIntent>(world: WorldState, nationId: NationId, intents: T[]): T[] {
  const campaign = getWarCampaign(world, nationId);
  if (!campaign) return intents;
  const owners = getOwnerByMesoId(world);
  return intents.map((intent) => {
    if (intent.emergency || intent.type === "ESCORT" || intent.type === "INTERCEPT") return intent;
    const link = intent.targetLinkId && world.supplyAssessment.maritimeLinks.find((item) => item.id === intent.targetLinkId);
    const targetRegion = intent.targetPortId ?? intent.targetCoastId;
    const opponent = link ? link.nationId : targetRegion && (world.occupation.mesoById.get(targetRegion) ?? owners.get(targetRegion));
    if (opponent !== campaign.primaryOpponentId) return intent;
    return { ...intent, priority: intent.priority + WORLD_BALANCE.unit.naval.strategy.switchingThreshold,
      reasonFlags: [...intent.reasonFlags, "campaign-primary"] };
  }).sort((a, b) => b.priority - a.priority);
}
