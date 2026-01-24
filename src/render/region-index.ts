import type { MicroRegion } from "../worldgen/micro-region";
import type { MesoRegion } from "../worldgen/meso-region";

const microRegionByIdCache = new WeakMap<
  MicroRegion[],
  Map<MicroRegion["id"], MicroRegion>
>();
const mesoRegionByIdCache = new WeakMap<
  MesoRegion[],
  Map<MesoRegion["id"], MesoRegion>
>();

export function getMicroRegionByIdMap(
  microRegions: MicroRegion[],
): Map<MicroRegion["id"], MicroRegion> {
  const cached = microRegionByIdCache.get(microRegions);
  if (cached && cached.size === microRegions.length) {
    return cached;
  }

  const map = new Map<MicroRegion["id"], MicroRegion>();
  for (const region of microRegions) {
    map.set(region.id, region);
  }
  microRegionByIdCache.set(microRegions, map);
  return map;
}

export function getMesoRegionByIdMap(
  mesoRegions: MesoRegion[],
): Map<MesoRegion["id"], MesoRegion> {
  const cached = mesoRegionByIdCache.get(mesoRegions);
  if (cached && cached.size === mesoRegions.length) {
    return cached;
  }

  const map = new Map<MesoRegion["id"], MesoRegion>();
  for (const region of mesoRegions) {
    map.set(region.id, region);
  }
  mesoRegionByIdCache.set(mesoRegions, map);
  return map;
}
