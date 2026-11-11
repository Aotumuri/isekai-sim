import type { NationId } from "../../worldgen/nation";
import type { WorldState } from "../world-state";
import type { WarState } from "../war-state";
import { getOwnerByMesoId } from "../world-cache";
import { campaignWarKey, type CampaignObjective, type WarCampaign } from "./state";

export function buildCampaignObjectives(
  world: WorldState, nationId: NationId, wars: WarState[],
  strength: number, previous: WarCampaign | undefined,
): CampaignObjective[] {
  const owners = getOwnerByMesoId(world);
  return wars.map((war) => {
    const opponentId = war.nationAId === nationId ? war.nationBId : war.nationAId;
    const warKey = campaignWarKey(war.nationAId, war.nationBId, war.startedAtFastTick);
    const old = previous?.objectives.find((goal) => goal.warKey === warKey);
    const kind = war.aggressorId === nationId ? "limited-occupation" : "preserve-sovereignty";
    // Snapshot an opening objective, never the current negotiating demand.
    const target = world.landFronts.operationalSectors
      .filter((front) => [front.nationAId, front.nationBId].includes(nationId) &&
        [front.nationAId, front.nationBId].includes(opponentId))
      .flatMap((front) => (front.nationAId === opponentId ? front.sideA : front.sideB).borderRegionIds)
      .filter((id) => owners.get(id) === opponentId).sort()[0];
    const regionIds = old?.regionIds ?? (kind === "limited-occupation"
      ? [...(war.ultimatumRegionIds?.length ? war.ultimatumRegionIds : target ? [target] : [world.nations.find((item) => item.id === opponentId)!.capitalMesoId])]
      : world.mesoRegions.filter((region) => owners.get(region.id) === nationId).map((region) => region.id));
    const achieved = regionIds.length > 0 && regionIds.every((id) =>
      (world.occupation.mesoById.get(id) ?? owners.get(id)) === nationId);
    return { warKey, opponentId, kind: old?.kind ?? kind, regionIds,
      openingStrength: old?.openingStrength ?? strength, achieved };
  });
}
