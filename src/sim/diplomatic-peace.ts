import { relieveUnrestAfterPeace } from "./domestic-unrest";
import { proposePeaceTerms, whitePeaceTerms, assessPeaceOffer, acceptPeaceOffer, updateWarNegotiations } from "./war-negotiations";
import type { NationId } from "../worldgen/nation";
import { withdrawAmphibiousOperationsForPeace } from "./amphibious";
import { getDiplomacyState, getRelation, spendInfluence } from "./diplomacy";
import { resolveCrisisPeacefully } from "./diplomatic-crises";
import { getNationCharacter } from "./nation-character";
import { isNationActive } from "./nation-active";
import { updateOccupation } from "./occupation";
import { getWarDeclarationMode, recordSimulationEvent } from "./simulation-settings";
import { getOwnerByMesoId } from "./world-cache";
import { buildWarAdjacency, findWar, isAtWar, type WarState } from "./war-state";
import type { WorldState } from "./world-state";

export function warFatigueKey(war: WarState): string {
  return `${war.id}:${war.startedAtFastTick}:${war.nationAId}:${war.nationBId}`;
}
export function getWarFatigue(world: WorldState, a: NationId, b: NationId): number {
  const war = findWar(world.wars, a, b);
  return war ? getDiplomacyState(world).fatigueByWarId.get(warFatigueKey(war)) ?? 0 : 0;
}

/** Status-quo peace: occupied land and embarked troops are returned by agreement. */
export function concludePeace(world: WorldState, a: NationId, b: NationId, reason = "negotiated settlement"): boolean {
  if (getWarDeclarationMode(world) !== "diplomacy") return false;
  const war = findWar(world.wars, a, b);
  if (!war) return false;
  const ownerById = getOwnerByMesoId(world);
  withdrawAmphibiousOperationsForPeace(world, a, b);
  world.wars = world.wars.filter((item) => item !== war);
  world.battles = world.battles.filter((battle) => !(
    (battle.attackerNationId === a && battle.defenderNationId === b) ||
    (battle.attackerNationId === b && battle.defenderNationId === a)));
  let changed = false;
  for (const [regionId, occupier] of world.occupation.mesoById) {
    const owner = ownerById.get(regionId);
    if ((owner === a && occupier === b) || (owner === b && occupier === a)) {
      world.occupation.mesoById.delete(regionId); world.occupation.dirtyMesoIds.add(regionId); changed = true;
    }
  }
  if (changed) world.occupation.version += 1;
  for (const unit of world.units) {
    if (unit.nationId !== a && unit.nationId !== b) continue;
    const formerEnemy = unit.nationId === a ? b : a;
    const onForeignLand = unit.domain === "land" && ownerById.get(unit.regionId) === formerEnemy;
    const movingAgainstEnemy = unit.moveToId && ownerById.get(unit.moveToId) === formerEnemy;
    if (onForeignLand) {
      const capital = world.nations.find((nation) => nation.id === unit.nationId)?.capitalMesoId;
      if (capital) unit.regionId = capital;
    }
    if (onForeignLand || movingAgainstEnemy) {
      unit.moveTargetId = null; unit.moveFromId = null; unit.moveToId = null; unit.moveProgressMs = 0;
    }
  }
  updateOccupation(world);
  const relation = getRelation(world, a, b);
  relation.crisis = null; relation.tension = 15;
  relation.opinion = Math.max(-30, relation.opinion); relation.grievance *= 0.5;
  relation.treaties = relation.treaties.filter((treaty) => treaty.type !== "truce");
  relation.treaties.push({ type: "truce", expiresAtSlowTick: world.time.slowTick + 300 });
  relation.cooldownUntilSlowTick = world.time.slowTick + 300;
  getDiplomacyState(world).fatigueByWarId.delete(warFatigueKey(war));
  getDiplomacyState(world).peaceAgreements += 1;
  world.warNegotiations?.active.delete(warFatigueKey(war));
  relieveUnrestAfterPeace(world, a); relieveUnrestAfterPeace(world, b);
  recordSimulationEvent(world, { category: "diplomacy", nationIds: [a, b],
    message: `${a} and ${b} signed peace (${reason}); occupations and expeditionary troops returned.` });
  return true;
}

export function offerPeace(world: WorldState, proposerId: NationId, targetId: NationId): boolean {
  if (!proposePeaceTerms(world, proposerId, targetId, whitePeaceTerms())) return false;
  const war = findWar(world.wars, proposerId, targetId)!;
  if (world.time.fastTick - war.startedAtFastTick >= 300 && assessPeaceOffer(world, targetId, proposerId, whitePeaceTerms()).accepts)
    acceptPeaceOffer(world, targetId, proposerId);
  return true;
}

export function mediateCrisis(world: WorldState, mediatorId: NationId, a: NationId, b: NationId): boolean {
  if (getWarDeclarationMode(world) !== "diplomacy" || mediatorId === a || mediatorId === b) return false;
  if (!world.nations.some((nation) => nation.id === mediatorId && isNationActive(nation))) return false;
  const wars = buildWarAdjacency(world.wars);
  if (isAtWar(mediatorId, a, wars) || isAtWar(mediatorId, b, wars) || !getRelation(world, a, b).crisis) return false;
  if (getRelation(world, mediatorId, a).trust < 50 || getRelation(world, mediatorId, b).trust < 50 ||
    !spendInfluence(world, mediatorId, 15)) return false;
  resolveCrisisPeacefully(world, a, b, `mediation by ${mediatorId}`);
  return true;
}

export function updateDiplomaticPeace(world: WorldState): void {
  if (getWarDeclarationMode(world) !== "diplomacy") return;
  const state = getDiplomacyState(world);
  if (world.time.slowTick - state.lastPeaceSlowTick < 10) return;
  state.lastPeaceSlowTick = world.time.slowTick;
  const liveKeys = new Set(world.wars.map(warFatigueKey));
  for (const key of state.fatigueByWarId.keys()) if (!liveKeys.has(key)) state.fatigueByWarId.delete(key);
  for (const war of [...world.wars]) {
    const key = warFatigueKey(war);
    const losses = [...war.contributionByNationId.values()].reduce((sum, value) => sum + value, 0);
    const fatigue = Math.min(100, (state.fatigueByWarId.get(key) ?? 0) + 1 + Math.min(2, losses / 10_000));
    state.fatigueByWarId.set(key, fatigue);

  }
  updateWarNegotiations(world);
  for (const relation of state.relations.values()) {
    if (!relation.crisis || world.time.slowTick - relation.crisis.openedAtSlowTick < 10) continue;
    const mediator = world.nations.filter(isNationActive).find((nation) => nation.id !== relation.nationAId &&
      nation.id !== relation.nationBId && getNationCharacter(world, nation.id).cooperation >= 0.8 &&
      getRelation(world, nation.id, relation.nationAId).trust >= 55 && getRelation(world, nation.id, relation.nationBId).trust >= 55);
    if (mediator) mediateCrisis(world, mediator.id, relation.nationAId, relation.nationBId);
  }
}
