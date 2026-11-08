import { WORLD_BALANCE } from "../data/balance";
import { allFieldUnits } from "./mobilization";
import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import type { UnitState } from "./unit";
import type { WorldState } from "./world-state";
import { getRelation, hasTreaty } from "./diplomacy";
import { areFactionPartners, updateFactionGovernments, getNationFaction } from "./factions";
import { getNationName } from "./nation-identity";
import { isNationActive } from "./nation-active";
import { getWarDeclarationMode, recordSimulationEvent } from "./simulation-settings";
import { getMesoById, getOwnerByMesoId } from "./world-cache";
import { declareWar, findWar } from "./war-state";
import { restoreExiledTerritories } from "./territory-transfer";

export interface ExileGovernment {
  nationId: NationId; hostId: NationId; homelandIds: MesoRegionId[]; enemyIds: NationId[];
  status: "exiled" | "restored" | "dissolved"; establishedAtSlowTick: number; endedAtSlowTick?: number;
  reserveUnits: UnitState[]; arrivesAtSlowTick: number; evacuatedUnits: number; restoredDistricts: number;
  graceUntilSlowTick: number;
}
export interface ExileGovernmentState { byNationId: Map<NationId, ExileGovernment>; version: number }
export function getExileState(world: WorldState): ExileGovernmentState {
  return world.exileGovernments ??= { byNationId: new Map(), version: 0 };
}
const government = (world: WorldState, id: NationId) => world.exileGovernments?.byNationId.get(id);
const allied = (world: WorldState, a: NationId, b: NationId) => areFactionPartners(world, a, b) || hasTreaty(world, a, b, "alliance");
function safeCapital(world: WorldState, id: NationId): MesoRegionId | null {
  const nation = world.nations.find((item) => item.id === id && isNationActive(item));
  if (!nation || getOwnerByMesoId(world).get(nation.capitalMesoId) !== id) return null;
  const controller = world.occupation.mesoById.get(nation.capitalMesoId);
  return !controller || controller === id ? nation.capitalMesoId : null;
}
function hostEligible(world: WorldState, nationId: NationId, hostId: NationId, enemies: NationId[], excluded: ReadonlySet<NationId>): boolean {
  if (hostId === nationId || excluded.has(hostId) || !safeCapital(world, hostId) || government(world, hostId)?.status === "exiled" || findWar(world.wars, nationId, hostId)) return false;
  const relation = getRelation(world, nationId, hostId);
  const owners = getOwnerByMesoId(world);
  const liberatedHome = government(world, nationId)?.homelandIds.some((id) => {
    const owner = owners.get(id), controller = world.occupation.mesoById.get(id) ?? owner;
    return controller === hostId && (owner === hostId || (owner && !!findWar(world.wars, hostId, owner)));
  });
  return allied(world, nationId, hostId) && relation.opinion >= 35 && relation.trust >= 60 && !relation.crisis &&
    (liberatedHome || enemies.some((enemy) => findWar(world.wars, hostId, enemy))) &&
    !enemies.some((enemy) => areFactionPartners(world, hostId, enemy));
}
function pickHost(world: WorldState, id: NationId, enemies: NationId[], excluded: ReadonlySet<NationId>): NationId | undefined {
  const leader = getNationFaction(world, id)?.leaderId;
  return world.nations.map((nation) => nation.id).filter((host) => hostEligible(world, id, host, enemies, excluded))
    .sort((a, b) => {
      const score = (host: NationId) => getRelation(world, id, host).trust + (leader === host ? 20 : 0) +
        world.nations.find((nation) => nation.id === host)!.macroRegionIds.length * 2;
      return score(b) - score(a) || a.localeCompare(b);
    })[0];
}
function freeToRelocate(world: WorldState, unit: UnitState): boolean {
  return !unit.volunteerOriginId && unit.volunteerMissionId === undefined && !unit.cargoUnits.length && !unit.amphibiousEmbarkRequested && !unit.amphibiousLandRequested &&
    !world.amphibiousOperations.operationByUnitId.has(unit.id) && !world.amphibiousOperations.capabilityDemandByUnitId.has(unit.id) &&
    !world.offensiveOperations.operationIdByUnitId.has(unit.id) && !world.retreatPlans.retreatIdByUnitId.has(unit.id) &&
    !world.reorganization.planIdByUnitId.has(unit.id) && !world.militaryAccess?.orders.has(unit.id) &&
    !world.battles.some((battle) => battle.mesoId === unit.regionId);
}
function resetMove(unit: UnitState): void {
  unit.moveTargetId = null; unit.moveFromId = null; unit.moveToId = null; unit.moveProgressMs = 0;
}
/** Only surviving land troops with an open friendly corridor can escape; encircled forces are captured. */
function escapeDistance(world: WorldState, source: MesoRegionId, nationId: NationId, hostId: NationId): number | null {
  const owners = getOwnerByMesoId(world), regions = getMesoById(world), destination = safeCapital(world, hostId);
  const permitted = (id: MesoRegionId) => {
    const controller = world.occupation.mesoById.get(id) ?? owners.get(id);
    return regions.get(id)?.type !== "sea" && (controller === nationId || controller === hostId);
  };
  if (!destination || !permitted(source)) return null;
  const distance = new Map([[source, 0]]), queue = [source];
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]!; if (id === destination) return distance.get(id)!;
    for (const neighbor of regions.get(id)?.neighbors ?? []) if (!distance.has(neighbor.id) && permitted(neighbor.id)) {
      distance.set(neighbor.id, distance.get(id)! + 1); queue.push(neighbor.id);
    }
  }
  return null;
}
export function establishExileGovernment(world: WorldState, nationId: NationId, excludedHosts: ReadonlySet<NationId> = new Set()): ExileGovernment | null {
  if (getWarDeclarationMode(world) !== "diplomacy" || government(world, nationId)?.status === "exiled") return null;
  const nation = world.nations.find((item) => item.id === nationId && isNationActive(item));
  if (!nation) return null;
  const enemies = world.wars.filter((war) => war.nationAId === nationId || war.nationBId === nationId)
    .map((war) => war.nationAId === nationId ? war.nationBId : war.nationAId);
  const hostId = pickHost(world, nationId, enemies, excludedHosts); if (!hostId) return null;
  const owners = getOwnerByMesoId(world);
  const limit = world.settings?.mobilizationEnabled ? WORLD_BALANCE.production.maxMobilizedLandUnits : WORLD_BALANCE.production.maxLandUnits;
  const room = Math.max(0, limit - allFieldUnits(world).filter((unit) => unit.nationId === hostId && unit.domain === "land").length);
  const candidates = world.units.filter((unit) => unit.nationId === nationId && unit.domain === "land" && unit.manpower > 0 &&
    !unit.volunteerOriginId && !unit.exileOriginId && freeToRelocate(world, unit))
    .map((unit) => ({ unit, distance: escapeDistance(world, unit.regionId, nationId, hostId) }))
    .filter((entry): entry is { unit: UnitState; distance: number } => entry.distance !== null)
    .sort((a, b) => a.distance - b.distance || a.unit.id.localeCompare(b.unit.id)).slice(0, Math.min(6, room));
  const units = candidates.map(({ unit }) => unit), ids = new Set(units.map((unit) => unit.id));
  for (const unit of units) { unit.exileOriginId = nationId; unit.nationId = hostId; resetMove(unit); unit.org = Math.min(unit.org, 0.6); }
  world.units = world.units.filter((unit) => !ids.has(unit.id));
  nation.unitRoles.defenseUnitIds = nation.unitRoles.defenseUnitIds.filter((id) => !ids.has(id));
  nation.unitRoles.occupationUnitIds = nation.unitRoles.occupationUnitIds.filter((id) => !ids.has(id));
  const record: ExileGovernment = { nationId, hostId, homelandIds: world.mesoRegions.filter((region) => region.type !== "sea" && owners.get(region.id) === nationId).map((region) => region.id),
    enemyIds: enemies, status: "exiled", establishedAtSlowTick: world.time.slowTick, reserveUnits: units,
    arrivesAtSlowTick: world.time.slowTick + Math.max(15, ...candidates.map((entry) => entry.distance * 2)),
    evacuatedUnits: units.length, restoredDistricts: 0, graceUntilSlowTick: 0 };
  const state = getExileState(world); state.byNationId.set(nationId, record); state.version++;
  recordSimulationEvent(world, { category: "diplomacy", nationIds: [nationId, hostId],
    message: `${getNationName(world, nationId)} established a government in exile in ${getNationName(world, hostId)}; ${units.length} units escaped capitulation.` });
  return record;
}
function dissolve(world: WorldState, record: ExileGovernment): void {
  record.status = "dissolved"; record.endedAtSlowTick = world.time.slowTick; record.reserveUnits = [];
  for (const unit of world.units) if (unit.exileOriginId === record.nationId) delete unit.exileOriginId;
  getExileState(world).version++;
  recordSimulationEvent(world, { category: "diplomacy", nationIds: [record.nationId, record.hostId],
    message: `${getNationName(world, record.nationId)}'s government in exile dissolved: no trusted ally can continue the liberation war.` });
}
function returnGovernment(world: WorldState, record: ExileGovernment, capitalId: MesoRegionId): void {
  const nation = world.nations.find((item) => item.id === record.nationId)!;
  const regions = getMesoById(world), owners = getOwnerByMesoId(world);
  const oldCapital = regions.get(nation.capitalMesoId);
  if (oldCapital?.building === "capital" && owners.get(oldCapital.id) === nation.id) oldCapital.building = "city";
  nation.capitalMesoId = capitalId; regions.get(capitalId)!.building = "capital"; world.buildingVersion++;
  nation.capitalFallCount = 0; nation.surrenderScore = 0; nation.nextUnitProductionTick = world.time.slowTick;
  nation.initialCityCount = Math.max(1, world.mesoRegions.filter((region) => owners.get(region.id) === nation.id && (region.building === "capital" || region.building === "city")).length);
  nation.initialUnitCount = Math.max(1, record.evacuatedUnits);
  record.status = "restored"; record.endedAtSlowTick = world.time.slowTick; record.graceUntilSlowTick = world.time.slowTick + 60;
  for (const enemy of record.enemyIds) if (world.nations.some((item) => item.id === enemy && isNationActive(item)) &&
    findWar(world.wars, record.hostId, enemy) && !areFactionPartners(world, record.nationId, enemy)) {
    const war = declareWar(world.wars, enemy, record.nationId, world.time.fastTick); if (war) war.cause = "defensive-alliance";
  }
  getExileState(world).version++;
  recordSimulationEvent(world, { category: "diplomacy", nationIds: [record.nationId, record.hostId],
    message: `${getNationName(world, record.nationId)}'s government returned to ${record.restoredDistricts} liberated districts. A 60-second reorganization period begins.` });
}
export function updateExileGovernments(world: WorldState): void {
  const state = world.exileGovernments; if (!state) return;
  for (const record of state.byNationId.values()) {
    if (record.status === "dissolved") continue;
    if (record.status === "restored" && !world.nations.some((nation) => nation.id === record.nationId && isNationActive(nation))) { dissolve(world, record); continue; }
    if (record.status === "exiled") {
      if (!hostEligible(world, record.nationId, record.hostId, record.enemyIds, new Set())) {
        const host = pickHost(world, record.nationId, record.enemyIds, new Set());
        if (!host) { dissolve(world, record); continue; }
        const old = record.hostId; record.hostId = host; record.arrivesAtSlowTick = world.time.slowTick + 15;
        for (const unit of record.reserveUnits) unit.nationId = host;
        state.version++;
        recordSimulationEvent(world, { category: "diplomacy", nationIds: [record.nationId, old, host],
          message: `${getNationName(world, record.nationId)}'s government in exile relocated to ${getNationName(world, host)}.` });
      }
    }
    if (record.status === "exiled" || record.status === "restored") {
      const owners = getOwnerByMesoId(world);
      const liberated = record.homelandIds.filter((id) => {
        const owner = owners.get(id), controller = world.occupation.mesoById.get(id) ?? owner;
        return owner && controller === record.hostId && (owner === record.hostId || !!findWar(world.wars, record.hostId, owner));
      });
      if (liberated.length && restoreExiledTerritories(world, record.nationId, record.hostId, liberated)) {
        record.restoredDistricts += liberated.length;
        const capital = liberated.find((id) => ["city", "capital"].includes(getMesoById(world).get(id)?.building ?? "")) ?? liberated[0]!;
        if (record.status === "exiled") returnGovernment(world, record, capital);
      }
    }
    // Return free forces only when they can leave battle; the host commands them until then.
    if (record.status === "restored" || record.status === "exiled") {
      const returning = world.units.filter((unit) => unit.exileOriginId === record.nationId && (record.status === "restored" || unit.nationId !== record.hostId) && freeToRelocate(world, unit));
      if (returning.length) {
        const ids = new Set(returning.map((unit) => unit.id)); world.units = world.units.filter((unit) => !ids.has(unit.id));
        for (const unit of returning) { resetMove(unit); unit.nationId = record.status === "restored" ? record.nationId : record.hostId; }
        record.reserveUnits.push(...returning); record.arrivesAtSlowTick = Math.max(record.arrivesAtSlowTick, world.time.slowTick + 15);
      }
    }
    const destination = safeCapital(world, record.status === "restored" ? record.nationId : record.hostId);
    if (record.reserveUnits.length && world.time.slowTick >= record.arrivesAtSlowTick && destination) {
      for (const unit of record.reserveUnits) {
        unit.nationId = record.status === "restored" ? record.nationId : record.hostId;
        unit.regionId = destination; resetMove(unit);
        if (record.status === "restored") delete unit.exileOriginId;
        world.units.push(unit);
      }
      record.reserveUnits = []; state.version++;
    }
  }
  updateFactionGovernments(world);
}
