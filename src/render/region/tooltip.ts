import type { MesoRegion } from "../../worldgen/meso-region";
import type { MicroRegion } from "../../worldgen/micro-region";

export function formatRegionTooltip(region: MicroRegion, meso: MesoRegion | null): string {
  const terrain = region.isSea ? "Sea" : region.isRiver ? "River" : "Land";
  const elevation = region.elevation.toFixed(3);
  const mesoInfo = meso
    ? `Meso: ${meso.id} (${meso.type}, ${meso.microRegionIds.length})`
    : "Meso: -";

  return [
    `Micro: ${region.id}`,
    `Type: ${terrain}`,
    `Elevation: ${elevation}`,
    mesoInfo,
  ].join("\n");
}
