import type { NationRuntime } from "./nation-runtime";
import { getRelation, hasTreaty } from "./diplomacy";
import { areFactionPartners } from "./factions";
import type { MacroRegion, MacroRegionId } from "../worldgen/macro-region";
import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import type { WorldState } from "./world-state";
import { getMesoById, getOwnerByMesoId } from "./world-cache";
import { updateTerritorialClaims } from "./territorial-claims";
import { updateOccupation } from "./occupation";
import { findWar } from "./war-state";
import { recordSimulationEvent } from "./simulation-settings";
import { getSubjectOverlord } from "./subject-governments";

export interface TerritoryTransfer { from: NationId; to: NationId; regionIds: MesoRegionId[] }
function newProvinceId(world: WorldState): MacroRegionId {
  let index = world.macroRegions.length;
  while (world.macroRegions.some((item) => item.id === `macro-partition-${index}`)) index++;
  return `macro-partition-${index}` as MacroRegionId;
}
function partition(world: WorldState, macro: MacroRegion, ids: Set<MesoRegionId>, newOwner: NationId): void {
  const moved = macro.mesoRegionIds.filter((id) => ids.has(id));
  if (!moved.length) return;
  if (moved.length === macro.mesoRegionIds.length) { macro.nationId = newOwner; macro.isCore = false; return; }
  macro.mesoRegionIds = macro.mesoRegionIds.filter((id) => !ids.has(id));
  world.macroRegions.push({ id: newProvinceId(world), nationId: newOwner, mesoRegionIds: moved, isCore: false });
}
function refreshNationProvinces(world: WorldState): void {
  for (const nation of world.nations) nation.macroRegionIds = world.macroRegions.filter((macro) => macro.nationId === nation.id).map((macro) => macro.id);
}
export function splitProvince(world: WorldState, nationId: NationId, provinceId: MacroRegionId, regionIds: MesoRegionId[]): boolean {
  const macro = world.macroRegions.find((item) => item.id === provinceId && item.nationId === nationId);
  const ids = new Set(regionIds);
  if (!macro || !ids.size || ids.size !== regionIds.length || ids.size >= macro.mesoRegionIds.length ||
    [...ids].some((id) => !macro.mesoRegionIds.includes(id))) return false;
  // An administrative split must form one connected new province.
  const regions = getMesoById(world), visited = new Set<MesoRegionId>(), queue = [regionIds[0]];
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]; if (visited.has(id)) continue; visited.add(id);
    for (const neighbor of regions.get(id)?.neighbors ?? []) if (ids.has(neighbor.id) && !visited.has(neighbor.id)) queue.push(neighbor.id);
  }
  if (visited.size !== ids.size) return false;
  partition(world, macro, ids, nationId); refreshNationProvinces(world);
  world.mapVersion++; world.territoryVersion++;
  updateOccupation(world);
  recordSimulationEvent(world, { category: "diplomacy", nationIds: [nationId], message: `${nationId} divided a province (${ids.size} regions in the new province).` });
  return true;
}
export interface FoundingTransfer {
  nation: NationRuntime;
  occupationSponsor: NationId;
}

export function canTransferTerritories(world: WorldState, legs: TerritoryTransfer[], founding?: FoundingTransfer): boolean {
  return validateTerritoryTransfers(world, legs, founding);
}

function validateTerritoryTransfers(world: WorldState, legs: TerritoryTransfer[], founding?: FoundingTransfer, integrating?: NationId): boolean {
  if (!legs.length) return false;
  if (founding && (world.nations.some((nation) => nation.id === founding.nation.id) ||
    !legs.some((leg) => leg.to === founding.nation.id && leg.regionIds.includes(founding.nation.capitalMesoId)))) return false;
  const owners = getOwnerByMesoId(world), regions = getMesoById(world), used = new Set<MesoRegionId>();
  const remaining = new Map<NationId, number>();
  for (const owner of owners.values()) remaining.set(owner, (remaining.get(owner) ?? 0) + 1);
  for (const leg of legs) {
    const active = (id: NationId) => world.nations.some((nation) => nation.id === id && nation.macroRegionIds.length);
    if (leg.from === leg.to || !leg.regionIds.length || !active(leg.from) ||
      (!active(leg.to) && leg.to !== founding?.nation.id)) return false;
    for (const id of leg.regionIds) {
      const occupier = world.occupation.mesoById.get(id);
      if (used.has(id) || owners.get(id) !== leg.from || !regions.has(id) || regions.get(id)!.type === "sea" ||
        (occupier && occupier !== leg.from && occupier !== leg.to &&
          !(leg.to === founding?.nation.id && occupier === founding.occupationSponsor))) return false;
      used.add(id); remaining.set(leg.from, (remaining.get(leg.from) ?? 0) - 1); remaining.set(leg.to, (remaining.get(leg.to) ?? 0) + 1);
    }
  }
  return [...remaining].every(([id, count]) => id === integrating ? count === 0 : count > 0);
}

