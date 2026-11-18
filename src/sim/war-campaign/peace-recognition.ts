import type { NationId } from "../../worldgen/nation";
import type { MesoRegionId } from "../../worldgen/meso-region";
import type { PeaceTerms } from "../war-negotiations";
import type { WorldState } from "../world-state";
import { selectPeaceDistricts } from "../peace-borders";
import { getOwnerByMesoId } from "../world-cache";
import { getWarCampaign } from "./state";
import { campaignCostLimitReached } from "./policy";

/** Request only occupied military goals that existing border rules can cede.
 * A foothold on another country's island is NOT automatically annexable. */
export function campaignRecognitionRegions(world: WorldState, nationId: NationId, opponentId: NationId): MesoRegionId[] {
  const campaign = getWarCampaign(world, nationId);
  const goal = campaign?.objectives.find((item) => item.opponentId === opponentId && item.kind === "limited-occupation");
  if (!goal) return [];
  const owners = getOwnerByMesoId(world);
  const occupied = goal.regionIds.filter((id) => owners.get(id) === opponentId &&
    world.occupation.mesoById.get(id) === nationId);
  return selectPeaceDistricts(world, opponentId, nationId, occupied, occupied.length);
}

export function campaignCanHoldRecognition(world: WorldState, nationId: NationId): boolean {
  const campaign = getWarCampaign(world, nationId);
  return !!campaign && campaign.mode === "consolidate" && !campaignCostLimitReached(campaign.constraints);
}

export function campaignRecognitionWeapons(world: WorldState, nationId: NationId, opponentId: NationId): number {
  const goal = getWarCampaign(world, nationId)?.objectives.find((item) => item.opponentId === opponentId);
  if (!goal?.achieved || goal.political?.purpose !== "coercive-settlement") return 0;
  const stock = world.nations.find((nation) => nation.id === opponentId)?.resources.weapons ?? 0;
  return stock >= goal.political.weaponTarget ? goal.political.weaponTarget : 0;
}

/** The recipient evaluates the same transfer and payment in reverse. */
export function reciprocalRecognitionTerms(terms: PeaceTerms): PeaceTerms {
  return { ...terms, demandedRegionIds: terms.offeredRegionIds, offeredRegionIds: terms.demandedRegionIds,
    demandedWeapons: terms.offeredWeapons, offeredWeapons: terms.demandedWeapons };
}
