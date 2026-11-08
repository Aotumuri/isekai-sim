import type { NationId } from "../worldgen/nation";
import { breakTreaty, getRelation, spendInfluence } from "./diplomacy";
import { startDiplomaticWar, getNationalMilitaryStrength } from "./diplomatic-crises";
import { getNationCharacter } from "./nation-character";
import { getIdeologies, getNationIdeology, getNationName, identityHash } from "./nation-identity";
import { isNationActive } from "./nation-active";
import { getWarDeclarationMode, recordSimulationEvent } from "./simulation-settings";
import { findWar, type WarState } from "./war-state";
import type { WorldState } from "./world-state";

export type WarObligation = "mandatory" | "voluntary" | "none";
export interface FactionCharter {
  allowedIdeologyIds: string[];
  defensiveObligation: WarObligation;
  offensiveObligation: WarObligation;
  considerPersonality: boolean;
}
export interface Faction {
  id: string; name: string; founderId: NationId; leaderId: NationId; memberIds: NationId[];
  charter: FactionCharter; createdAtSlowTick: number;
}
export interface FactionState {
  factions: Faction[]; factionByNationId: Map<NationId, Faction>; nextFactionNumber: number;
  lastAISlowTick: number; handledCalls: Set<string>; version: number; interventions: number;
}
export function getFactionState(world: WorldState): FactionState {
  return world.factions ??= { factions: [], factionByNationId: new Map(), nextFactionNumber: 0,
    lastAISlowTick: -30, handledCalls: new Set(), version: 0, interventions: 0 };
}
export function getNationFaction(world: WorldState, id: NationId): Faction | undefined { return world.factions?.factionByNationId.get(id); }
export function areFactionPartners(world: WorldState, a: NationId, b: NationId): boolean {
  const faction = getNationFaction(world, a);
  return a !== b && !!faction && faction === getNationFaction(world, b);
}
export function factionWillingness(world: WorldState, nationId: NationId, charter: FactionCharter): number {
  if (!charter.considerPersonality) return 100;
  const character = getNationCharacter(world, nationId);
  return 30 + character.cooperation * 50 +
    (charter.defensiveObligation === "mandatory" ? (character.doctrine === "guardian" ? 15 : -5) : 5) +
    (charter.offensiveObligation === "mandatory" ? character.aggression * 55 - 40 : 10) -
    (character.doctrine === "isolationist" ? 25 : 0) -
    world.wars.filter((war) => war.nationAId === nationId || war.nationBId === nationId).length * 8;
}
export function createFaction(world: WorldState, founderId: NationId, charter: FactionCharter, requestedName = ""): Faction | null {
  if (getWarDeclarationMode(world) !== "diplomacy" || getNationFaction(world, founderId) ||
    !world.nations.some((nation) => nation.id === founderId && isNationActive(nation))) return null;
  const allowed = [...new Set(charter.allowedIdeologyIds)];
  if (!allowed.length || allowed.some((id) => !getIdeologies(world).some((item) => item.id === id)) ||
    !allowed.includes(getNationIdeology(world, founderId).id) ||
    ![charter.defensiveObligation, charter.offensiveObligation].every((value) => ["mandatory", "voluntary", "none"].includes(value)) ||
    typeof charter.considerPersonality !== "boolean") return null;
  const suffix = ["Accord", "League", "Pact", "Union"][identityHash(founderId) % 4];
  const name = requestedName.trim().replace(/\s+/g, " ") || `${getNationName(world, founderId)} ${suffix}`;
  const state = getFactionState(world);
  if (name.length > 60 || name.length < 3 || state.factions.some((faction) => faction.name.toLowerCase() === name.toLowerCase()) ||
    !spendInfluence(world, founderId, 20)) return null;
  const faction: Faction = { id: `faction-${state.nextFactionNumber++}`, name, founderId, leaderId: founderId,
    memberIds: [founderId], charter: { ...charter, allowedIdeologyIds: allowed }, createdAtSlowTick: world.time.slowTick };
  state.factions.push(faction); state.factionByNationId.set(founderId, faction); state.version += 1;
  recordSimulationEvent(world, { category: "diplomacy", nationIds: [founderId], message: `${getNationName(world, founderId)} founded ${name}.` });
  return faction;
}
export function canJoinFaction(world: WorldState, nationId: NationId, faction: Faction): boolean {
  if (getWarDeclarationMode(world) !== "diplomacy" || getNationFaction(world, nationId) ||
    !world.nations.some((nation) => nation.id === nationId && isNationActive(nation)) ||
    !faction.charter.allowedIdeologyIds.includes(getNationIdeology(world, nationId).id)) return false;
  const relation = getRelation(world, nationId, faction.leaderId);
  return relation.opinion >= 15 && relation.trust >= 35 && !relation.crisis &&
    !faction.memberIds.some((member) => findWar(world.wars, nationId, member)) && factionWillingness(world, nationId, faction.charter) >= 40;
}
export function joinFaction(world: WorldState, nationId: NationId, factionId: string): boolean {
  const faction = world.factions?.factions.find((item) => item.id === factionId);
  if (!faction || !canJoinFaction(world, nationId, faction) || !spendInfluence(world, nationId, 5)) return false;
  faction.memberIds.push(nationId); faction.memberIds.sort();
  getFactionState(world).factionByNationId.set(nationId, faction); getFactionState(world).version += 1;
  recordSimulationEvent(world, { category: "diplomacy", nationIds: [nationId, faction.leaderId], message: `${getNationName(world, nationId)} joined ${faction.name}.` });
  return true;
}
export function leaveFaction(world: WorldState, nationId: NationId, reason = "withdrawal"): boolean {
  const faction = getNationFaction(world, nationId);
  if (!faction) return false;
  const state = getFactionState(world);
  faction.memberIds = faction.memberIds.filter((id) => id !== nationId); state.factionByNationId.delete(nationId);
  for (const id of faction.memberIds) {
    const relation = getRelation(world, nationId, id);
    relation.trust = Math.max(0, relation.trust - 10); relation.opinion = Math.max(-100, relation.opinion - 8);
  }
  if (!faction.memberIds.length) state.factions = state.factions.filter((item) => item !== faction);
  else if (faction.leaderId === nationId) faction.leaderId = faction.memberIds[0]!;
  state.version += 1;
  recordSimulationEvent(world, { category: "diplomacy", nationIds: [nationId], message: `${getNationName(world, nationId)} left ${faction.name} (${reason}).` });
  return true;
}
export function setNationIdeology(world: WorldState, nationId: NationId, ideologyId: string): boolean {
  const nation = world.nations.find((item) => item.id === nationId && isNationActive(item));
  const faction = getNationFaction(world, nationId);
  if (!nation || !getIdeologies(world).some((item) => item.id === ideologyId) ||
    (faction && !faction.charter.allowedIdeologyIds.includes(ideologyId))) return false;
  nation.ideologyId = ideologyId;
  recordSimulationEvent(world, { category: "diplomacy", nationIds: [nationId], message: `${getNationName(world, nationId)} adopted ${getNationIdeology(world, nationId).name}.` });
  return true;
}
function voluntaryCallAccepted(world: WorldState, member: NationId, enemy: NationId, defensive: boolean): boolean {
  const character = getNationCharacter(world, member);
  return world.wars.filter((war) => war.nationAId === member || war.nationBId === member).length < 2 &&
    (defensive ? character.cooperation >= 0.6 : character.aggression >= 0.65) &&
    getNationalMilitaryStrength(world, member) >= getNationalMilitaryStrength(world, enemy) * 0.35;
}
export function getFactionDefenders(world: WorldState, nationId: NationId): NationId[] {
  const faction = getNationFaction(world, nationId);
  if (!faction || faction.charter.defensiveObligation === "none") return [];
  return faction.memberIds.filter((id) => id !== nationId && (faction.charter.defensiveObligation === "mandatory" || getNationCharacter(world, id).cooperation >= 0.6));
}
function callMembers(world: WorldState, war: WarState, principal: NationId, enemy: NationId, defensive: boolean): { id: NationId; forced: boolean }[] {
  const result = [{ id: principal, forced: false }], faction = getNationFaction(world, principal);
  if (!faction) return result;
  const obligation = defensive ? faction.charter.defensiveObligation : faction.charter.offensiveObligation;
  if (obligation === "none") return result;
  const state = getFactionState(world);
  for (const member of faction.memberIds) {
    if (member === principal || areFactionPartners(world, member, enemy)) continue;
    const key = `${war.id}|${war.startedAtFastTick}|${member}|${defensive ? "defense" : "offense"}`;
    const alreadyFighting = !!findWar(world.wars, member, enemy);
    if (state.handledCalls.has(key) && !alreadyFighting) continue;
    const accepts = obligation === "mandatory" || voluntaryCallAccepted(world, member, enemy, defensive);
    if (!state.handledCalls.has(key)) {
      state.handledCalls.add(key);
      recordSimulationEvent(world, { category: "diplomacy", nationIds: [principal, member, enemy],
        message: `${getNationName(world, member)} ${accepts ? "accepted" : "declined"} ${faction.name}'s ${obligation} ${defensive ? "defensive" : "offensive"} call.` });
    }
    if (accepts || alreadyFighting) result.push({ id: member, forced: obligation === "mandatory" });
  }
  return result;
}
export function updateFactionWarCalls(world: WorldState): void {
  if (getWarDeclarationMode(world) !== "diplomacy" || !world.factions) return;
  const state = world.factions;
  const roots = world.wars.filter((war) => war.cause !== "faction-obligation" && war.cause !== "defensive-alliance");
  const livePrefixes = roots.map((war) => `${war.id}|${war.startedAtFastTick}|`);
  for (const key of state.handledCalls) if (!livePrefixes.some((prefix) => key.startsWith(prefix))) state.handledCalls.delete(key);
  for (const war of roots) {
    if (areFactionPartners(world, war.aggressorId, war.defenderId)) leaveFaction(world, war.aggressorId, "war against a member");
    const attackers = callMembers(world, war, war.aggressorId, war.defenderId, false);
    const defenders = callMembers(world, war, war.defenderId, war.aggressorId, true);
    for (const attacker of attackers) for (const defender of defenders) {
      if (findWar(world.wars, attacker.id, defender.id) || areFactionPartners(world, attacker.id, defender.id)) continue;
      const forced = attacker.forced || defender.forced;
      const initiator = defender.forced && !attacker.forced ? defender.id : attacker.id === war.aggressorId ? defender.id : attacker.id;
      const target = initiator === attacker.id ? defender.id : attacker.id;
      if (forced) {
        const relation = getRelation(world, attacker.id, defender.id);
        for (const treaty of [...relation.treaties]) if (treaty.type !== "truce") breakTreaty(world, initiator, target, treaty.type);
        if (relation.treaties.some((treaty) => treaty.type === "truce")) {
          relation.treaties = relation.treaties.filter((treaty) => treaty.type !== "truce");
          relation.trust = 0; relation.grievance = Math.min(100, relation.grievance + 30);
          recordSimulationEvent(world, { category: "diplomacy", nationIds: [attacker.id, defender.id], message: "A mandatory faction call broke a prior truce." });
        }
      }
      if (startDiplomaticWar(world, initiator, target, "faction-obligation")) state.interventions += 1;
    }
  }
}
export function updateFactions(world: WorldState): void {
  if (getWarDeclarationMode(world) !== "diplomacy") return;
  const state = getFactionState(world);
  if (world.time.slowTick - state.lastAISlowTick < 30) return;
  state.lastAISlowTick = world.time.slowTick;
  const active = world.nations.filter(isNationActive), activeIds = new Set(active.map((nation) => nation.id));
  for (const faction of [...state.factions]) for (const id of [...faction.memberIds]) {
    if (!activeIds.has(id) || !faction.charter.allowedIdeologyIds.includes(getNationIdeology(world, id).id)) leaveFaction(world, id, "membership no longer eligible");
  }
  for (const nation of active) {
    if (getNationFaction(world, nation.id)) continue;
    const candidate = state.factions.find((faction) => canJoinFaction(world, nation.id, faction));
    if (candidate && joinFaction(world, nation.id, candidate.id)) continue;
    const character = getNationCharacter(world, nation.id);
    const charter: FactionCharter = {
      allowedIdeologyIds: character.cooperation >= 0.7 ? getIdeologies(world).map((item) => item.id) : [getNationIdeology(world, nation.id).id],
      defensiveObligation: character.cooperation >= 0.6 ? "mandatory" : "voluntary",
      offensiveObligation: character.aggression >= 0.75 ? "mandatory" : character.aggression >= 0.5 ? "voluntary" : "none", considerPersonality: true,
    };
    const partner = active.find((other) => other.id !== nation.id && !getNationFaction(world, other.id) &&
      charter.allowedIdeologyIds.includes(getNationIdeology(world, other.id).id) &&
      getRelation(world, nation.id, other.id).opinion >= 20 && factionWillingness(world, other.id, charter) >= 40 && !findWar(world.wars, nation.id, other.id));
    if (partner) { const faction = createFaction(world, nation.id, charter); if (faction) joinFaction(world, partner.id, faction.id); }
  }
}
