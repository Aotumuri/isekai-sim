import type { MesoRegionId } from "../worldgen/meso-region";
import type { WorldState } from "./world-state";
import { getMesoById, getNeighborsById } from "./world-cache";

/** Deterministic port/sea positioning path shared by logistics and escort missions. */
export function buildNavalPositioningRoute(
  world: WorldState,
  startId: MesoRegionId,
  targetRouteIds: readonly MesoRegionId[],
  seaTargetsOnly = false,
): MesoRegionId[] {
  const mesoById = getMesoById(world);
  const targets = new Set(seaTargetsOnly
    ? targetRouteIds.filter((id) => mesoById.get(id)?.type === "sea")
    : targetRouteIds);
  const neighborsById = getNeighborsById(world);
  const queue = [startId];
  const previous = new Map<MesoRegionId, MesoRegionId | null>([[startId, null]]);
  let found: MesoRegionId | null = targets.has(startId) ? startId : null;
  for (let index = 0; index < queue.length && !found; index += 1) {
    const current = queue[index];
    for (const neighbor of [...(neighborsById.get(current) ?? [])].sort(compareIds)) {
      if (previous.has(neighbor)) continue;
      const region = mesoById.get(neighbor);
      if (!region || (region.type !== "sea" && region.building !== "port")) continue;
      previous.set(neighbor, current);
      queue.push(neighbor);
      if (targets.has(neighbor)) {
        found = neighbor;
        break;
      }
    }
  }
  const path: MesoRegionId[] = [];
  for (let current = found; current; current = previous.get(current) ?? null) path.push(current);
  path.reverse();
  return path;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
