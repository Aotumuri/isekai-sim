import type { NationId } from "../../worldgen/nation";
import type { MesoRegionId } from "../../worldgen/meso-region";
import type { WorldState } from "../world-state";
import { getMesoById, getOwnerByMesoId } from "../world-cache";
import type { CampaignObjective } from "./state";

interface DistanceField {
  nation: NationId;
  opponent: NationId;
  generation: number;
  targets: string;
  distances: ReadonlyMap<MesoRegionId, number>;
}
interface CampaignDistanceCache {
  mapVersion: number;
  territoryVersion: number;
  generation: number;
  fields: Map<readonly MesoRegionId[], DistanceField>;
}
const caches = new WeakMap<WorldState, CampaignDistanceCache>();

export function beginCampaignDistancePass(world: WorldState): void {
  const cache = caches.get(world);
  if (cache) cache.generation++;
}

/** This projection uses legal ownership, not occupation or unit positions.
 * Those changing observations still enter the forecast separately every tick. */
export function getCampaignObjectiveDistances(world: WorldState, nationId: NationId, goal: CampaignObjective): ReadonlyMap<MesoRegionId, number> {
  let cache = caches.get(world);
  if (!cache || cache.mapVersion !== world.mapVersion || cache.territoryVersion !== world.territoryVersion) {
    cache = { mapVersion: world.mapVersion, territoryVersion: world.territoryVersion, generation: 1, fields: new Map() };
    caches.set(world, cache);
  }
  // Adoption normally reuses this array. The snapshot also catches in-place
  // edits made by callers, independently of the array's identity.
  const targets = JSON.stringify(goal.regionIds);
  const existing = cache.fields.get(goal.regionIds);
  if (existing?.nation === nationId && existing.opponent === goal.opponentId && existing.targets === targets) {
    existing.generation = cache.generation;
    return existing.distances;
  }
  const distances = buildObjectiveDistances(world, nationId, goal.opponentId, goal.regionIds);
  cache.fields.set(goal.regionIds, { nation: nationId, opponent: goal.opponentId, generation: cache.generation, targets, distances });
  return distances;
}

export function clearCampaignDistanceFields(world: WorldState): void { caches.delete(world); }

/** Keep at most one field per active national war goal; ending wars or nations
 * cannot leave an ever-growing history of path maps. */
export function pruneCampaignDistanceFields(world: WorldState): void {
  const cache = caches.get(world);
  if (!cache) return;
  for (const [key, field] of cache.fields) if (field.generation !== cache.generation) cache.fields.delete(key);
  if (!cache.fields.size) caches.delete(world);
}

function buildObjectiveDistances(world: WorldState, nation: NationId, opponent: NationId, targets: readonly MesoRegionId[]) {
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
