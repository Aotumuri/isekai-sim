import { areFactionPartners } from "./factions";
import type { NationId } from "../worldgen/nation";
import { getNationCharacter } from "./nation-character";
import { isNationActive } from "./nation-active";
import { getWarDeclarationMode, recordSimulationEvent } from "./simulation-settings";
import { getAdjacentNationPairs } from "./world-cache";
import { buildWarAdjacency, isAtWar, normalizeWarPair } from "./war-state";
import type { WorldState } from "./world-state";

export type TreatyType = "non-aggression" | "trade" | "alliance" | "truce";
export interface Treaty { type: TreatyType; expiresAtSlowTick: number }
export interface DiplomaticCrisis {
  aggressorId: NationId;
  openedAtSlowTick: number;
  deadlineSlowTick: number;
  demand: "concessions" | "containment";
}
export interface DiplomaticRelation {
  nationAId: NationId;
  nationBId: NationId;
  opinion: number;
  trust: number;
  tension: number;
  grievance: number;
  treaties: Treaty[];
  crisis: DiplomaticCrisis | null;
  cooldownUntilSlowTick: number;
}
export interface DiplomacyState {
  relations: Map<string, DiplomaticRelation>;
  influenceByNationId: Map<NationId, number>;
  fatigueByWarId: Map<string, number>;
  lastRelationsSlowTick: number;
  lastCrisisSlowTick: number;
  lastPeaceSlowTick: number;
  lastTradeSlowTick: number;
  lastAidSlowTick: number;
  treatiesSigned: number;
  declarations: number;
  crisesOpened: number;
  crisesResolved: number;
  peaceAgreements: number;
  defensiveInterventions: number;
  tradeDeliveries: number;
  aidDeliveries: number;
}

export function getDiplomacyState(world: WorldState): DiplomacyState {
  return world.diplomacy ??= { relations: new Map(), influenceByNationId: new Map(),
    fatigueByWarId: new Map(), lastRelationsSlowTick: -10, lastCrisisSlowTick: -10, lastPeaceSlowTick: -10,
    lastTradeSlowTick: -20, lastAidSlowTick: -30, treatiesSigned: 0, declarations: 0,
    crisesOpened: 0, crisesResolved: 0, peaceAgreements: 0, defensiveInterventions: 0,
    tradeDeliveries: 0, aidDeliveries: 0 };
}

export function relationKey(a: NationId, b: NationId): string { return normalizeWarPair(a, b).join(":"); }
export function getRelation(world: WorldState, a: NationId, b: NationId): DiplomaticRelation {
  const state = getDiplomacyState(world);
  const key = relationKey(a, b);
  let relation = state.relations.get(key);
  if (!relation) {
    const [nationAId, nationBId] = normalizeWarPair(a, b);
    const first = getNationCharacter(world, a), second = getNationCharacter(world, b);
    const affinity = (first.cooperation + second.cooperation - 1) * 35 -
      Math.abs(first.aggression - second.aggression) * 15;
    relation = { nationAId, nationBId, opinion: affinity, trust: 40, tension: 10,
      grievance: 0, treaties: [], crisis: null, cooldownUntilSlowTick: 0 };
    state.relations.set(key, relation);
  }
  return relation;
}

export function hasTreaty(world: WorldState, a: NationId, b: NationId, type: TreatyType): boolean {
  return getDiplomacyState(world).relations.get(relationKey(a, b))?.treaties.some((treaty) =>
    treaty.type === type && treaty.expiresAtSlowTick > world.time.slowTick) ?? false;
}
export function isDiplomaticallyProtected(world: WorldState, a: NationId, b: NationId): boolean {
  return areFactionPartners(world, a, b) || (["truce", "non-aggression", "alliance"] as const).some((type) => hasTreaty(world, a, b, type));
}
export function getInfluence(world: WorldState, nationId: NationId): number {
  const influence = getDiplomacyState(world).influenceByNationId;
  if (!influence.has(nationId)) influence.set(nationId, 30);
  return influence.get(nationId)!;
}
export function spendInfluence(world: WorldState, nationId: NationId, amount: number): boolean {
  const available = getInfluence(world, nationId);
  if (available < amount) return false;
  getDiplomacyState(world).influenceByNationId.set(nationId, available - amount);
  return true;
}

export function proposeTreaty(world: WorldState, proposerId: NationId, partnerId: NationId,
  type: Exclude<TreatyType, "truce">): boolean {
  if (getWarDeclarationMode(world) !== "diplomacy" || proposerId === partnerId) return false;
  if (![proposerId, partnerId].every((id) => world.nations.some((nation) => nation.id === id && isNationActive(nation)))) return false;
  if (isAtWar(proposerId, partnerId, buildWarAdjacency(world.wars)) || hasTreaty(world, proposerId, partnerId, type)) return false;
  const relation = getRelation(world, proposerId, partnerId);
  const threshold = type === "alliance" ? 55 : type === "non-aggression" ? 20 : 10;
  const cost = type === "alliance" ? 20 : type === "non-aggression" ? 12 : 8;
  if (relation.crisis || relation.opinion < threshold || relation.trust < (type === "alliance" ? 55 : 30) ||
    !spendInfluence(world, proposerId, cost)) return false;
  relation.treaties.push({ type, expiresAtSlowTick: world.time.slowTick + (type === "alliance" ? 600 : 400) });
  relation.trust = clamp(relation.trust + 5, 0, 100);
  relation.tension = Math.max(0, relation.tension - 15);
  getDiplomacyState(world).treatiesSigned += 1;
  recordSimulationEvent(world, { category: "diplomacy", nationIds: [proposerId, partnerId],
    message: `${proposerId} and ${partnerId} signed ${type}.` });
  return true;
}

