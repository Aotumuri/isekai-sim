import type { NationId } from "../../worldgen/nation";
import type { MesoRegionId } from "../../worldgen/meso-region";
import type { WorldState } from "../world-state";
import { getOwnerByMesoId, getPortTargetsByNation } from "../world-cache";
import { getTerritorialValue } from "../territorial-value";
import { getCachedMaritimeRoute } from "../maritime-supply";
import { getUnitCombatStrength } from "../unit-strength";
import { foodReserveSeconds } from "../food-supply";

export interface CampaignOpeningIntent {
  objectiveRegionIds: MesoRegionId[];
  rationale: "declared-territory" | "border-value" | "maritime-foothold" | "no-access";
  feasible: boolean;
  foodSeconds: number;
  estimatedOpposition: number;
}

/** Same opening assessment is used before escalation and when adopting a war.
 * It compares value against local opposition and access, not whole enemy size. */
export function assessCampaignOpening(
  world: WorldState, nationId: NationId, opponentId: NationId,
  requested: readonly MesoRegionId[] = [],
): CampaignOpeningIntent {
  const owners = getOwnerByMesoId(world);
  const nation = world.nations.find((item) => item.id === nationId);
  const foodSeconds = nation?.food ? foodReserveSeconds(nation.food) : Infinity;
  const declared = requested.filter((id) => owners.get(id) === opponentId);
  const borders = world.mesoRegions.filter((region) => region.type !== "sea" && owners.get(region.id) === opponentId &&
    region.neighbors.some((neighbor) => owners.get(neighbor.id) === nationId));
  const routeLengths = new Map<MesoRegionId, number>();
  if (!borders.length) {
    const ports = getPortTargetsByNation(world);
    for (const destination of ports.get(opponentId) ?? []) {
      for (const departure of ports.get(nationId) ?? []) {
        const route = getCachedMaritimeRoute(world, world.supplyAssessment.maritimeConnectivity, departure, destination);
        if (route) routeLengths.set(destination, Math.min(routeLengths.get(destination) ?? Infinity, route.length));
      }
    }
  }
  const candidates = borders.length ? borders : world.mesoRegions.filter((region) => routeLengths.has(region.id));
  const defenders = world.units.filter((unit) => unit.domain === "land" && unit.nationId === opponentId);
  const friendlyStrength = world.units.filter((unit) => unit.domain === "land" && unit.nationId === nationId)
    .reduce((sum, unit) => sum + getUnitCombatStrength(unit), 0);
  const ranked = candidates.map((region) => {
    const area = new Set([region.id, ...region.neighbors.map((neighbor) => neighbor.id)]);
    const opposition = defenders.filter((unit) => area.has(unit.regionId)).reduce((sum, unit) => sum + getUnitCombatStrength(unit), 0);
    const score = getTerritorialValue(world, nationId, [region.id]) /
      ((routeLengths.get(region.id) ?? 1) * (1 + opposition / Math.max(1, friendlyStrength)));
    return { id: region.id, score, opposition };
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return {
    objectiveRegionIds: declared.length ? [...declared] : ranked[0] ? [ranked[0].id] : [],
    rationale: declared.length ? "declared-territory" : !ranked.length ? "no-access" : borders.length ? "border-value" : "maritime-foothold",
    feasible: candidates.length > 0 && foodSeconds >= 45,
    foodSeconds, estimatedOpposition: ranked[0]?.opposition ?? 0,
  };
}
