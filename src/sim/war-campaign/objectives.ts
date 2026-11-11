import type { NationId } from "../../worldgen/nation";
import type { WorldState } from "../world-state";
import type { WarState } from "../war-state";
import { getOwnerByMesoId } from "../world-cache";
import { campaignWarKey, type CampaignObjective, type WarCampaign } from "./state";
import { assessCampaignOpening } from "./opening-intent";
import { buildPoliticalObjective } from "./political-objectives";

export function buildCampaignObjectives(
  world: WorldState, nationId: NationId, wars: WarState[],
  strength: number, previous: WarCampaign | undefined,
): CampaignObjective[] {
  const owners = getOwnerByMesoId(world);
  return wars.map((war) => {
    const opponentId = war.nationAId === nationId ? war.nationBId : war.nationAId;
    const warKey = campaignWarKey(war.nationAId, war.nationBId, war.startedAtFastTick);
    const old = previous?.objectives.find((goal) => goal.warKey === warKey);
    const offensivePurpose = war.aggressorId === nationId;
    // Compute once; neither opening intent nor a live negotiating offer may
    // replace an adopted objective after the campaign has started.
    const opening = !old && offensivePurpose
      ? war.campaignIntent ?? assessCampaignOpening(world, nationId, opponentId, war.ultimatumRegionIds)
      : undefined;
    const kind = old?.kind ?? (offensivePurpose && opening?.objectiveRegionIds.length
      ? "limited-occupation" : "preserve-sovereignty");
    const regionIds = old?.regionIds ?? (kind === "limited-occupation"
      ? [...(opening?.objectiveRegionIds ?? [])]
      : world.mesoRegions.filter((region) => owners.get(region.id) === nationId).map((region) => region.id));
    const achieved = regionIds.length > 0 && regionIds.every((id) =>
      (world.occupation.mesoById.get(id) ?? owners.get(id)) === nationId);
    return { warKey, opponentId, kind: old?.kind ?? kind, regionIds,
      rationale: old?.rationale ?? (opening?.rationale === "no-access" ? "no-access-defense" : opening?.rationale) ?? "preserve-sovereignty",
      openingStrength: old?.openingStrength ?? strength, achieved,
      political: old?.political ?? buildPoliticalObjective(world, nationId, opponentId, regionIds, kind === "limited-occupation") };
  });
}
