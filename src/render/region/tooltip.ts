import { UNIT_LABELS } from "../japanese-labels";
import { isStrategicResource, STRATEGIC_RESOURCE_NAMES } from "../../data/strategic-resources";
import { formatPopulationDistrict, isPopulationMode } from "../population-map";
import { getUnitTransportCapacity } from "../../sim/unit-capabilities";
import { getMapClaims } from "../claim-map-data";
import { getOwnerByMesoId } from "../../sim/world-cache";
import { getNationName, getNationIdeology } from "../../sim/nation-identity";
import { getNationFaction } from "../../sim/factions";
import { formatCoastalSupportStatus, formatNavalUnitStatus } from "../naval-status";
import type { WorldState } from "../../sim/world-state";
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
  world?: WorldState,
): string {
  if (world?.mapView && world.mapView.mode !== "debug") {
    const lines = nation ? [getNationName(world, nation.id), getNationIdeology(world, nation.id).name,
      `陣営： ${getNationFaction(world, nation.id)?.name ?? "無所属"}`] : [region.isSea ? "外洋" : "未領有地"];
    if (meso) {
      if (isPopulationMode(world.mapView.mode)) lines.push(...formatPopulationDistrict(world, meso.id, world.mapView.mode));
      if (world.mapView.farmland) {
        const land = world.agriculturalLand?.get(meso.id);
        if (land) lines.push(`耕作可能地 ${Math.round(land.arableShare * 100)}% · 予想収穫 ${land.harvest.toFixed(2)}／10秒`);
      }
      lines.push(`地区 ${meso.id.replace("meso-", "")}`);
      const owner = getOwnerByMesoId(world).get(meso.id), occupier = world.occupation.mesoById.get(meso.id);
      if (world.mapView.mode === "claims" && world.mapView.selectedNationId && meso.type !== "sea") {
        const focus = world.mapView.selectedNationId;
        const claim = getMapClaims(world, focus).find((item) => item.regionId === meso.id);
        lines.push(`請求国： ${getNationName(world, focus)}`);
        if (owner === focus) lines.push("自国領");
        else if (claim) {
          lines.push(`請求の強さ： ${Math.round(claim.strength)} / 100`);
          if (claim.heldTicks > 0) lines.push(`過去の領有期間： ${claim.heldTicks}秒`);
          if (meso.resource) lines.push("資源への関心");
          if (claim.demanded) lines.push("発出中の領土最後通牒");
        } else lines.push("No territorial claim");
      }
      if (owner && occupier && owner !== occupier) lines.push(`領有国： ${getNationName(world, owner)}`, `占領国： ${getNationName(world, occupier)}`);
    }
    if (meso?.building) lines.push(`施設： ${formatBuilding(meso.building)}`);
    if (meso?.resource) lines.push(`資源： ${formatResource(meso.resource)}`);
    if (meso) lines.push(...formatCoastalSupportStatus(world, meso.id));
    lines.push(...formatUnitLines(units, world));
    return lines.join("\n");
  }
  const terrain = region.isSea ? "Sea" : region.isRiver ? "River" : "Land";
  const elevation = region.elevation.toFixed(3);

  const lines: string[] = [
    `小区画： ${region.id}`,
    `地形： ${terrain}`,
    `標高： ${elevation}`,
  ];

  if (meso) {
    lines.push(`地区： ${meso.id} (${meso.type}, micro ${meso.microRegionIds.length})`);
    lines.push(`地区中心： ${formatVec2(meso.center)}`);
    lines.push(formatMesoNeighborSummary(meso));
    const neighborList = formatMesoNeighborList(meso);
    if (neighborList) {
      lines.push(neighborList);
    }
    lines.push(
      meso.building ? `施設： ${formatBuilding(meso.building)}` : "施設： -",
    );
    lines.push(
      meso.resource ? `資源： ${formatResource(meso.resource)}` : "資源： -",
    );
  } else {
    lines.push("地区： -");
    lines.push("地区中心： -");
    lines.push("隣接地区： -");
    lines.push("施設： -");
    lines.push("資源： -");
  }

  lines.push(macro ? `州： ${macro.id} (${macro.isCore ? "中核" : "遠隔地"})` : "州： -");
  lines.push(nation ? `国： ${nation.id}` : "国： -");
  if (meso && world) lines.push(...formatCoastalSupportStatus(world, meso.id));
  lines.push(...formatUnitLines(units, world));

  return lines.join("\n");
}

function formatBuilding(building: MesoRegion["building"]): string {
  switch (building) {
    case "capital":
      return "首都";
    case "city":
      return "都市";
    case "port":
      return "港";
    default:
      return "-";
  }
}

function formatResource(resource: MesoRegion["resource"]): string {
  if (isStrategicResource(resource)) return STRATEGIC_RESOURCE_NAMES[resource];
  switch (resource) {
    case "steel":
      return "鋼材";
    case "fuel":
      return "燃料";
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
  return `隣接地区： ${meso.neighbors.length} (river ${riverCount})`;
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
  return `地区の接続： ${shown.join(", ")}${suffix}`;
}

function formatVec2(pos: MesoRegion["center"]): string {
  return `${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}`;
}

function formatUnitLines(units: UnitState[], world?: WorldState): string[] {
  if (units.length === 0) {
    return ["部隊： 0"];
  }

  const lines: string[] = [`部隊： ${units.length}`];
  const shown = units.slice(0, MAX_UNIT_LIST);
  for (const unit of shown) {
    const orgPercent = Math.round(unit.org * 100);
    lines.push(
      `部隊： ${world?.mapView?.mode && world.mapView.mode !== "debug" ? getNationName(world, unit.nationId) : unit.nationId} ${UNIT_LABELS[unit.type]}（兵力 ${unit.manpower}、組織率 ${orgPercent}%)`,
    );
    const experience = Math.floor(unit.combatExperience ?? 0);
    if (experience > 0) lines.push(`戦闘経験： ${experience} / 100`);
    if (world && unit.exileOriginId) lines.push(`亡命軍の所属： ${getNationName(world, unit.exileOriginId)}`);
    if (unit.design && unit.design.generation > 0) lines.push(
      `設計： ${unit.design.manufacturerId}／世代 ${unit.design.generation}／火力×${unit.design.firepower.toFixed(2)}／信頼性×${unit.design.reliability.toFixed(2)}`,
    );
    if (unit.design && unit.design.generation > 0) lines.push(`防御×${(unit.design.armor ?? 1).toFixed(2)}／速度×${(unit.design.mobility ?? 1).toFixed(2)}${unit.type === "Infantry" ? `／取り回し×${(unit.design.handling ?? 1).toFixed(2)}` : ""}`);
    if (unit.type === "TransportShip") lines.push(`積載： ${unit.cargoUnits.length} / ${getUnitTransportCapacity(unit)}部隊`);
    const navalStatus = world ? formatNavalUnitStatus(world, unit) : null;
    if (navalStatus) lines.push(navalStatus);
    if (world && unit.volunteerOriginId) lines.push(`義勇軍の出身国： ${getNationName(world, unit.volunteerOriginId)}`);
    const equipment = formatUnitEquipment(unit);
    if (equipment) {
      lines.push(`装備： ${equipment}`);
    }
  }

  const remaining = units.length - shown.length;
  if (remaining > 0) {
    lines.push(`部隊： +${remaining}部隊ほか`);
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
