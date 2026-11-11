import type { MesoRegionId } from "../worldgen/meso-region";
import { getWarCampaign } from "./war-campaign/state";
import type { NationId } from "../worldgen/nation";
import { warFatigueKey } from "./diplomatic-peace";
import { getWarDeclarationMode } from "./simulation-settings";
import { findWar } from "./war-state";
import type { WorldState } from "./world-state";

export function getCampaignObjectives(world: WorldState, nation: NationId, opponent: NationId): readonly MesoRegionId[] {
  const campaign = getWarCampaign(world, nation);
  if (campaign) return campaign.objectives.find((goal) => goal.opponentId === opponent)?.regionIds ?? [];
  if (getWarDeclarationMode(world) !== "diplomacy") return [];
  const war = findWar(world.wars, nation, opponent);
  if (!war || war.isTest) return [];
  return world.warNegotiations?.active.get(warFatigueKey(war))?.offers.get(nation)?.terms.demandedRegionIds ?? [];
}