export function breakTreaty(world: WorldState, breakerId: NationId, partnerId: NationId, type: TreatyType): boolean {
  const relation = getRelation(world, breakerId, partnerId);
  if (!hasTreaty(world, breakerId, partnerId, type) || type === "truce") return false;
  relation.treaties = relation.treaties.filter((treaty) => treaty.type !== type);
  relation.opinion = clamp(relation.opinion - 25, -100, 100);
  relation.trust = Math.max(0, relation.trust - 25);
  relation.grievance = Math.min(100, relation.grievance + 20);
  relation.tension = Math.min(100, relation.tension + 15);
  relation.cooldownUntilSlowTick = world.time.slowTick + 40;
  // Breaking a promise is visible to other partners too.
  for (const other of getDiplomacyState(world).relations.values()) {
    if (other !== relation && (other.nationAId === breakerId || other.nationBId === breakerId)) other.trust = Math.max(0, other.trust - 5);
  }
  recordSimulationEvent(world, { category: "diplomacy", nationIds: [breakerId, partnerId],
    message: `${breakerId} broke the ${type} treaty with ${partnerId}.` });
  return true;
}

export function improveRelations(world: WorldState, nationId: NationId, partnerId: NationId): boolean {
  if (getWarDeclarationMode(world) !== "diplomacy" || nationId === partnerId ||
    isAtWar(nationId, partnerId, buildWarAdjacency(world.wars))) return false;
  if (![nationId, partnerId].every((id) => world.nations.some((nation) => nation.id === id && isNationActive(nation)))) return false;
  if (!spendInfluence(world, nationId, 10)) return false;
  const relation = getRelation(world, nationId, partnerId);
  relation.opinion = Math.min(100, relation.opinion + 10);
  relation.trust = Math.min(100, relation.trust + 3);
  relation.tension = Math.max(0, relation.tension - 8);
  recordSimulationEvent(world, { category: "diplomacy", nationIds: [nationId, partnerId],
    message: `${nationId} sent a diplomatic mission to ${partnerId}.` });
  return true;
}

export function updateDiplomaticRelations(world: WorldState): void {
  if (getWarDeclarationMode(world) !== "diplomacy") return;
  const state = getDiplomacyState(world), now = world.time.slowTick;
  if (now - state.lastRelationsSlowTick < 10) return;
  state.lastRelationsSlowTick = now;
  const active = new Set(world.nations.filter(isNationActive).map((nation) => nation.id));
  for (const id of active) state.influenceByNationId.set(id, Math.min(100, getInfluence(world, id) + 3));
  const contacts = [...getAdjacentNationPairs(world), ...world.strategicThreatObservation.exposures.map((exposure) =>
    [exposure.observerNationId, exposure.threatNationId] as [NationId, NationId])];
  for (const [a, b] of contacts) if (active.has(a) && active.has(b) && a !== b) getRelation(world, a, b);
  const wars = buildWarAdjacency(world.wars);
  for (const [key, relation] of state.relations) {
    const a = relation.nationAId, b = relation.nationBId;
    if (!active.has(a) || !active.has(b)) { state.relations.delete(key); continue; }
    const expired = relation.treaties.filter((treaty) => treaty.expiresAtSlowTick <= now);
    for (const treaty of expired) recordSimulationEvent(world, { category: "diplomacy", nationIds: [a, b],
      message: `${a} and ${b}: ${treaty.type} expired.` });
    relation.treaties = relation.treaties.filter((treaty) => treaty.expiresAtSlowTick > now);
    if (isAtWar(a, b, wars)) { relation.opinion = Math.max(-100, relation.opinion - 3); continue; }
    const first = getNationCharacter(world, a), second = getNationCharacter(world, b);
    const commonEnemy = [...(wars.get(a) ?? [])].some((enemy) => wars.get(b)?.has(enemy));
    const cooperation = (first.cooperation + second.cooperation) / 2;
    relation.opinion = clamp(relation.opinion + (cooperation - 0.5) * 3 + (commonEnemy ? 2 : 0) - relation.grievance * 0.015, -100, 100);
    relation.trust = clamp(relation.trust + (relation.treaties.length ? 0.8 : 0.1), 0, 100);
    relation.grievance = Math.max(0, relation.grievance - 0.2);
    relation.tension = clamp(relation.tension + (first.aggression + second.aggression - 0.9) * 2 -
      (relation.opinion > 20 ? 1.5 : 0) + relation.grievance * 0.03, 0, 100);
    if (relation.crisis) continue;
    if (relation.opinion >= 55 && relation.trust >= 55) proposeTreaty(world, a, b, "alliance");
    else if (cooperation > 0.6 && relation.opinion >= 20) proposeTreaty(world, a, b, "non-aggression");
    if (world.settings?.tradeEnabled && relation.opinion >= 10) proposeTreaty(world, a, b, "trade");
  }
}

function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
