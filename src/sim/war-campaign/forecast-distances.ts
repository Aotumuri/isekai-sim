import type { NationId } from "../../worldgen/nation";
import type { MesoRegionId } from "../../worldgen/meso-region";
import type { WorldState } from "../world-state";
import { getMesoById, getOwnerByMesoId } from "../world-cache";
import type { CampaignObjective, WarCampaign } from "./state";

interface DistanceField { targets: string; distances: ReadonlyMap<MesoRegionId, number> }
interface CampaignDistanceCache {
  mapVersion: number;
  territoryVersion: number;
  fields: Map<string, DistanceField>;
}
const caches = new WeakMap<WorldState, CampaignDistanceCache>();
const goalKey = (nationId: NationId, warKey: string) => JSON.stringify([nationId, warKey]);

/** This projection uses legal ownership, not occupation or unit positions.
 * Those changing observations still enter the forecast separately every tick. */
export function getCampaignObjectiveDistances(world: WorldState, nationId: NationId, goal: CampaignObjective): ReadonlyMap<MesoRegionId, number> {
  let cache = caches.get(world);
  if (!cache || cache.mapVersion !== world.mapVersion || cache.territoryVersion !== world.territoryVersion) {
    cache = { mapVersion: world.mapVersion, territoryVersion: world.territoryVersion, fields: new Map() };
    caches.set(world, cache);
  }
  const key = goalKey(nationId, goal.warKey);
  const targets = JSON.stringify([goal.opponentId, goal.regionIds]);
  const existing = cache.fields.get(key);
  if (existing?.targets === targets) return existing.distances;
  const distances = buildObjectiveDistances(world, nationId, goal.opponentId, goal.regionIds);
  cache.fields.set(key, { targets, distances });
  return distances;
}

export function clearCampaignDistanceFields(world: WorldState): void { caches.delete(world); }

/** Keep at most one field per active national war goal; ending wars or nations
 * cannot leave an ever-growing history of path maps. */
export function pruneCampaignDistanceFields(world: WorldState, campaigns: Iterable<Pick<WarCampaign, "nationId" | "objectives">>): void {
  const cache = caches.get(world);
  if (!cache) return;
  const active = new Set([...campaigns].flatMap((campaign) =>
    campaign.objectives.map((goal) => goalKey(campaign.nationId, goal.warKey))));
  for (const key of cache.fields.keys()) if (!active.has(key)) cache.fields.delete(key);
  if (!cache.fields.size) caches.delete(world);
}

function buildObjectiveDistances(world: WorldState, nation: NationId, opponent: NationId, targets: MesoRegionId[]) {
  const owners = getOwnerByMesoId(world), regions = getMesoById(world);
  const distance = new Map(targets.map((id) => [id, 0]));
  const queue = [...targets];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    for (const next of regions.get(id)?.neighbors ?? []) {
      if (regions.get(next.id)?.type === "sea" || distance.has(next.id) ||
        owners.get(next.id) !== nation && owners.get(next.id) !== opponent) continue;
      distance.set(next.id, distance.get(id)! + 1); queue.push(next.id);
    }
  }
  return distance;
}
