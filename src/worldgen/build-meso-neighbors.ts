import type { MicroRegion } from "./micro-region";
import type { MesoRegion, MesoRegionNeighbor } from "./meso-region";

export function buildMesoNeighbors(
  mesoRegions: MesoRegion[],
  microRegions: MicroRegion[],
  neighborsByIndex: number[][],
): Map<MesoRegion["id"], MesoRegionNeighbor[]> {
  const edgeMap = new Map<
    string,
    { a: MesoRegion["id"]; b: MesoRegion["id"]; hasRiver: boolean }
  >();
  for (let i = 0; i < microRegions.length; i += 1) {
    const region = microRegions[i];
    const regionMesoId = region.mesoRegionId;
    if (!regionMesoId) {
      continue;
    }

    for (const neighborIndex of neighborsByIndex[i]) {
      if (neighborIndex <= i) {
        continue;
      }

      const neighbor = microRegions[neighborIndex];
      const neighborMesoId = neighbor.mesoRegionId;
      if (!neighborMesoId || neighborMesoId === regionMesoId) {
        continue;
      }

      const key =
        regionMesoId < neighborMesoId
          ? `${regionMesoId}|${neighborMesoId}`
          : `${neighborMesoId}|${regionMesoId}`;
      const hasRiver = region.isRiver || neighbor.isRiver;
      const existing = edgeMap.get(key);
      if (existing) {
        existing.hasRiver ||= hasRiver;
      } else {
        edgeMap.set(key, {
          a: regionMesoId < neighborMesoId ? regionMesoId : neighborMesoId,
          b: regionMesoId < neighborMesoId ? neighborMesoId : regionMesoId,
          hasRiver,
        });
      }
    }
  }

  const neighborsById = new Map<MesoRegion["id"], MesoRegionNeighbor[]>();
  for (const region of mesoRegions) {
    neighborsById.set(region.id, []);
  }

  for (const edge of edgeMap.values()) {
    neighborsById.get(edge.a)?.push({ id: edge.b, hasRiver: edge.hasRiver });
    neighborsById.get(edge.b)?.push({ id: edge.a, hasRiver: edge.hasRiver });
  }

  for (const neighbors of neighborsById.values()) {
    neighbors.sort((a, b) => a.id.localeCompare(b.id));
  }

  return neighborsById;
}
