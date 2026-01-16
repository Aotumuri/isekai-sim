import type { MicroRegion } from "./micro-region";
import { createMicroRegionEdgeKey, type MicroRegionEdge } from "./micro-region-edge";

export function createMicroRegionEdges(microRegions: MicroRegion[]): MicroRegionEdge[] {
  const edges: MicroRegionEdge[] = [];
  const seen = new Set<string>();

  for (const region of microRegions) {
    for (const neighborId of region.neighbors) {
      const key = createMicroRegionEdgeKey(region.id, neighborId);
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      edges.push({
        a: region.id,
        b: neighborId,
        hasRiver: false,
      });
    }
  }

  return edges;
}