/** Both sides of a swap validate before any ownership, cost or military state changes. */
export function transferTerritories(world: WorldState, legs: TerritoryTransfer[], reason: "agreement" | "ultimatum" | "unilateral" | "integration" = "agreement", founding?: FoundingTransfer): boolean {
  const integration = reason === "integration" ? legs[0] : undefined;
  if (reason === "integration" && (!integration || founding || legs.length !== 1 ||
    getSubjectOverlord(world, integration.from) !== integration.to)) return false;
  if (!validateTerritoryTransfers(world, legs, founding, integration?.from)) return false;
  updateTerritorialClaims(world);
  if (founding) world.nations.push(founding.nation);
  const changed = new Set(legs.flatMap((leg) => leg.regionIds)), regions = getMesoById(world);
  for (const leg of legs) {
    const ids = new Set(leg.regionIds);
    for (const macro of [...world.macroRegions]) if (macro.nationId === leg.from) partition(world, macro, ids, leg.to);
  }
  refreshNationProvinces(world); world.mapVersion++; world.territoryVersion++;
  const owners = getOwnerByMesoId(world), involved = new Set(legs.flatMap((leg) => [leg.from, leg.to]));
  // Demote all ceded capitals before choosing replacements, including capital swaps.
  for (const nation of world.nations) if (owners.get(nation.capitalMesoId) !== nation.id) {
    const old = regions.get(nation.capitalMesoId);
    if (old?.building === "capital") old.building = "city";
  }
  for (const nation of world.nations) {
    if (!involved.has(nation.id)) continue;
    const owned = world.mesoRegions.filter((region) => owners.get(region.id) === nation.id && region.type !== "sea");
    if (!owned.length) continue;
    if (owners.get(nation.capitalMesoId) !== nation.id) {
      const replacement = owned.find((region) => region.building === "city") ?? owned[0];
      replacement.building = "capital"; nation.capitalMesoId = replacement.id;
    }
    if (nation === founding?.nation) {
      const capital = regions.get(nation.capitalMesoId)!;
      capital.building = "capital";
    }
    // A consensual cession is not a battlefield city loss.
    if (reason !== "unilateral") nation.initialCityCount = owned.filter((region) => region.building === "city" || region.building === "capital").length;
  }
  for (const id of changed) { world.occupation.mesoById.delete(id); world.occupation.dirtyMesoIds.add(id); }
  world.occupation.version++; world.buildingVersion++;
  for (const unit of world.units) {
    if (integration && unit.nationId === integration.from) {
      unit.nationId = integration.to;
      for (const cargo of unit.cargoUnits) if (cargo.nationId === integration.from) cargo.nationId = integration.to;
    }
    const wasOnTransferredLand = changed.has(unit.regionId);
    if (wasOnTransferredLand) {
      const owner = owners.get(unit.regionId);
      if (owner && owner !== unit.nationId && !findWar(world.wars, owner, unit.nationId)) {
        const home = world.nations.find((nation) => nation.id === unit.nationId);
        if (home && unit.domain === "land") unit.regionId = home.capitalMesoId;
        else if (unit.domain !== "land") {
          const origin = regions.get(unit.regionId)?.center;
          const sea = world.mesoRegions.filter((region) => region.type === "sea").sort((a, b) =>
            origin ? Math.hypot(a.center.x - origin.x, a.center.y - origin.y) - Math.hypot(b.center.x - origin.x, b.center.y - origin.y) : 0)[0];
          if (sea) unit.regionId = sea.id;
        }
      }
    }
    if (wasOnTransferredLand || (unit.moveToId && changed.has(unit.moveToId)) ||
      (unit.moveFromId && changed.has(unit.moveFromId)) || (unit.moveTargetId && changed.has(unit.moveTargetId))) {
      unit.moveTargetId = null; unit.moveFromId = null; unit.moveToId = null; unit.moveProgressMs = 0;
      for (const cargo of unit.cargoUnits) cargo.regionId = unit.regionId;
    }
  }
  world.battles = world.battles.filter((battle) => !changed.has(battle.mesoId));
  updateOccupation(world);
  updateTerritorialClaims(world, reason === "unilateral" ? new Set() : new Set(legs.map((leg) => leg.from)));
  recordSimulationEvent(world, { category: "diplomacy", nationIds: [...new Set(legs.flatMap((leg) => [leg.from, leg.to]))],
    message: `Territorial ${reason}: ${legs.map((leg) => `${leg.from} ceded ${leg.regionIds.length} regions to ${leg.to}`).join("; ")}.` });
  return true;
}

