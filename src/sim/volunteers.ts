import type { NationId } from "../worldgen/nation";
import type { UnitId, UnitState } from "./unit";
import type { WorldState } from "./world-state";
import { getRelation, hasTreaty, spendInfluence } from "./diplomacy";
import { areFactionPartners } from "./factions";
import { findTradeRoute, isTradeRouteOpen, changeResource, type TradeRoute } from "./international-trade";
import { getWarDeclarationMode, recordSimulationEvent } from "./simulation-settings";
import { getOwnerByMesoId } from "./world-cache";
import { findWar } from "./war-state";
import { isNationRegionSupplied } from "./supply-assessment";
import { getNationCharacter } from "./nation-character";
import { WORLD_BALANCE } from "../data/balance";

export interface VolunteerMission {
  id: number; donorId: NationId; recipientId: NationId; unitIds: UnitId[]; transitUnits: UnitState[];
  route: TradeRoute; arrivesAtSlowTick: number; createdAtSlowTick: number;
  status: "outbound" | "active" | "recall-requested" | "returning" | "completed" | "lost" | "integrated";
  returnedUnits: number; endedAtSlowTick?: number;
}
export interface VolunteerState { missions: VolunteerMission[]; nextId: number; lastAISlowTick: number }
export function getVolunteerState(world: WorldState): VolunteerState {
  return world.volunteers ??= { missions: [], nextId: 0, lastAISlowTick: 0 };
}
const active = (world: WorldState, id: NationId) => world.nations.some((nation) => nation.id === id && nation.macroRegionIds.length);
const enemies = (world: WorldState, id: NationId) => world.wars.filter((war) => war.nationAId === id || war.nationBId === id).map((war) => war.nationAId === id ? war.nationBId : war.nationAId);
export function canSendVolunteers(world: WorldState, donor: NationId, recipient: NationId): boolean {
  if (getWarDeclarationMode(world) !== "diplomacy" || donor === recipient || !active(world, donor) || !active(world, recipient) || findWar(world.wars, donor, recipient)) return false;
  const relation = getRelation(world, donor, recipient), foes = enemies(world, recipient);
  return foes.length > 0 && relation.trust >= 55 && relation.opinion >= 35 && !relation.crisis &&
    (areFactionPartners(world, donor, recipient) || hasTreaty(world, donor, recipient, "alliance") || relation.opinion >= 40) &&
    !foes.some((enemy) => findWar(world.wars, donor, enemy) || areFactionPartners(world, donor, enemy) ||
      (["alliance", "non-aggression", "truce"] as const).some((type) => hasTreaty(world, donor, enemy, type)));
}
function clearMove(unit: UnitState): void { unit.moveTargetId = null; unit.moveFromId = null; unit.moveToId = null; unit.moveProgressMs = 0; }
function freeToLeave(world: WorldState, unit: UnitState): boolean {
  return !unit.amphibiousEmbarkRequested && !unit.amphibiousLandRequested && !unit.cargoUnits.length &&
    !world.amphibiousOperations.operationByUnitId.has(unit.id) && !world.amphibiousOperations.capabilityDemandByUnitId.has(unit.id) &&
    !world.offensiveOperations.operationIdByUnitId.has(unit.id) && !world.retreatPlans.retreatIdByUnitId.has(unit.id) &&
    !world.reorganization.planIdByUnitId.has(unit.id) && !world.battles.some((battle) => battle.mesoId === unit.regionId);
}
export function sendVolunteers(world: WorldState, donorId: NationId, recipientId: NationId, count = 2): VolunteerMission | null {
  if (!Number.isInteger(count) || count < 1 || count > 5 || !canSendVolunteers(world, donorId, recipientId)) return null;
  const state = getVolunteerState(world), outstanding = state.missions.filter((mission) => ["outbound", "active", "recall-requested", "returning"].includes(mission.status));
  if (state.missions.some((mission) => mission.donorId === donorId && mission.recipientId === recipientId && mission.endedAtSlowTick !== undefined && world.time.slowTick - mission.endedAtSlowTick < 120) || outstanding.length >= 20 || outstanding.some((mission) => mission.donorId === donorId && mission.recipientId === recipientId) ||
    outstanding.filter((mission) => mission.donorId === donorId).reduce((sum, mission) => sum + mission.unitIds.length, 0) + count > 8) return null;
  const donor = world.nations.find((nation) => nation.id === donorId)!;
  const owners = getOwnerByMesoId(world), own = world.units.filter((unit) => unit.nationId === donorId && unit.domain === "land" && !unit.volunteerOriginId);
  const homeArmy = own.filter((unit) => owners.get(unit.regionId) === donorId && !world.militaryAccess?.orders.has(unit.id) && !unit.amphibiousEmbarkRequested).length;
  if (homeArmy - count < 3) return null;
  const candidates = own.filter((unit) => owners.get(unit.regionId) === donorId && !unit.moveToId && unit.org >= 0.6 && unit.manpower > 0 &&
    !world.militaryAccess?.orders.has(unit.id) && freeToLeave(world, unit) && isNationRegionSupplied(world, donorId, unit.regionId));
  if (candidates.length < count) return null;
  const incoming = outstanding.filter((mission) => mission.recipientId === recipientId && mission.status === "outbound").reduce((sum, mission) => sum + mission.transitUnits.length, 0);
  const fielded = world.units.flatMap((unit) => [unit, ...unit.cargoUnits]).filter((unit) => unit.nationId === recipientId && unit.domain === "land").length;
  if (fielded + incoming + count > (world.settings?.mobilizationEnabled ? WORLD_BALANCE.production.maxMobilizedLandUnits : WORLD_BALANCE.production.maxLandUnits)) return null;
  const route = findTradeRoute(world, donorId, recipientId); if (!route) return null;
  const fuel = route.maritime ? Math.max(2, Math.ceil(route.regionIds.length * 0.1)) : 0;
  if (donor.resources.fuel < fuel || !spendInfluence(world, donorId, 10)) return null;
  if (fuel) changeResource(donor, "fuel", -fuel);
  const units = candidates.slice(0, count), selected = new Set(units.map((unit) => unit.id));
  const mission: VolunteerMission = { id: state.nextId++, donorId, recipientId, unitIds: [...selected], transitUnits: units, route,
    arrivesAtSlowTick: world.time.slowTick + Math.max(5, Math.ceil(route.regionIds.length * 1.5)), createdAtSlowTick: world.time.slowTick,
    status: "outbound", returnedUnits: 0 };
  for (const unit of units) { unit.volunteerOriginId = donorId; unit.volunteerMissionId = mission.id; clearMove(unit); }
  world.units = world.units.filter((unit) => !selected.has(unit.id)); state.missions.push(mission);
  donor.unitRoles.defenseUnitIds = donor.unitRoles.defenseUnitIds.filter((id) => !selected.has(id));
  donor.unitRoles.occupationUnitIds = donor.unitRoles.occupationUnitIds.filter((id) => !selected.has(id));
  while (state.missions.length > 40) { const index = state.missions.findIndex((item) => ["completed", "lost", "integrated"].includes(item.status)); if (index < 0) break; state.missions.splice(index, 1); }
  const relation = getRelation(world, donorId, recipientId); relation.opinion = Math.min(100, relation.opinion + 4);
  for (const enemy of enemies(world, recipientId)) { const relation = getRelation(world, donorId, enemy); relation.opinion = Math.max(-100, relation.opinion - 12); relation.grievance = Math.min(100, relation.grievance + 8); }
  recordSimulationEvent(world, { category: "military", nationIds: [donorId, recipientId], message: `${donorId} dispatched ${count} volunteer units to ${recipientId}; the donor remains outside its wars.` });
  return mission;
}
export function recallVolunteers(world: WorldState, donorId: NationId, missionId: number): boolean {
  const mission = world.volunteers?.missions.find((item) => item.id === missionId && item.donorId === donorId && ["outbound", "active"].includes(item.status));
  if (!mission) return false;
  if (mission.status === "outbound") { mission.status = "returning"; mission.arrivesAtSlowTick = world.time.slowTick + 5; }
  else mission.status = "recall-requested";
  return true;
}
export function dismissVolunteers(world: WorldState, recipientId: NationId, missionId: number): boolean {
  const mission = world.volunteers?.missions.find((item) => item.id === missionId && item.recipientId === recipientId && ["active", "outbound"].includes(item.status));
  return !!mission && recallVolunteers(world, mission.donorId, missionId);
}
export function updateVolunteers(world: WorldState): void {
  const state = world.volunteers ?? (getWarDeclarationMode(world) === "diplomacy" ? getVolunteerState(world) : undefined); if (!state) return;
  for (const mission of state.missions) {
    if (["completed", "lost", "integrated"].includes(mission.status)) continue;
    const donor = world.nations.find((nation) => nation.id === mission.donorId && nation.macroRegionIds.length);
    const recipient = world.nations.find((nation) => nation.id === mission.recipientId && nation.macroRegionIds.length);
    if (!donor) {
      const survivors = [...world.units.flatMap((unit) => [unit, ...unit.cargoUnits]).filter((unit) => unit.volunteerMissionId === mission.id), ...mission.transitUnits];
      for (const unit of survivors) { delete unit.volunteerOriginId; delete unit.volunteerMissionId; if (recipient && mission.transitUnits.includes(unit)) { unit.nationId = recipient.id; unit.regionId = recipient.capitalMesoId; world.units.push(unit); } }
      mission.transitUnits = []; mission.status = recipient ? "integrated" : "lost"; mission.endedAtSlowTick = world.time.slowTick; continue;
    }
    const needsReturn = getWarDeclarationMode(world) !== "diplomacy" || !recipient || !enemies(world, mission.recipientId).length ||
      findWar(world.wars, mission.donorId, mission.recipientId) || getRelation(world, mission.donorId, mission.recipientId).trust < 40 ||
      enemies(world, mission.recipientId).some((enemy) => areFactionPartners(world, mission.donorId, enemy) ||
        (["alliance", "non-aggression", "truce"] as const).some((type) => hasTreaty(world, mission.donorId, enemy, type)));
    if (mission.status === "outbound" && (needsReturn || !isTradeRouteOpen(world, mission.donorId, mission.recipientId, mission.route))) {
      mission.status = "returning"; mission.arrivesAtSlowTick = world.time.slowTick + 5;
    }
    if (mission.status === "outbound" && world.time.slowTick >= mission.arrivesAtSlowTick && recipient) {
      const fielded = world.units.flatMap((unit) => [unit, ...unit.cargoUnits]).filter((unit) => unit.nationId === recipient.id && unit.domain === "land").length;
      const limit = world.settings?.mobilizationEnabled ? WORLD_BALANCE.production.maxMobilizedLandUnits : WORLD_BALANCE.production.maxLandUnits;
      if (fielded + mission.transitUnits.length > limit) { mission.status = "returning"; mission.arrivesAtSlowTick = world.time.slowTick + 5; continue; }
      for (const unit of mission.transitUnits) { unit.nationId = recipient.id; unit.regionId = recipient.capitalMesoId; unit.org = Math.max(0.4, unit.org - 0.1); world.units.push(unit); }
      mission.transitUnits = []; mission.status = "active";
    }
    if (mission.status === "active" && needsReturn) mission.status = "recall-requested";
    if (mission.status === "recall-requested") {
      const survivors = world.units.filter((unit) => unit.volunteerMissionId === mission.id && unit.manpower > 0);
      const embarked = world.units.some((unit) => unit.cargoUnits.some((cargo) => cargo.volunteerMissionId === mission.id));
      const returning = survivors.filter((unit) => !world.battles.some((battle) => battle.mesoId === unit.regionId) &&
        !world.amphibiousOperations.operationByUnitId.has(unit.id) && !unit.amphibiousEmbarkRequested && !unit.amphibiousLandRequested && (!recipient || isNationRegionSupplied(world, unit.nationId, unit.regionId)));
      for (const unit of returning) {
        unit.nationId = mission.donorId; clearMove(unit); mission.transitUnits.push(unit);
      }
      if (returning.length) { const ids = new Set(returning.map((unit) => unit.id)); world.units = world.units.filter((unit) => !ids.has(unit.id)); }
      if (returning.length === survivors.length && !embarked) {
        mission.status = mission.transitUnits.length ? "returning" : "lost";
        mission.arrivesAtSlowTick = world.time.slowTick + Math.max(5, Math.ceil(mission.route.regionIds.length * 1.5));
      }
    }
    if (mission.status === "active" && !world.units.some((unit) => unit.volunteerMissionId === mission.id || unit.cargoUnits.some((cargo) => cargo.volunteerMissionId === mission.id))) mission.status = "lost";
    if (mission.status === "returning" && world.time.slowTick >= mission.arrivesAtSlowTick) {
      for (const unit of mission.transitUnits) {
        unit.nationId = donor.id; unit.regionId = donor.capitalMesoId; clearMove(unit); delete unit.volunteerOriginId; delete unit.volunteerMissionId;
        world.units.push(unit); mission.returnedUnits++;
      }
      mission.transitUnits = []; mission.status = "completed"; mission.endedAtSlowTick = world.time.slowTick;
      recordSimulationEvent(world, { category: "military", nationIds: [mission.donorId, mission.recipientId], message: `${mission.returnedUnits} surviving volunteer units returned to ${mission.donorId}.` });
    }
    if (mission.status === "lost") mission.endedAtSlowTick = world.time.slowTick;
  }
  if (getWarDeclarationMode(world) !== "diplomacy" || world.time.slowTick - state.lastAISlowTick < 60) return;
  state.lastAISlowTick = world.time.slowTick;
  outer: for (const recipient of world.nations.filter((nation) => nation.macroRegionIds.length && enemies(world, nation.id).length)) {
    for (const donor of world.nations) if (donor.macroRegionIds.length && getNationCharacter(world, donor.id).cooperation >= 0.6 &&
      canSendVolunteers(world, donor.id, recipient.id) && sendVolunteers(world, donor.id, recipient.id, 1)) break outer;
  }
}
