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
import { buildWarAdjacency, findWar, getWarCasualties, isAtWar, type WarState } from "./war-state";
import type { WorldState } from "./world-state";

export function warFatigueKey(war: WarState): string {
  return `${war.id}:${war.startedAtFastTick}:${war.nationAId}:${war.nationBId}`;
}
export function getWarFatigue(world: WorldState, a: NationId, b: NationId): number {
  const war = findWar(world.wars, a, b);
  return war ? war.exhaustionByNationId?.get(a)?.fatigue ?? getDiplomacyState(world).fatigueByWarId.get(warFatigueKey(war)) ?? 0 : 0;
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
  relation.treaties.push({ type: "truce", expiresAtSlowTick: world.time.slowTick + 300, negotiatedPeace: true });
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
  if (assessPeaceOffer(world, targetId, proposerId, whitePeaceTerms()).accepts)
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
  const diplomacyEnabled = getWarDeclarationMode(world) === "diplomacy";
  const wars = diplomacyEnabled ? world.wars : world.wars.filter((war) => war.cause === "player-declaration");
  if (!diplomacyEnabled && !wars.length) return;
  const state = getDiplomacyState(world);
  if (world.time.slowTick - state.lastPeaceSlowTick < 10) return;
  state.lastPeaceSlowTick = world.time.slowTick;
  const liveKeys = new Set(world.wars.map(warFatigueKey));
  for (const key of state.fatigueByWarId.keys()) if (!liveKeys.has(key)) state.fatigueByWarId.delete(key);
  for (const war of wars) {
    const key = warFatigueKey(war);
    const legacyFatigue = state.fatigueByWarId.get(key) ?? 0;
    const sides = war.exhaustionByNationId ??= new Map();
    for (const nation of [war.nationAId, war.nationBId]) {
      const casualties = getWarCasualties(war, nation);
      const previous = sides.get(nation);
      const counted = previous?.countedCasualties ?? (legacyFatigue > 0 ? casualties : 0);
      const newLosses = Math.max(0, casualties - counted);
      sides.set(nation, { fatigue: Math.min(100, (previous?.fatigue ?? legacyFatigue) + 1 + Math.min(10, newLosses / 1_500)),
        countedCasualties: casualties });
    }

  }
  updateWarNegotiations(world);
  if (!diplomacyEnabled) return;
  for (const relation of state.relations.values()) {
    if (!relation.crisis || world.time.slowTick - relation.crisis.openedAtSlowTick < 10) continue;
    const mediator = world.nations.filter(isNationActive).find((nation) => nation.id !== relation.nationAId &&
      nation.id !== relation.nationBId && getNationCharacter(world, nation.id).cooperation >= 0.8 &&
      getRelation(world, nation.id, relation.nationAId).trust >= 55 && getRelation(world, nation.id, relation.nationBId).trust >= 55);
    if (mediator) mediateCrisis(world, mediator.id, relation.nationAId, relation.nationBId);
  }
}
