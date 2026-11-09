import { areSubjectPartners, getSubjectOverlord } from "./subject-governments";
import { getIdeologicalAffinity } from "./ideology-relations";
import type { MesoRegionId } from "../worldgen/meso-region";
import { areFactionPartners } from "./factions";
import type { NationId } from "../worldgen/nation";
import { getNationCharacter } from "./nation-character";
import { isNationPresent } from "./nation-active";
import { getWarDeclarationMode, recordSimulationEvent } from "./simulation-settings";
import { getAdjacentNationPairs } from "./world-cache";
import { buildWarAdjacency, findWar, isAtWar, normalizeWarPair } from "./war-state";
import type { WorldState } from "./world-state";

export type TreatyType = "non-aggression" | "trade" | "alliance" | "truce";
export interface Treaty { type: TreatyType; expiresAtSlowTick: number; negotiatedPeace?: boolean }
export interface DiplomaticCrisis {
  aggressorId: NationId;
  openedAtSlowTick: number;
  deadlineSlowTick: number;
  demand: "concessions" | "containment" | "territory";
  regionIds?: MesoRegionId[];
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
  nextBorderIncidentAt?: number;
  territorialSettlement?: { aggressorId: NationId; regionIds: MesoRegionId[]; atSlowTick: number };
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
      Math.abs(first.aggression - second.aggression) * 15 + getIdeologicalAffinity(world, a, b) * 14;
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
/** Exile governments oppose occupiers through their host's continuing war. */
export function hasExileConflict(world: WorldState, a: NationId, b: NationId): boolean {
  const hostile = (id: NationId, enemy: NationId) => {
    const record = world.exileGovernments?.byNationId.get(id);
    return record?.status === "exiled" && record.enemyIds.includes(enemy) && world.wars.some((war) =>
      (war.nationAId === record.hostId && war.nationBId === enemy) || (war.nationBId === record.hostId && war.nationAId === enemy));
  };
  return hostile(a, b) || hostile(b, a);
}
export function isDiplomaticallyProtected(world: WorldState, a: NationId, b: NationId): boolean {
  return areSubjectPartners(world, a, b) || areFactionPartners(world, a, b) || (["truce", "non-aggression", "alliance"] as const).some((type) => hasTreaty(world, a, b, type));
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
  if (![proposerId, partnerId].every((id) => world.nations.some((nation) => nation.id === id && isNationPresent(world, nation)))) return false;
  if (isAtWar(proposerId, partnerId, buildWarAdjacency(world.wars)) || hasExileConflict(world, proposerId, partnerId) || hasTreaty(world, proposerId, partnerId, type)) return false;
  if (type === "alliance" && (getSubjectOverlord(world, proposerId) || getSubjectOverlord(world, partnerId))) return false;
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

export const TRUCE_EXTENSION = { cost: 10, seconds: 180, negotiationWindow: 90 } as const;

function getActiveTruce(world: WorldState, relation: DiplomaticRelation): Treaty | undefined {
  return relation.treaties.find((treaty) =>
    treaty.type === "truce" && treaty.expiresAtSlowTick > world.time.slowTick);
}

export function getTruceExtensionIssue(world: WorldState, proposer: NationId, partner: NationId): string | null {
  const relation = world.diplomacy?.relations.get(relationKey(proposer, partner));
  const truce = relation && getActiveTruce(world, relation);
  if (getWarDeclarationMode(world) !== "diplomacy" || proposer === partner || !relation || !truce ||
    findWar(world.wars, proposer, partner) || hasExileConflict(world, proposer, partner) ||
    ![proposer, partner].every((id) => world.nations.some((nation) => nation.id === id && isNationPresent(world, nation)))) {
    return "Both nations need an active truce.";
  }
  if (relation.territorialSettlement && truce.expiresAtSlowTick === relation.territorialSettlement.atSlowTick + 120) {
    return "Territorial settlement truces have fixed terms.";
  }
  if (truce.expiresAtSlowTick - world.time.slowTick > TRUCE_EXTENSION.negotiationWindow) {
    return `Available in the last ${TRUCE_EXTENSION.negotiationWindow} seconds of the truce.`;
  }
  if (relation.crisis || relation.opinion < 0 || relation.trust < 50 || relation.tension > 35) {
    return "The partner requires neutral opinion, 50 trust, tension at most 35 and no active crisis.";
  }
  return getInfluence(world, proposer) < TRUCE_EXTENSION.cost ? "Insufficient influence." : null;
}

export function extendTruce(world: WorldState, proposer: NationId, partner: NationId): boolean {
  if (getTruceExtensionIssue(world, proposer, partner) || !spendInfluence(world, proposer, TRUCE_EXTENSION.cost)) return false;
  const relation = getRelation(world, proposer, partner);
  getActiveTruce(world, relation)!.expiresAtSlowTick += TRUCE_EXTENSION.seconds;
  recordSimulationEvent(world, { category: "diplomacy", nationIds: [proposer, partner],
    message: `${proposer} and ${partner} extended their truce by ${TRUCE_EXTENSION.seconds} seconds.` });
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
    isAtWar(nationId, partnerId, buildWarAdjacency(world.wars)) || hasExileConflict(world, nationId, partnerId)) return false;
  if (![nationId, partnerId].every((id) => world.nations.some((nation) => nation.id === id && isNationPresent(world, nation)))) return false;
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
  const active = new Set(world.nations.filter((nation) => isNationPresent(world, nation)).map((nation) => nation.id));
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
    if (isAtWar(a, b, wars) || hasExileConflict(world, a, b)) { relation.opinion = Math.max(-100, relation.opinion - 3); continue; }
    const first = getNationCharacter(world, a), second = getNationCharacter(world, b);
    const commonEnemy = [...(wars.get(a) ?? [])].some((enemy) => wars.get(b)?.has(enemy));
    const cooperation = (first.cooperation + second.cooperation) / 2;
    const affinity = getIdeologicalAffinity(world, a, b);
    const treatyGoodwill = relation.treaties.reduce((sum, treaty) => sum +
      ({ alliance: 22, "non-aggression": 8, trade: 8, truce: 2 }[treaty.type]), 0);
    // Evidence of cooperation can overcome ideological friction. Personality alone cannot drift every pair to +100.
    const targetOpinion = clamp((cooperation - 0.5) * 45 + affinity * 30 + (relation.trust - 40) * 0.45 +
      treatyGoodwill + (commonEnemy ? 25 : 0) - relation.grievance * 0.5, -100, 100);
    relation.opinion = clamp(relation.opinion + clamp((targetOpinion - relation.opinion) * 0.04, -2, 2), -100, 100);
    const distrust = Math.max(0, -affinity);
    const treatyTrust = relation.treaties.length ? 0.8 * (1 - distrust * 0.25) : 0.1 * (1 - distrust * 0.65);
    // Shared fighting builds trust even before a formal agreement is in place.
    const wartimeTrust = commonEnemy && !relation.crisis ? cooperation * 1.2 : 0;
    relation.trust = clamp(relation.trust + treatyTrust + wartimeTrust, 0, 100);
    relation.grievance = Math.max(0, relation.grievance - 0.2);
    relation.tension = clamp(relation.tension + (first.aggression + second.aggression - 0.9) * 2 -
      (relation.opinion > 20 ? 1.5 : 0) + relation.grievance * 0.03 + distrust * 0.35, 0, 100);
    if (relation.crisis) continue;
    if (relation.opinion >= 55 && relation.trust >= 55) proposeTreaty(world, a, b, "alliance");
    else if (cooperation > 0.6 && relation.opinion >= 20) proposeTreaty(world, a, b, "non-aggression");
    if (world.settings?.tradeEnabled && relation.opinion >= 10) proposeTreaty(world, a, b, "trade");
  }
}

function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
