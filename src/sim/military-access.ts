import { areFactionPartners } from "./factions";
import { getNationCharacter } from "./nation-character";
import type { NationId } from "../worldgen/nation";
import type { MesoRegionId } from "../worldgen/meso-region";
import type { UnitId } from "./unit";
import type { WorldState } from "./world-state";
import { getRelation, spendInfluence, hasTreaty } from "./diplomacy";
import { getWarDeclarationMode, recordSimulationEvent } from "./simulation-settings";
import { getOwnerByMesoId, getMesoById } from "./world-cache";
import { findWar } from "./war-state";

export interface MilitaryAccessGrant {
  hostId: NationId; guestId: NationId; expiresAtSlowTick: number;
  revokedAtSlowTick?: number; reason?: string; repatriated?: boolean;
}
export interface MilitaryAccessState {
  grants: MilitaryAccessGrant[]; version: number; lastAISlowTick: number;
  orders: Map<UnitId, { nationId: NationId; destinationId: MesoRegionId }>;
}
export function getMilitaryAccessState(world: WorldState): MilitaryAccessState {
  return world.militaryAccess ??= { grants: [], version: 0, lastAISlowTick: 0, orders: new Map() };
}
export function hasMilitaryAccess(world: WorldState, guestId: NationId, hostId: NationId): boolean {
  if (guestId === hostId) return true;
  if (getWarDeclarationMode(world) !== "diplomacy" || findWar(world.wars, guestId, hostId) ||
    ![guestId, hostId].every((id) => world.nations.some((nation) => nation.id === id && nation.macroRegionIds.length))) return false;
  const relation = world.diplomacy?.relations.get([guestId, hostId].sort().join(":"));
  return !!relation && relation.trust >= 50 && !relation.crisis && (world.militaryAccess?.grants.some((grant) =>
    grant.guestId === guestId && grant.hostId === hostId && grant.revokedAtSlowTick === undefined && grant.expiresAtSlowTick > world.time.slowTick) ?? false);
}
function issueMilitaryAccess(world: WorldState, hostId: NationId, guestId: NationId, payerId: NationId): boolean {
  if (getWarDeclarationMode(world) !== "diplomacy" || hostId === guestId || findWar(world.wars, hostId, guestId) ||
    ![hostId, guestId].every((id) => world.nations.some((nation) => nation.id === id && nation.macroRegionIds.length))) return false;
  const relation = getRelation(world, hostId, guestId), state = getMilitaryAccessState(world);
  if (relation.trust < 60 || relation.opinion < 20 || relation.crisis || hasMilitaryAccess(world, guestId, hostId) ||
    state.grants.filter((grant) => grant.revokedAtSlowTick === undefined).length >= 64 ||
    (state.grants.length >= 128 && !state.grants.some((grant) => grant.hostId === hostId && grant.guestId === guestId)) || !spendInfluence(world, payerId, 6)) return false;
  state.grants = state.grants.filter((grant) => !(grant.hostId === hostId && grant.guestId === guestId));
  state.grants.push({ hostId, guestId, expiresAtSlowTick: world.time.slowTick + 400 }); state.version++;
  recordSimulationEvent(world, { category: "military", nationIds: [hostId, guestId], message: `${hostId} granted military access and local logistics to ${guestId} for 400 seconds.` });
  return true;
}
export function grantMilitaryAccess(world: WorldState, hostId: NationId, guestId: NationId): boolean {
  return issueMilitaryAccess(world, hostId, guestId, hostId);
}
export function requestMilitaryAccess(world: WorldState, guestId: NationId, hostId: NationId): boolean {
  // As with other bilateral proposals, the host only grants when its trust requirements are met.
  return issueMilitaryAccess(world, hostId, guestId, guestId);
}
export function revokeMilitaryAccess(world: WorldState, hostId: NationId, guestId: NationId, reason = "host withdrawal"): boolean {
  const grant = world.militaryAccess?.grants.find((item) => item.hostId === hostId && item.guestId === guestId && item.revokedAtSlowTick === undefined);
  if (!grant) return false;
  grant.revokedAtSlowTick = world.time.slowTick; grant.reason = reason; world.militaryAccess!.version++;
  for (const [id, order] of world.militaryAccess!.orders) if (order.nationId === guestId && getOwnerByMesoId(world).get(order.destinationId) === hostId) world.militaryAccess!.orders.delete(id);
  recordSimulationEvent(world, { category: "military", nationIds: [hostId, guestId], message: `${hostId} ended military access for ${guestId} (${reason}); neutral visitors must leave.` });
  return true;
}
export function withdrawMilitaryVisitors(world: WorldState, guestId: NationId, hostId: NationId): number {
  const home = world.nations.find((nation) => nation.id === guestId && nation.macroRegionIds.length); if (!home) return 0;
  const owners = getOwnerByMesoId(world); let returned = 0;
  for (const unit of world.units) if (unit.nationId === guestId && unit.domain === "land" && (owners.get(unit.regionId) === hostId || owners.get(world.militaryAccess?.orders.get(unit.id)?.destinationId as MesoRegionId) === hostId)) {
    if (owners.get(unit.regionId) === hostId) unit.regionId = home.capitalMesoId;
    unit.moveTargetId = null; unit.moveFromId = null; unit.moveToId = null; unit.moveProgressMs = 0;
    unit.org *= 0.85; world.militaryAccess?.orders.delete(unit.id); returned++;
  }
  return returned;
}