/** Liberation is restricted to the recorded homeland actually held by the recognized host. */
export function restoreExiledTerritories(world: WorldState, nationId: NationId, liberatorId: NationId, regionIds: MesoRegionId[]): boolean {
  const exile = world.exileGovernments?.byNationId.get(nationId);
  if (!exile || exile.status === "dissolved" || exile.hostId !== liberatorId || !regionIds.length || new Set(regionIds).size !== regionIds.length) return false;
  const relation = getRelation(world, nationId, liberatorId);
  if (findWar(world.wars, nationId, liberatorId) || relation.trust < 60 || relation.opinion < 35 ||
    (!areFactionPartners(world, nationId, liberatorId) && !hasTreaty(world, nationId, liberatorId, "alliance"))) return false;
  const owners = getOwnerByMesoId(world), regions = getMesoById(world), remaining = new Map<NationId, number>();
  for (const [id, owner] of owners) if (regions.get(id)?.type !== "sea") remaining.set(owner, (remaining.get(owner) ?? 0) + 1);
  for (const id of regionIds) {
    const owner = owners.get(id), controller = world.occupation.mesoById.get(id) ?? owner;
    if (!owner || owner === nationId || !exile.homelandIds.includes(id) || regions.get(id)?.type === "sea" || controller !== liberatorId ||
      (owner !== liberatorId && !findWar(world.wars, liberatorId, owner))) return false;
    remaining.set(owner, (remaining.get(owner) ?? 0) - 1);
  }
  // A host cannot give away its last foothold; full enemy capitulations use the existing settlement path.
  if ([...remaining].some(([id, count]) => id !== nationId && count <= 0)) return false;
  updateTerritorialClaims(world);
  const ids = new Set(regionIds), formerOwners = new Set(regionIds.map((id) => owners.get(id)!));
  for (const macro of [...world.macroRegions]) if (formerOwners.has(macro.nationId)) partition(world, macro, ids, nationId);
  refreshNationProvinces(world); world.mapVersion++; world.territoryVersion++;
  for (const id of ids) {
    const region = regions.get(id)!; if (region.building === "capital") region.building = "city";
    world.occupation.mesoById.delete(id); world.occupation.dirtyMesoIds.add(id);
  }
  const newOwners = getOwnerByMesoId(world);
  for (const formerOwner of formerOwners) {
    const nation = world.nations.find((item) => item.id === formerOwner)!;
    if (newOwners.get(nation.capitalMesoId) === formerOwner) continue;
    const owned = world.mesoRegions.filter((region) => region.type !== "sea" && newOwners.get(region.id) === formerOwner);
    const replacement = owned.find((region) => region.building === "city" && !world.occupation.mesoById.has(region.id)) ??
      owned.find((region) => !world.occupation.mesoById.has(region.id)) ?? owned[0];
    if (replacement) { nation.capitalMesoId = replacement.id; replacement.building = "capital"; }
  }
  world.occupation.version++; world.buildingVersion++;
  world.battles = world.battles.filter((battle) => !ids.has(battle.mesoId));
  updateOccupation(world);
  updateTerritorialClaims(world, new Set([liberatorId]));
  recordSimulationEvent(world, { category: "diplomacy", nationIds: [nationId, liberatorId],
    message: `${liberatorId} restored ${regionIds.length} liberated homeland districts to ${nationId}.` });
  return true;
}
