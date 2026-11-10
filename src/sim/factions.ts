import { getManualGovernmentId } from "./player-nation";
import { getSubjectOverlord } from "./subject-governments";
import { setPoliticalMandate } from "./politics";
import { getIdeologicalAffinity } from "./ideology-relations";
import type { NationId } from "../worldgen/nation";
import { breakTreaty, getRelation, spendInfluence, getInfluence } from "./diplomacy";
import { startDiplomaticWar, getNationalMilitaryStrength } from "./diplomatic-crises";
import { getNationCharacter } from "./nation-character";
import { getIdeologies, getNationIdeology, getNationName, identityHash } from "./nation-identity";
import { isNationActive, isNationPresent } from "./nation-active";
import { getWarDeclarationMode, recordSimulationEvent } from "./simulation-settings";
import { findWar, type WarState } from "./war-state";
import type { WorldState } from "./world-state";

export type WarObligation = "mandatory" | "voluntary" | "none";
export interface FactionCharter {
  allowedIdeologyIds: string[];
  defensiveObligation: WarObligation;
  offensiveObligation: WarObligation;
  considerPersonality: boolean;
  jointPeaceOnly?: boolean;
}
export interface Faction {
  id: string; name: string; founderId: NationId; leaderId: NationId; memberIds: NationId[];
  charter: FactionCharter; createdAtSlowTick: number;
}
export interface FactionState {
  factions: Faction[]; factionByNationId: Map<NationId, Faction>; nextFactionNumber: number;
  lastAISlowTick: number; handledCalls: Set<string>; version: number; interventions: number;
  membershipSince: Map<NationId, number>; cohesionFailures: Map<NationId, number>; aiDefections: number;
}
export function getFactionState(world: WorldState): FactionState {
  const state = world.factions ??= { factions: [], factionByNationId: new Map(), nextFactionNumber: 0,
    lastAISlowTick: -30, handledCalls: new Set(), version: 0, interventions: 0, membershipSince: new Map(), cohesionFailures: new Map(), aiDefections: 0 };
  state.membershipSince ??= new Map(); state.cohesionFailures ??= new Map(); state.aiDefections ??= 0;
  return state;
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
  if (getWarDeclarationMode(world) !== "diplomacy" || getNationFaction(world, founderId) || getSubjectOverlord(world, founderId) ||
    !world.nations.some((nation) => nation.id === founderId && isNationActive(nation))) return null;
  const allowed = [...new Set(charter.allowedIdeologyIds)];
  if (!allowed.length || allowed.some((id) => !getIdeologies(world).some((item) => item.id === id)) ||
    !allowed.includes(getNationIdeology(world, founderId).id) ||
    ![charter.defensiveObligation, charter.offensiveObligation].every((value) => ["mandatory", "voluntary", "none"].includes(value)) ||
    typeof charter.considerPersonality !== "boolean") return null;
  const suffix = ["Accord", "League", "Pact", "Union"][identityHash(founderId) % 4];
  const requested = requestedName.trim().replace(/\s+/g, " "), baseName = requested || `${getNationName(world, founderId)} ${suffix}`;
  const state = getFactionState(world);
  let name = baseName, ordinal = 2;
  if (!requested) while (state.factions.some((faction) => faction.name.toLowerCase() === name.toLowerCase())) name = `${baseName} ${ordinal++}`;
  if (name.length > 60 || name.length < 3 || state.factions.some((faction) => faction.name.toLowerCase() === name.toLowerCase()) ||
    !spendInfluence(world, founderId, 20)) return null;
  const faction: Faction = { id: `faction-${state.nextFactionNumber++}`, name, founderId, leaderId: founderId,
    memberIds: [founderId], charter: { ...charter, allowedIdeologyIds: allowed }, createdAtSlowTick: world.time.slowTick };
  state.factions.push(faction); state.factionByNationId.set(founderId, faction); state.membershipSince.set(founderId, world.time.slowTick); state.version += 1;
  recordSimulationEvent(world, { category: "diplomacy", nationIds: [founderId], message: `${getNationName(world, founderId)} founded ${name}.` });
  return faction;
}
export function getFactionAdmissionRequirements(world: WorldState, nationId: NationId, memberId: NationId) {
  const affinity = getIdeologicalAffinity(world, nationId, memberId), friction = Math.max(0, -affinity);
  return { affinity, opinion: Math.ceil(15 + friction * 30), trust: Math.ceil(35 + friction * 30) };
}
export function getFactionAdmissionIssue(world: WorldState, nationId: NationId, faction: Faction): string | null {
  if (getWarDeclarationMode(world) !== "diplomacy") return "Diplomacy is disabled.";
  if (getSubjectOverlord(world, nationId)) return "Subject governments cannot join independent factions.";
  if (getNationFaction(world, nationId)) return "Already a faction member.";
  if (!world.nations.some((nation) => nation.id === nationId && isNationActive(nation))) return "Nation is inactive.";
  if (!faction.charter.allowedIdeologyIds.includes(getNationIdeology(world, nationId).id)) return "Ideology is outside this charter.";
  for (const member of faction.memberIds) {
    if (findWar(world.wars, nationId, member)) return "At war with a member.";
    const relation = getRelation(world, nationId, member), requirements = getFactionAdmissionRequirements(world, nationId, member);
    if (relation.crisis) return `An ultimatum with ${getNationName(world, member)} blocks entry.`;
    if (relation.opinion < requirements.opinion || relation.trust < requirements.trust) return `Requires opinion ${requirements.opinion} and trust ${requirements.trust} with ${getNationName(world, member)}.`;
  }
  return factionWillingness(world, nationId, faction.charter) < 40 ? "Personality rejects this charter's obligations." : null;
}
export function canJoinFaction(world: WorldState, nationId: NationId, faction: Faction): boolean {
  return getFactionAdmissionIssue(world, nationId, faction) === null;
}
export function getFactionCohesion(world: WorldState, faction: Faction) {
  let affinity = 0, opinion = 0, trust = 0, pairs = 0;
  for (let i = 0; i < faction.memberIds.length; i++) for (let j = i + 1; j < faction.memberIds.length; j++) {
    const a = faction.memberIds[i], b = faction.memberIds[j], relation = getRelation(world, a, b);
    affinity += getIdeologicalAffinity(world, a, b); opinion += relation.opinion; trust += relation.trust; pairs++;
  }
  return { affinity: pairs ? affinity / pairs : 1, opinion: pairs ? opinion / pairs : 0, trust: pairs ? trust / pairs : 40 };
}
function commonEnemy(world: WorldState, a: NationId, b: NationId): boolean {
  const enemies = new Set(world.wars.filter((war) => war.nationAId === a || war.nationBId === a).map((war) => war.nationAId === a ? war.nationBId : war.nationAId));
  return world.wars.some((war) => (war.nationAId === b && enemies.has(war.nationBId)) || (war.nationBId === b && enemies.has(war.nationAId)));
}
export function factionJoinScore(world: WorldState, nationId: NationId, faction: Faction): number {
  if (!canJoinFaction(world, nationId, faction)) return -Infinity;
  const members = faction.memberIds, size = Math.max(1, members.length), active = Math.max(1, world.nations.filter(isNationActive).length);
  let affinity = 0, opinion = 0, trust = 0, threats = 0;
  for (const member of members) {
    const relation = getRelation(world, nationId, member);
    affinity += getIdeologicalAffinity(world, nationId, member); opinion += relation.opinion; trust += relation.trust;
    if (commonEnemy(world, nationId, member)) threats++;
  }
  const coverage = members.length / active, dominance = coverage * 25 + Math.max(0, coverage - 0.5) * 35;
  const independence = (1 - getNationCharacter(world, nationId).cooperation) * 8;
  const opposedWithoutCause = members.some((id) => getIdeologicalAffinity(world, nationId, id) <= -0.75 &&
    getRelation(world, nationId, id).opinion < 70 && !commonEnemy(world, nationId, id));
  return 50 + affinity / size * 20 + opinion / size * 0.25 + trust / size * 0.15 + (threats ? 25 : 0) - dominance - independence - (opposedWithoutCause ? 25 : 0);
}
export function joinFaction(world: WorldState, nationId: NationId, factionId: string): boolean {
  const faction = world.factions?.factions.find((item) => item.id === factionId);
  if (!faction || !canJoinFaction(world, nationId, faction) || !spendInfluence(world, nationId, 5)) return false;
  faction.memberIds.push(nationId); faction.memberIds.sort();
  const state = getFactionState(world); state.factionByNationId.set(nationId, faction); state.membershipSince.set(nationId, world.time.slowTick); state.cohesionFailures.delete(nationId); state.version += 1;
  recordSimulationEvent(world, { category: "diplomacy", nationIds: [nationId, faction.leaderId], message: `${getNationName(world, nationId)} joined ${faction.name}.` });
  return true;
}
/** A stable government leads until it withdraws, capitulates, or voluntarily hands over. */
export function getFactionSuccessors(world: WorldState, faction: Faction): NationId[] {
  return faction.memberIds.filter((id) => world.nations.some((nation) => nation.id === id && isNationActive(nation)))
    .sort((a, b) => {
      const score = (id: NationId) => {
        const nation = world.nations.find((item) => item.id === id)!;
        const confidence = faction.memberIds.filter((member) => member !== id).reduce((sum, member) => sum + getRelation(world, id, member).trust, 0);
        return Math.sqrt(getNationalMilitaryStrength(world, id)) + nation.macroRegionIds.length * 5 + confidence * 0.1;
      };
      return score(b) - score(a) || a.localeCompare(b);
    });
}
export function ensureFactionLeadership(world: WorldState, faction: Faction): void {
  if (faction.memberIds.includes(faction.leaderId) && world.nations.some((nation) => nation.id === faction.leaderId && isNationActive(nation))) return;
  const recognized = faction.memberIds.filter((id) => world.nations.some((nation) => nation.id === id && isNationPresent(world, nation))).sort();
  const successor = getFactionSuccessors(world, faction)[0] ?? (recognized.includes(faction.leaderId) ? faction.leaderId : recognized[0]);
  if (!successor) {
    const state = getFactionState(world);
    state.factions = state.factions.filter((item) => item !== faction);
    for (const id of faction.memberIds) { state.factionByNationId.delete(id); state.membershipSince.delete(id); state.cohesionFailures.delete(id); }
    state.version++;
    recordSimulationEvent(world, { category: "diplomacy", nationIds: faction.memberIds,
      message: `${faction.name} dissolved after losing every recognized member government.` });
    return;
  }
  if (successor === faction.leaderId) return;
  const previous = faction.leaderId; faction.leaderId = successor; getFactionState(world).version++;
  recordSimulationEvent(world, { category: "diplomacy", nationIds: [previous, successor],
    message: `${getNationName(world, successor)} succeeded ${getNationName(world, previous)} as leader of ${faction.name}.` });
}
export function updateFactionGovernments(world: WorldState): void {
  if (!world.factions) return;
  for (const faction of [...world.factions.factions]) {
    for (const id of [...faction.memberIds]) if (!world.nations.some((nation) => nation.id === id && isNationPresent(world, nation)))
      leaveFaction(world, id, "government collapsed");
    if (world.factions.factions.includes(faction)) ensureFactionLeadership(world, faction);
  }
}
export function transferFactionLeadership(world: WorldState, leaderId: NationId, successorId: NationId): boolean {
  const faction = getNationFaction(world, leaderId);
  if (getWarDeclarationMode(world) !== "diplomacy" || !faction || faction.leaderId !== leaderId || leaderId === successorId ||
    !faction.memberIds.includes(successorId) || !getFactionSuccessors(world, faction).includes(successorId)) return false;
  const relation = getRelation(world, leaderId, successorId);
  if (relation.opinion < 25 || relation.trust < 55 || !spendInfluence(world, leaderId, 10)) return false;
  faction.leaderId = successorId; getFactionState(world).version++;
  recordSimulationEvent(world, { category: "diplomacy", nationIds: [leaderId, successorId],
    message: `${getNationName(world, leaderId)} handed leadership of ${faction.name} to ${getNationName(world, successorId)}.` });
  return true;
}
export function expelFactionMember(world: WorldState, leaderId: NationId, memberId: NationId): boolean {
  const faction = getNationFaction(world, leaderId);
  if (getWarDeclarationMode(world) !== "diplomacy" || !faction || faction.leaderId !== leaderId || leaderId === memberId ||
    !faction.memberIds.includes(memberId) || faction.memberIds.some((id) => world.exileGovernments?.byNationId.get(id)?.status === "exiled" || world.wars.some((war) => war.nationAId === id || war.nationBId === id)) ||
    !spendInfluence(world, leaderId, 10)) return false;
  return leaveFaction(world, memberId, `expelled by leader ${getNationName(world, leaderId)}`);
}
export function leaveFaction(world: WorldState, nationId: NationId, reason = "withdrawal"): boolean {
  const faction = getNationFaction(world, nationId);
  if (!faction) return false;
  const state = getFactionState(world);
  faction.memberIds = faction.memberIds.filter((id) => id !== nationId); state.factionByNationId.delete(nationId);
  state.membershipSince.delete(nationId); state.cohesionFailures.delete(nationId);
  if (reason === "diplomatic cohesion collapsed") state.aiDefections++;
  for (const id of faction.memberIds) {
    const relation = getRelation(world, nationId, id);
    relation.trust = Math.max(0, relation.trust - 10); relation.opinion = Math.max(-100, relation.opinion - 8);
  }
  if (!faction.memberIds.length) state.factions = state.factions.filter((item) => item !== faction);
  else ensureFactionLeadership(world, faction);
  state.version += 1;
  recordSimulationEvent(world, { category: "diplomacy", nationIds: [nationId], message: `${getNationName(world, nationId)} left ${faction.name} (${reason}).` });
  return true;
}
export function setNationIdeology(world: WorldState, nationId: NationId, ideologyId: string): boolean {
  const nation = world.nations.find((item) => item.id === nationId && isNationActive(item));
  const faction = getNationFaction(world, nationId);
  if (!nation || !getIdeologies(world).some((item) => item.id === ideologyId) ||
    (faction && !faction.charter.allowedIdeologyIds.includes(ideologyId))) return false;
  setPoliticalMandate(world, nation, ideologyId);
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
  return faction.memberIds.filter((id) => id !== nationId && world.nations.some((nation) => nation.id === id && isNationActive(nation)) && (faction.charter.defensiveObligation === "mandatory" || getNationCharacter(world, id).cooperation >= 0.6));
}
function callMembers(world: WorldState, war: WarState, principal: NationId, enemy: NationId, defensive: boolean): { id: NationId; forced: boolean }[] {
  const result = [{ id: principal, forced: false }], faction = getNationFaction(world, principal);
  if (!faction) return result;
  const obligation = defensive ? faction.charter.defensiveObligation : faction.charter.offensiveObligation;
  if (obligation === "none") return result;
  const state = getFactionState(world);
  for (const member of faction.memberIds) {
    if (member === principal || areFactionPartners(world, member, enemy) || !world.nations.some((nation) => nation.id === member && isNationActive(nation))) continue;
    const key = `${war.id}|${war.startedAtFastTick}|${member}|${defensive ? "defense" : "offense"}`;
    const alreadyFighting = !!findWar(world.wars, member, enemy);
    if (state.handledCalls.has(key) && !alreadyFighting) continue;
    if (member === getManualGovernmentId(world)) continue;
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
  const roots = world.wars.filter((war) => war.cause !== "allied-request" && war.cause !== "faction-obligation" &&
    war.cause !== "defensive-alliance" && war.cause !== "subject-uprising");
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
        if (relation.treaties.some((treaty) => treaty.type === "truce" && treaty.negotiatedPeace &&
          treaty.expiresAtSlowTick > world.time.slowTick)) continue;
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
function aiCharter(world: WorldState, nationId: NationId): FactionCharter {
  const character = getNationCharacter(world, nationId);
  return { allowedIdeologyIds: [getNationIdeology(world, nationId).id],
    defensiveObligation: character.cooperation >= 0.6 ? "mandatory" : "voluntary",
    offensiveObligation: character.aggression >= 0.75 ? "mandatory" : character.aggression >= 0.5 ? "voluntary" : "none", considerPersonality: true };
}
function reviewFactionCohesion(world: WorldState): void {
  const state = getFactionState(world);
  for (const nation of [...world.nations].sort((a, b) => a.id.localeCompare(b.id))) {
    const faction = getNationFaction(world, nation.id);
    if (!isNationActive(nation)) continue;
    if (!faction || faction.memberIds.length < 2) { state.cohesionFailures.delete(nation.id); continue; }
    const others = faction.memberIds.filter((id) => id !== nation.id);
    const friction = others.reduce((sum, id) => sum + getIdeologicalAffinity(world, nation.id, id), 0) / others.length;
    const opinion = others.reduce((sum, id) => sum + getRelation(world, nation.id, id).opinion, 0) / others.length;
    const trust = others.reduce((sum, id) => sum + getRelation(world, nation.id, id).trust, 0) / others.length;
    const sharedThreat = others.some((id) => commonEnemy(world, nation.id, id));
    const ideologicalDispute = others.some((id) => getIdeologicalAffinity(world, nation.id, id) <= -0.75 &&
      getRelation(world, nation.id, id).opinion < 60 && !commonEnemy(world, nation.id, id));
    const loyaltyThreshold = 45 + Math.max(0, -friction) * 12;
    const broken = opinion < -15 || trust < 25 || ideologicalDispute || (friction < -0.2 && opinion < loyaltyThreshold && !sharedThreat);
    const failures = broken ? (state.cohesionFailures.get(nation.id) ?? 0) + 1 : 0;
    state.cohesionFailures.set(nation.id, failures);
    if (failures >= 3 && world.time.slowTick - (state.membershipSince.get(nation.id) ?? faction.createdAtSlowTick) >= 120 &&
      !world.wars.some((war) => war.nationAId === nation.id || war.nationBId === nation.id)) leaveFaction(world, nation.id, "diplomatic cohesion collapsed");
  }
}
export function updateFactions(world: WorldState): void {
  if (getWarDeclarationMode(world) !== "diplomacy") return;
  const state = getFactionState(world);
  if (world.time.slowTick - state.lastAISlowTick < 30) return;
  state.lastAISlowTick = world.time.slowTick;
  const active = world.nations.filter(isNationActive).sort((a, b) => a.id.localeCompare(b.id)), activeIds = new Set(world.nations.filter((nation) => isNationPresent(world, nation)).map((nation) => nation.id));
  for (const faction of [...state.factions]) for (const id of [...faction.memberIds]) {
    if (!activeIds.has(id) || !faction.charter.allowedIdeologyIds.includes(getNationIdeology(world, id).id)) leaveFaction(world, id, "membership no longer eligible");
  }
  for (const faction of state.factions) ensureFactionLeadership(world, faction);
  reviewFactionCohesion(world);
  const player = getManualGovernmentId(world);
  for (const nation of active) {
    if (nation.id === player) continue;
    if (getNationFaction(world, nation.id)) continue;
    const candidate = state.factions.filter((faction) => faction.leaderId !== player).map((faction) => ({ faction, score: factionJoinScore(world, nation.id, faction) }))
      .sort((a, b) => b.score - a.score || a.faction.id.localeCompare(b.faction.id))[0];
    const charter = aiCharter(world, nation.id), character = getNationCharacter(world, nation.id);
    let founding: { partner: typeof nation; charter: FactionCharter; score: number } | undefined;
    if (getInfluence(world, nation.id) >= 20 && factionWillingness(world, nation.id, charter) >= 40) {
      for (const other of active) {
        if (other.id === player || other.id === nation.id || getNationFaction(world, other.id) || getInfluence(world, other.id) < 5 || findWar(world.wars, nation.id, other.id)) continue;
        const relation = getRelation(world, nation.id, other.id), affinity = getIdeologicalAffinity(world, nation.id, other.id);
        const sharedThreat = commonEnemy(world, nation.id, other.id);
        // Ideological blocs are the default; an exceptional shared-war coalition may admit one other ideology.
        if (affinity < 1 && (!sharedThreat || relation.opinion < 45 || relation.trust < 70)) continue;
        const proposed = { ...charter, allowedIdeologyIds: [...new Set([...charter.allowedIdeologyIds, getNationIdeology(world, other.id).id])] };
        const temporary: Faction = { id: "draft", name: "draft", founderId: nation.id, leaderId: nation.id, memberIds: [nation.id], charter: proposed, createdAtSlowTick: world.time.slowTick };
        if (!canJoinFaction(world, other.id, temporary)) continue;
        const score = 50 + affinity * 15 + relation.opinion * 0.2 + relation.trust * 0.1 + (sharedThreat ? 25 : 0);
        if (!founding || score > founding.score || (score === founding.score && other.id < founding.partner.id)) founding = { partner: other, charter: proposed, score };
      }
    }
    if (candidate && candidate.score >= 60 && (!founding || candidate.score >= founding.score) && joinFaction(world, nation.id, candidate.faction.id)) continue;
    if (founding) {
      const faction = createFaction(world, nation.id, founding.charter);
      if (faction) { joinFaction(world, founding.partner.id, faction.id); continue; }
    }
    // A country may form the nucleus of a counterweight to an ideologically hostile large bloc.
    const rival = state.factions.find((faction) => faction.memberIds.length >= 2 && faction.memberIds.length / active.length >= 0.35 &&
      getIdeologicalAffinity(world, nation.id, faction.leaderId) < -0.2 && getRelation(world, nation.id, faction.leaderId).opinion <= 15);
    if (rival && getInfluence(world, nation.id) >= 20 && factionWillingness(world, nation.id, charter) >= 40 &&
      (character.cooperation >= 0.4 || character.aggression >= 0.6)) createFaction(world, nation.id, charter);
  }
}