const routeMaps = new WeakMap<WorldState, { key: string; maps: Map<NationId, Map<MesoRegionId, NationId>> }>();
/** A navigation-only view: actual legal ownership is never changed by access. */
export function getMilitaryRoutingOwners(world: WorldState, nationId: NationId): Map<MesoRegionId, NationId> {
  const owners = getOwnerByMesoId(world);
  const hosts = [...new Set((world.militaryAccess?.grants ?? []).filter((grant) => grant.guestId === nationId && hasMilitaryAccess(world, nationId, grant.hostId)).map((grant) => grant.hostId))].sort();
  if (!hosts.length) return owners;
  const key = `${world.territoryVersion}:${world.occupation.version}:${world.militaryAccess?.version}:${world.time.slowTick}`;
  let cache = routeMaps.get(world);
  if (!cache || cache.key !== key) { cache = { key, maps: new Map() }; routeMaps.set(world, cache); }
  const old = cache.maps.get(nationId); if (old) return old;
  const map = new Map(owners), allowed = new Set(hosts);
  for (const [id, owner] of owners) if (allowed.has(owner) && (!world.occupation.mesoById.has(id) || world.occupation.mesoById.get(id) === owner)) map.set(id, nationId);
  cache.maps.set(nationId, map); return map;
}
export function findMilitaryAccessRoute(world: WorldState, nationId: NationId, source: MesoRegionId, destination: MesoRegionId): MesoRegionId[] | null {
  const owners = getMilitaryRoutingOwners(world, nationId), regions = getMesoById(world);
  if (owners.get(source) !== nationId || owners.get(destination) !== nationId) return null;
  const previous = new Map<MesoRegionId, MesoRegionId | null>([[source, null]]), queue = [source];
  for (let index = 0; index < queue.length && !previous.has(destination); index++) for (const next of regions.get(queue[index])?.neighbors ?? []) {
    if (previous.has(next.id) || regions.get(next.id)?.type === "sea" || owners.get(next.id) !== nationId ||
      (world.occupation.mesoById.has(next.id) && world.occupation.mesoById.get(next.id) !== getOwnerByMesoId(world).get(next.id))) continue;
    previous.set(next.id, queue[index]); queue.push(next.id);
  }
  if (!previous.has(destination)) return null;
  const route: MesoRegionId[] = [];
  for (let id: MesoRegionId | null = destination; id; id = previous.get(id) ?? null) route.push(id);
  return route.reverse();
}
export function stageMilitaryUnits(world: WorldState, guestId: NationId, hostId: NationId, count = 3): number {
  if (!Number.isInteger(count) || count < 1 || count > 5 || !hasMilitaryAccess(world, guestId, hostId) ||
    world.wars.some((war) => war.nationAId === guestId || war.nationBId === guestId)) return 0;
  const destination = world.nations.find((nation) => nation.id === hostId)?.capitalMesoId; if (!destination) return 0;
  const state = getMilitaryAccessState(world);
  const candidates = world.units.filter((unit) => unit.nationId === guestId && unit.domain === "land" && !unit.volunteerOriginId && !state.orders.has(unit.id) &&
    !world.amphibiousOperations.operationByUnitId.has(unit.id) && !world.offensiveOperations.operationIdByUnitId.has(unit.id) &&
    !world.retreatPlans.retreatIdByUnitId.has(unit.id) && !world.reorganization.planIdByUnitId.has(unit.id) && unit.manpower > 0 &&
    findMilitaryAccessRoute(world, guestId, unit.regionId, destination));
  for (const unit of candidates.slice(0, count)) state.orders.set(unit.id, { nationId: guestId, destinationId: destination });
  return Math.min(count, candidates.length);
}
export function applyMilitaryStagingOrders(world: WorldState): void {
  const state = world.militaryAccess; if (!state?.orders.size) return;
  const units = new Map(world.units.map((unit) => [unit.id, unit]));
  for (const [id, order] of state.orders) {
    const unit = units.get(id), host = getOwnerByMesoId(world).get(order.destinationId);
    if (!unit || unit.nationId !== order.nationId || !host || !hasMilitaryAccess(world, unit.nationId, host) ||
      world.wars.some((war) => war.nationAId === unit.nationId || war.nationBId === unit.nationId)) { state.orders.delete(id); continue; }
    unit.moveTargetId = order.destinationId;
  }
}
export function updateMilitaryAccess(world: WorldState): void {
  const state = world.militaryAccess ?? (getWarDeclarationMode(world) === "diplomacy" ? getMilitaryAccessState(world) : undefined); if (!state) return;
  for (const grant of state.grants) {
    if (grant.revokedAtSlowTick === undefined && !hasMilitaryAccess(world, grant.guestId, grant.hostId)) revokeMilitaryAccess(world, grant.hostId, grant.guestId, "expired, unsafe or insufficient trust");
    if (grant.revokedAtSlowTick !== undefined && !grant.repatriated && (findWar(world.wars, grant.guestId, grant.hostId) || world.time.slowTick - grant.revokedAtSlowTick >= 15)) {
      withdrawMilitaryVisitors(world, grant.guestId, grant.hostId); grant.repatriated = true;
    }
  }
  state.grants = state.grants.filter((grant) => grant.revokedAtSlowTick === undefined || world.time.slowTick - grant.revokedAtSlowTick < 60);
  applyMilitaryStagingOrders(world);
  if (getWarDeclarationMode(world) !== "diplomacy" || world.time.slowTick - state.lastAISlowTick < 30) return;
  state.lastAISlowTick = world.time.slowTick;
  const issued = new Set<NationId>();
  for (const relation of world.diplomacy?.relations.values() ?? []) {
    const a = relation.nationAId, b = relation.nationBId;
    if (relation.trust < 65 || relation.opinion < 35 || (!areFactionPartners(world, a, b) && !hasTreaty(world, a, b, "alliance"))) continue;
    for (const [host, guest] of [[a, b], [b, a]]) if (!issued.has(host) && getNationCharacter(world, host).cooperation >= 0.6 && !hasMilitaryAccess(world, guest, host)) {
      if (grantMilitaryAccess(world, host, guest)) issued.add(host);
    }
  }
}

/** End prewar visitor rights once; subsequent attacking armies are ordinary belligerents. */
export function prepareMilitaryAccessForWar(world: WorldState, a: NationId, b: NationId): void {
  for (const grant of world.militaryAccess?.grants ?? []) if (grant.revokedAtSlowTick === undefined &&
    ((grant.guestId === a && grant.hostId === b) || (grant.guestId === b && grant.hostId === a))) {
    revokeMilitaryAccess(world, grant.hostId, grant.guestId, "war declared");
    withdrawMilitaryVisitors(world, grant.guestId, grant.hostId); grant.repatriated = true;
  }
}
