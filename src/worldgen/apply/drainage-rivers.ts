import type { WorldConfig } from "../../data/world-config";
import type { MicroRegion } from "../micro-region";
import type { MicroRegionEdge } from "../micro-region-edge";

const ELEVATION_STEPS = 4096;

export function applyDrainageRivers(
  regions: MicroRegion[],
  edges: MicroRegionEdge[],
  config: WorldConfig,
): void {
  for (const region of regions) region.isRiver = false;
  for (const edge of edges) edge.hasRiver = false;
  if (config.riverSourceCount <= 0) return;

  const indexById = new Map(regions.map((region, index) => [region.id, index]));
  const { downstream, order } = routeToSea(regions, indexById, config);
  const landCount = order.reduce((count, index) => count + Number(!regions[index].isSea), 0);
  const threshold = Math.max(3, Math.ceil(landCount / (config.riverSourceCount * 36)));
  const runoff = new Float64Array(regions.length);

  for (let i = order.length - 1; i >= 0; i -= 1) {
    const index = order[i];
    const region = regions[index];
    if (region.isSea) continue;
    const outlet = downstream[index];
    const rainfall = 0.65 + 0.55 * Math.sin(Math.PI * region.site.y / config.height);
    runoff[index] += rainfall;
    runoff[outlet] += runoff[index];
    region.isRiver = runoff[index] >= threshold;
  }
  for (const edge of edges) {
    const a = indexById.get(edge.a);
    const b = indexById.get(edge.b);
    if (a === undefined || b === undefined) continue;
    edge.hasRiver = (regions[a].isRiver && downstream[a] === b)
      || (regions[b].isRiver && downstream[b] === a);
  }
}

// Visit from the coast in spill-height order. A depression drains through the
// lowest reachable saddle. Within flats, each cell drains to an earlier visit.
function routeToSea(
  regions: MicroRegion[],
  indexById: ReadonlyMap<MicroRegion["id"], number>,
  config: WorldConfig,
): { downstream: Int32Array; order: number[] } {
  const buckets: number[][] = Array.from({ length: ELEVATION_STEPS + 1 }, () => []);
  const downstream = new Int32Array(regions.length).fill(-1);
  const order: number[] = [];
  for (let index = 0; index < regions.length; index += 1) {
    if (regions[index].isSea) buckets[0].push(index);
  }

  const range = config.elevationRange.max - config.elevationSeaLevel;
  for (let level = 0; level <= ELEVATION_STEPS; level += 1) {
    const bucket = buckets[level];
    for (let cursor = 0; cursor < bucket.length; cursor += 1) {
      const index = bucket[cursor];
      order.push(index);
      for (const id of regions[index].neighbors) {
        const neighbor = indexById.get(id);
        if (neighbor === undefined || regions[neighbor].isSea || downstream[neighbor] !== -1) continue;
        const height = (regions[neighbor].elevation - config.elevationSeaLevel) / range;
        const spill = Math.min(ELEVATION_STEPS, Math.max(level, Math.ceil(height * ELEVATION_STEPS)));
        downstream[neighbor] = index;
        buckets[spill].push(neighbor);
      }
    }
  }
  return { downstream, order };
}
