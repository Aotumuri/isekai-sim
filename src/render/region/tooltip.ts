import { EQUIPMENT_CATALOG } from "../../data/equipment-catalog";
import type { UnitState } from "../../sim/unit";
import type { MacroRegion } from "../../worldgen/macro-region";
import type { MesoRegion } from "../../worldgen/meso-region";
import type { MicroRegion } from "../../worldgen/micro-region";
import type { Nation } from "../../worldgen/nation";

export function formatRegionTooltip(
  region: MicroRegion,
  meso: MesoRegion | null,
  macro: MacroRegion | null,
  nation: Nation | null,
  units: UnitState[],
): string {
  const terrain = region.isSea ? "Sea" : region.isRiver ? "River" : "Land";
  const elevation = region.elevation.toFixed(3);

  const lines: string[] = [
    `Micro: ${region.id}`,
    `Type: ${terrain}`,
    `Elevation: ${elevation}`,
  ];

  if (meso) {
    lines.push(`Meso: ${meso.id} (${meso.type}, micro ${meso.microRegionIds.length})`);
    lines.push(`Meso Center: ${formatVec2(meso.center)}`);
    lines.push(formatMesoNeighborSummary(meso));
    const neighborList = formatMesoNeighborList(meso);
    if (neighborList) {
      lines.push(neighborList);
    }
    lines.push(
      meso.building ? `Building: ${formatBuilding(meso.building)}` : "Building: -",
    );
  } else {
    lines.push("Meso: -");
    lines.push("Meso Center: -");
    lines.push("Meso Neighbors: -");
    lines.push("Building: -");
  }

  lines.push(macro ? `Macro: ${macro.id} (${macro.isCore ? "Core" : "Remote"})` : "Macro: -");
  lines.push(nation ? `Nation: ${nation.id}` : "Nation: -");
  lines.push(...formatUnitLines(units));

  return lines.join("\n");
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

const MAX_NEIGHBOR_LIST = 6;
const MAX_UNIT_LIST = 6;
const MAX_EQUIPMENT_LIST = 4;

function formatMesoNeighborSummary(meso: MesoRegion): string {
  const riverCount = meso.neighbors.reduce((count, neighbor) => {
    return count + (neighbor.hasRiver ? 1 : 0);
  }, 0);
  return `Meso Neighbors: ${meso.neighbors.length} (river ${riverCount})`;
}

function formatMesoNeighborList(meso: MesoRegion): string | null {
  if (meso.neighbors.length === 0) {
    return null;
  }

  const shown = meso.neighbors.slice(0, MAX_NEIGHBOR_LIST).map((neighbor) => {
    return neighbor.hasRiver ? `${neighbor.id}~R` : neighbor.id;
  });
  const remaining = meso.neighbors.length - shown.length;
  const suffix = remaining > 0 ? `, +${remaining}` : "";
  return `Meso Links: ${shown.join(", ")}${suffix}`;
}

function formatVec2(pos: MesoRegion["center"]): string {
  return `${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}`;
}

function formatUnitLines(units: UnitState[]): string[] {
  if (units.length === 0) {
    return ["Units: 0"];
  }

  const lines: string[] = [`Units: ${units.length}`];
  const shown = units.slice(0, MAX_UNIT_LIST);
  for (const unit of shown) {
    const orgPercent = Math.round(unit.org * 100);
    lines.push(
      `Unit: ${unit.nationId} ${unit.type} (MP ${unit.manpower}, Org ${orgPercent}%)`,
    );
    const equipment = formatUnitEquipment(unit);
    if (equipment) {
      lines.push(`Eq: ${equipment}`);
    }
  }

  const remaining = units.length - shown.length;
  if (remaining > 0) {
    lines.push(`Units: +${remaining} more`);
  }

  return lines;
}

function formatUnitEquipment(unit: UnitState): string | null {
  if (unit.equipment.length === 0) {
    return null;
  }

  const shown = unit.equipment.slice(0, MAX_EQUIPMENT_LIST).map((slot) => {
    const name = EQUIPMENT_CATALOG[slot.equipmentKey]?.name ?? slot.equipmentKey;
    const fillPercent = Math.round(slot.fill * 100);
    return `${name} ${fillPercent}%`;
  });
  const remaining = unit.equipment.length - shown.length;
  const suffix = remaining > 0 ? `, +${remaining}` : "";
  return `${shown.join(", ")}${suffix}`;
}
