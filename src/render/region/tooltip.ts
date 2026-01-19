import type { MacroRegion } from "../../worldgen/macro-region";
import type { MesoRegion } from "../../worldgen/meso-region";
import type { MicroRegion } from "../../worldgen/micro-region";
import type { Nation } from "../../worldgen/nation";

export function formatRegionTooltip(
  region: MicroRegion,
  meso: MesoRegion | null,
  macro: MacroRegion | null,
  nation: Nation | null,
): string {
  const terrain = region.isSea ? "Sea" : region.isRiver ? "River" : "Land";
  const elevation = region.elevation.toFixed(3);
  const mesoInfo = meso
    ? `Meso: ${meso.id} (${meso.type}, ${meso.microRegionIds.length})`
    : "Meso: -";
  const buildingInfo = meso?.building
    ? `Building: ${formatBuilding(meso.building)}`
    : "Building: -";
  const macroInfo = macro ? `Macro: ${macro.id} (${macro.isCore ? "Core" : "Remote"})` : "Macro: -";
  const nationInfo = nation ? `Nation: ${nation.id}` : "Nation: -";

  return [
    `Micro: ${region.id}`,
    `Type: ${terrain}`,
    `Elevation: ${elevation}`,
    mesoInfo,
    buildingInfo,
    macroInfo,
    nationInfo,
  ].join("\n");
}

function formatBuilding(building: MesoRegion["building"]): string {
  switch (building) {
    case "capital":
      return "Capital";
    case "city":
      return "City";
    case "port":
      return "Port";
    default:
      return "-";
  }
}
