import { getManualGovernmentId } from "./player-nation";
import type { NationId } from "../worldgen/nation";
import type { WorldState } from "./world-state";
import { getRelation, hasTreaty, isDiplomaticallyProtected, spendInfluence } from "./diplomacy";
import { areFactionPartners } from "./factions";
import { getNationCharacter } from "./nation-character";
import { getNationalMilitaryStrength, startDiplomaticWar } from "./diplomatic-crises";
import { findWar } from "./war-state";
import { getWarDeclarationMode, recordSimulationEvent } from "./simulation-settings";

export interface AlliedWarRequest {
  id: number; callerId: NationId; allyId: NationId; enemyId: NationId; defensive: boolean;
  rootWarId: string; rootStartedAt: number; createdAtSlowTick: number; expiresAtSlowTick: number;
  status: "pending" | "accepted" | "declined" | "expired" | "stale" | "withdrawn";
}
export interface AlliedWarRequestsState { requests: AlliedWarRequest[]; nextId: number; lastAISlowTick: number }
export function getAlliedWarRequests(world: WorldState): AlliedWarRequestsState {
  return world.alliedWarRequests ??= { requests: [], nextId: 0, lastAISlowTick: 0 };
}
function eligible(world: WorldState, caller: NationId, ally: NationId, enemy: NationId): boolean {
  return new Set([caller, ally, enemy]).size === 3 && [caller, ally, enemy].every((id) => world.nations.some((nation) => nation.id === id && nation.macroRegionIds.length)) &&
    (areFactionPartners(world, caller, ally) || hasTreaty(world, caller, ally, "alliance")) &&
    !findWar(world.wars, caller, ally) && !findWar(world.wars, ally, enemy) && !isDiplomaticallyProtected(world, ally, enemy) &&
    getRelation(world, caller, ally).trust >= 60 && getRelation(world, caller, ally).opinion >= 25;
}
export function requestAlliedWarEntry(world: WorldState, callerId: NationId, allyId: NationId, enemyId: NationId): AlliedWarRequest | null {
  const war = findWar(world.wars, callerId, enemyId);
  if (getWarDeclarationMode(world) !== "diplomacy" || !war || !eligible(world, callerId, allyId, enemyId)) return null;
  const state = getAlliedWarRequests(world);
  if (state.requests.filter((request) => request.status === "pending").length >= 20 || state.requests.some((request) => request.callerId === callerId &&
    request.allyId === allyId && request.enemyId === enemyId && (request.status === "pending" || world.time.slowTick - request.createdAtSlowTick < 120)) || !spendInfluence(world, callerId, 8)) return null;
  const request: AlliedWarRequest = { id: state.nextId++, callerId, allyId, enemyId, defensive: war.defenderId === callerId,
    rootWarId: war.id, rootStartedAt: war.startedAtFastTick, createdAtSlowTick: world.time.slowTick,
    expiresAtSlowTick: world.time.slowTick + 45, status: "pending" };
  state.requests.push(request);
  while (state.requests.length > 40) { const index = state.requests.findIndex((item) => item.status !== "pending"); if (index < 0) break; state.requests.splice(index, 1); }
  recordSimulationEvent(world, { category: "military", nationIds: [callerId, allyId, enemyId], message: `${callerId} asked ${allyId} to join its ${request.defensive ? "defensive" : "offensive"} war against ${enemyId}.` });
  return request;
}
export function willAcceptAlliedWarRequest(world: WorldState, request: AlliedWarRequest): boolean {
  const character = getNationCharacter(world, request.allyId), relation = getRelation(world, request.callerId, request.allyId);
  const wars = world.wars.filter((war) => war.nationAId === request.allyId || war.nationBId === request.allyId).length;
  const support = world.nations.find((nation) => nation.id === request.allyId)?.warCooperation ?? 0;
  const strength = (getNationalMilitaryStrength(world, request.allyId) + getNationalMilitaryStrength(world, request.callerId)) / Math.max(1, getNationalMilitaryStrength(world, request.enemyId));
  return wars < 2 && support >= 0.3 && strength >= 0.8 && relation.trust * 0.4 + relation.opinion * 0.15 +
    character.cooperation * 25 + (request.defensive ? 20 : character.aggression * 20 - 10) - wars * 15 >= 55;
}
export function respondToAlliedWarRequest(world: WorldState, allyId: NationId, requestId: number, accept: boolean): boolean {
  if (getWarDeclarationMode(world) !== "diplomacy") return false;
  const request = world.alliedWarRequests?.requests.find((item) => item.id === requestId && item.allyId === allyId && item.status === "pending");
  if (!request) return false;
  const war = findWar(world.wars, request.callerId, request.enemyId);
  if (world.time.slowTick >= request.expiresAtSlowTick) { request.status = "expired"; return false; }
  if (!war || war.id !== request.rootWarId || war.startedAtFastTick !== request.rootStartedAt || !eligible(world, request.callerId, allyId, request.enemyId)) {
    request.status = "stale"; return false;
  }
  if (accept) {
    if (!startDiplomaticWar(world, allyId, request.enemyId, "allied-request")) return false;
    request.status = "accepted";
    const relation = getRelation(world, request.callerId, allyId); relation.trust = Math.min(100, relation.trust + 5);
  } else {
    request.status = "declined";
    const relation = getRelation(world, request.callerId, allyId); relation.trust = Math.max(0, relation.trust - (request.defensive ? 3 : 1));
  }
  recordSimulationEvent(world, { category: "military", nationIds: [request.callerId, allyId, request.enemyId], message: `${allyId} ${request.status} the call to war against ${request.enemyId}.` });
  return true;
}
export function updateAlliedWarRequests(world: WorldState): void {
  if (getWarDeclarationMode(world) !== "diplomacy") {
    for (const request of world.alliedWarRequests?.requests ?? []) if (request.status === "pending") request.status = "withdrawn";
    return;
  }
  const state = getAlliedWarRequests(world), now = world.time.slowTick;
  for (const request of state.requests) if (request.status === "pending") {
    const war = findWar(world.wars, request.callerId, request.enemyId);
    if (now >= request.expiresAtSlowTick) request.status = "expired";
    else if (!war || war.id !== request.rootWarId || war.startedAtFastTick !== request.rootStartedAt) request.status = "stale";
    else if (findWar(world.wars, request.allyId, request.enemyId) && !findWar(world.wars, request.callerId, request.allyId)) request.status = "accepted";
    else if (!eligible(world, request.callerId, request.allyId, request.enemyId)) request.status = "stale";
    else if (request.allyId !== getManualGovernmentId(world) && now - request.createdAtSlowTick >= 10) respondToAlliedWarRequest(world, request.allyId, request.id, willAcceptAlliedWarRequest(world, request));
  }
  if (now - state.lastAISlowTick < 30) return;
  state.lastAISlowTick = now;
  for (const war of [...world.wars]) {
    if (["allied-request", "faction-obligation", "defensive-alliance", "subject-uprising"].includes(war.cause ?? "")) continue;
    for (const caller of [war.defenderId, war.aggressorId]) {
      const enemy = caller === war.defenderId ? war.aggressorId : war.defenderId;
      const ally = world.nations.find((nation) => eligible(world, caller, nation.id, enemy));
      if (ally && requestAlliedWarEntry(world, caller, ally.id, enemy)) break;
    }
  }
}

export function withdrawAlliedWarRequest(world: WorldState, callerId: NationId, requestId: number): boolean {
  const request = world.alliedWarRequests?.requests.find((item) => item.id === requestId && item.callerId === callerId && item.status === "pending");
  if (!request) return false; request.status = "withdrawn";
  recordSimulationEvent(world, { category: "military", nationIds: [callerId, request.allyId], message: `${callerId} withdrew its call to war.` });
  return true;
}
