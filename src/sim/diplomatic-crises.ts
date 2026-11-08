import type { MesoRegionId } from "../worldgen/meso-region";
import { getForeignClaims, getTerritorialClaim } from "./territorial-claims";
import { canTransferTerritories, transferTerritories } from "./territory-transfer";
import { getOwnerByMesoId } from "./world-cache";
import { areFactionPartners, getFactionDefenders } from "./factions";
import type { NationId } from "../worldgen/nation";
import { getDiplomacyState, getRelation, hasTreaty, isDiplomaticallyProtected, spendInfluence } from "./diplomacy";
import { getNationCharacter } from "./nation-character";
import { isNationActive } from "./nation-active";
import { getWarDeclarationMode, recordSimulationEvent } from "./simulation-settings";
import { assessWarIntent, generateWarDeclarationCandidates } from "./war-declaration";
import { buildWarAdjacency, declareWar, findWar } from "./war-state";
import { getUnitCombatStrength } from "./unit-strength";
import type { WorldState } from "./world-state";

export function getNationalMilitaryStrength(world: WorldState, nationId: NationId): number {
  return world.units.reduce((sum, unit) => sum + (unit.nationId === nationId && unit.manpower > 0 && unit.org > 0
    ? getUnitCombatStrength(unit) * (unit.type === "TransportShip" ? 0.1 : 1) : 0), 0);
}

export function openDiplomaticCrisis(world: WorldState, aggressorId: NationId, targetId: NationId, requestedRegions?: MesoRegionId[]): boolean {
  if (getWarDeclarationMode(world) !== "diplomacy" || aggressorId === targetId) return false;
  if (![aggressorId, targetId].every((id) => world.nations.some((nation) => nation.id === id && isNationActive(nation)))) return false;
  if (findWar(world.wars, aggressorId, targetId) || isDiplomaticallyProtected(world, aggressorId, targetId)) return false;
  const regionIds = requestedRegions ? [...requestedRegions] : undefined;
  if (regionIds && (!regionIds.length || regionIds.length > 8 || new Set(regionIds).size !== regionIds.length ||
    regionIds.some((id) => getTerritorialClaim(world, aggressorId, id) < 20) ||
    !canTransferTerritories(world, [{ from: targetId, to: aggressorId, regionIds }]))) return false;
  const relation = getRelation(world, aggressorId, targetId);
  if (relation.crisis || world.time.slowTick < relation.cooldownUntilSlowTick) return false;
  const exposure = world.strategicThreatObservation.exposures.find((item) =>
    item.observerNationId === aggressorId && item.threatNationId === targetId && (item.landAdjacent || item.sharedSeaComponent));
  if (!exposure || getNationalMilitaryStrength(world, aggressorId) < Math.max(1, getNationalMilitaryStrength(world, targetId)) * 0.65) return false;
  if ([...getDiplomacyState(world).relations.values()].some((item) => item.crisis?.aggressorId === aggressorId)) return false;
  if (!spendInfluence(world, aggressorId, 12)) return false;
  relation.crisis = { aggressorId, openedAtSlowTick: world.time.slowTick,
    deadlineSlowTick: world.time.slowTick + 30, demand: regionIds ? "territory" : relation.grievance > 30 ? "containment" : "concessions", regionIds };
  relation.tension = Math.max(60, relation.tension);
  relation.opinion = Math.max(-100, relation.opinion - 10);
  getDiplomacyState(world).crisesOpened += 1;
  recordSimulationEvent(world, { category: "diplomacy", nationIds: [aggressorId, targetId],
    message: `${aggressorId} issued an ultimatum to ${targetId}${regionIds ? ` for ${regionIds.length} claimed regions` : ""}; negotiations last 30 ticks.` });
  return true;
}

export function respondToCrisis(world: WorldState, responderId: NationId, otherId: NationId,
  response: "concede" | "negotiate" | "reject"): boolean {
  if (getWarDeclarationMode(world) !== "diplomacy") return false;
  const relation = getRelation(world, responderId, otherId), crisis = relation.crisis;
  if (!crisis || crisis.aggressorId === responderId) return false;
  const responder = world.nations.find((nation) => nation.id === responderId && isNationActive(nation));
  const aggressor = world.nations.find((nation) => nation.id === otherId && isNationActive(nation));
  if (!responder || !aggressor) return false;
  if (response === "reject") { crisis.deadlineSlowTick = world.time.slowTick; return true; }
  if (response === "concede") {
    if (crisis.demand === "territory") {
      if (!crisis.regionIds || !transferTerritories(world, [{ from: responderId, to: otherId, regionIds: crisis.regionIds }], "ultimatum")) return false;
      relation.territorialSettlement = { aggressorId: otherId, regionIds: [...crisis.regionIds], atSlowTick: world.time.slowTick };
      resolveCrisisPeacefully(world, responderId, otherId, "accepted territorial demand");
      // Consent prevents an annexation penalty, but coercion still leaves resentment.
      relation.opinion = Math.max(-100, relation.opinion - 8); relation.grievance = Math.min(100, relation.grievance + 12);
      return true;
    }
    const payment = 30;
    if (responder.resources.weapons < payment) return false;
    responder.resources.weapons -= payment;
    aggressor.resources.weapons += payment;
    responder.resourceFlow.usage.weapons += payment; responder.resourceFlow.delta.weapons -= payment;
    aggressor.resourceFlow.income.weapons += payment; aggressor.resourceFlow.delta.weapons += payment;
  } else {
    if (getNationCharacter(world, otherId).aggression > 0.75 && relation.trust < 50) return false;
    if (!spendInfluence(world, responderId, 15)) return false;
    relation.trust = Math.min(100, relation.trust + 5);
  }
  resolveCrisisPeacefully(world, responderId, otherId, response);
  return true;
}

export function resolveCrisisPeacefully(world: WorldState, a: NationId, b: NationId, reason: string): void {
  const relation = getRelation(world, a, b);
  if (!relation.crisis) return;
  relation.crisis = null;
  relation.tension = Math.max(0, relation.tension - 40);
  relation.cooldownUntilSlowTick = world.time.slowTick + 120;
  relation.treaties = relation.treaties.filter((treaty) => treaty.type !== "truce");
  relation.treaties.push({ type: "truce", expiresAtSlowTick: world.time.slowTick + 120 });
  getDiplomacyState(world).crisesResolved += 1;
  recordSimulationEvent(world, { category: "diplomacy", nationIds: [a, b], message: `${a} and ${b} defused their crisis (${reason}).` });
}

export function startDiplomaticWar(world: WorldState, aggressorId: NationId, targetId: NationId,
  cause: "diplomatic-crisis" | "defensive-alliance" | "faction-obligation" = "diplomatic-crisis"): boolean {
  if (getWarDeclarationMode(world) !== "diplomacy" || isDiplomaticallyProtected(world, aggressorId, targetId)) return false;
  if (![aggressorId, targetId].every((id) => world.nations.some((nation) => nation.id === id && isNationActive(nation)))) return false;
  const war = declareWar(world.wars, aggressorId, targetId, world.time.fastTick);
  if (!war) return false;
  war.cause = cause;
  const relation = getRelation(world, aggressorId, targetId);
  relation.crisis = null; relation.treaties = [];
  relation.opinion = -80; relation.trust = Math.max(0, relation.trust - 30); relation.tension = 100;
  getDiplomacyState(world).declarations += 1;
  for (const other of getDiplomacyState(world).relations.values()) {
    if (other === relation || (other.nationAId !== aggressorId && other.nationBId !== aggressorId)) continue;
    other.opinion = Math.max(-100, other.opinion - (cause === "diplomatic-crisis" ? 8 : 1));
  }
  recordSimulationEvent(world, { category: "diplomacy", nationIds: [aggressorId, targetId],
    message: `${aggressorId} declared war on ${targetId} (${cause}).` });
  return true;
}

export function updateDiplomaticCrises(world: WorldState): void {
  if (getWarDeclarationMode(world) !== "diplomacy") return;
  const state = getDiplomacyState(world), now = world.time.slowTick;
  if (now - state.lastCrisisSlowTick < 10) return;
  state.lastCrisisSlowTick = now;
  const active = new Set(world.nations.filter(isNationActive).map((nation) => nation.id));
  for (const relation of state.relations.values()) {
    const crisis = relation.crisis;
    if (!crisis) continue;
    const attacker = crisis.aggressorId;
    const defender = relation.nationAId === attacker ? relation.nationBId : relation.nationAId;
    if (!active.has(attacker) || !active.has(defender) || isDiplomaticallyProtected(world, attacker, defender)) {
      relation.crisis = null; continue;
    }
    if (crisis.demand === "territory" && (!crisis.regionIds?.length ||
      crisis.regionIds.some((id) => getOwnerByMesoId(world).get(id) !== defender) ||
      !canTransferTerritories(world, [{ from: defender, to: attacker, regionIds: crisis.regionIds }]))) {
      resolveCrisisPeacefully(world, attacker, defender, "territorial demand no longer valid"); continue;
    }
    const ratio = getNationalMilitaryStrength(world, attacker) / Math.max(1, getNationalMilitaryStrength(world, defender));
    if (ratio < 0.7 || world.capitalDefense.assessmentsByNationId.get(attacker)?.threatLevel === "critical") {
      resolveCrisisPeacefully(world, attacker, defender, "deterrence"); continue;
    }
    const defensiveAllies = world.nations.filter((nation) => nation.id !== attacker && nation.id !== defender &&
      isNationActive(nation) && ((!areFactionPartners(world, nation.id, defender) && hasTreaty(world, nation.id, defender, "alliance")) || getFactionDefenders(world, defender).includes(nation.id)));
    const defense = getNationalMilitaryStrength(world, defender) + defensiveAllies.reduce((sum, nation) => sum + getNationalMilitaryStrength(world, nation.id) * 0.7, 0);
    if (defense > getNationalMilitaryStrength(world, attacker) * 1.8) {
      resolveCrisisPeacefully(world, attacker, defender, "allied deterrence"); continue;
    }
    if (now < crisis.deadlineSlowTick) {
      const character = getNationCharacter(world, defender);
      const demanded = crisis.regionIds ?? [];
      const ownerRegions = [...getOwnerByMesoId(world).values()].filter((id) => id === defender).length;
      const attachment = demanded.length ? demanded.reduce((sum, id) => sum + getTerritorialClaim(world, defender, id), 0) / demanded.length : 0;
      const capitalDemanded = demanded.includes(world.nations.find((nation) => nation.id === defender)!.capitalMesoId);
      const acceptableTerritory = crisis.demand !== "territory" || (!capitalDemanded && demanded.length <= Math.max(1, Math.floor(ownerRegions * 0.25)) && ratio > 1.6 + attachment / 60);
      if (ratio > 1.4 && character.cooperation > 0.6 && acceptableTerritory) respondToCrisis(world, defender, attacker, "concede");
      else if (character.cooperation > 0.7 && relation.trust >= 45) respondToCrisis(world, defender, attacker, "negotiate");
      continue;
    }
    if (world.wars.filter((war) => war.nationAId === attacker || war.nationBId === attacker).length >= 2) {
      resolveCrisisPeacefully(world, attacker, defender, "overextension"); continue;
    }
    startDiplomaticWar(world, attacker, defender);
  }
  // Allies defend the directly attacked state; defensive calls do not recurse.
  for (const war of [...world.wars]) {
    if (war.cause === "defensive-alliance" || war.cause === "faction-obligation") continue;
    for (const ally of world.nations.filter(isNationActive)) {
      if (ally.id === war.aggressorId || ally.id === war.defenderId || areFactionPartners(world, ally.id, war.defenderId) ||
        !hasTreaty(world, ally.id, war.defenderId, "alliance") || findWar(world.wars, ally.id, war.aggressorId)) continue;
      if (world.wars.filter((item) => item.nationAId === ally.id || item.nationBId === ally.id).length >= 2) continue;
      if (startDiplomaticWar(world, ally.id, war.aggressorId, "defensive-alliance")) state.defensiveInterventions += 1;
    }
  }
  if (world.strategicThreatObservation.version === 0) return;
  const candidates = generateWarDeclarationCandidates(world, active);
  const opened = new Set<NationId>();
  for (const candidate of candidates.sort((a, b) => a.aggressorId.localeCompare(b.aggressorId) ||
    getRelation(world, b.aggressorId, b.targetNationId).tension - getRelation(world, a.aggressorId, a.targetNationId).tension)) {
    const attacker = candidate.aggressorId;
    if (opened.has(attacker) || (buildWarAdjacency(world.wars).get(attacker)?.size ?? 0) > 0) continue;
    const relation = getRelation(world, attacker, candidate.targetNationId);
    const character = getNationCharacter(world, attacker);
    if (relation.tension < 45 && relation.grievance < 35) continue;
    if (character.aggression < 0.45 && relation.grievance < 50) continue;
    const intent = assessWarIntent(world, candidate);
    if (intent.rejectedReasons.some((reason) => ["insufficient-strength", "capital-emergency", "maritime-infeasible"].includes(reason))) continue;
    const desire = character.aggression * 40 + relation.tension * 0.6 + relation.grievance * 0.4 -
      relation.opinion * 0.35 + intent.opportunity * 0.3 - intent.expectedCost * 0.3 - intent.existingCommitment;
    const claims = getForeignClaims(world, attacker, candidate.targetNationId);
    const territorialTarget = claims.find((claim) => claim.strength >= 35 &&
      world.nations.find((nation) => nation.id === candidate.targetNationId)?.capitalMesoId !== claim.regionId);
    if (desire >= 45 && openDiplomaticCrisis(world, attacker, candidate.targetNationId,
      territorialTarget ? [territorialTarget.regionId] : undefined)) opened.add(attacker);
  }
}

/** Explicit betrayal after a territorial settlement; normal war declarations honor the truce. */
export function betrayTerritorialSettlement(world: WorldState, aggressorId: NationId, targetId: NationId): boolean {
  if (getWarDeclarationMode(world) !== "diplomacy" || aggressorId === targetId ||
    findWar(world.wars, aggressorId, targetId) || areFactionPartners(world, aggressorId, targetId) ||
    hasTreaty(world, aggressorId, targetId, "alliance") || hasTreaty(world, aggressorId, targetId, "non-aggression") ||
    ![aggressorId, targetId].every((id) => world.nations.some((nation) => nation.id === id && isNationActive(nation)))) return false;
  const relation = getRelation(world, aggressorId, targetId);
  if (!relation.territorialSettlement || world.time.slowTick - relation.territorialSettlement.atSlowTick >= 120 ||
    !relation.treaties.some((treaty) => treaty.type === "truce" && treaty.expiresAtSlowTick === relation.territorialSettlement!.atSlowTick + 120 && treaty.expiresAtSlowTick > world.time.slowTick) || !spendInfluence(world, aggressorId, 20)) return false;
  relation.treaties = relation.treaties.filter((treaty) => treaty.type !== "truce");
  relation.cooldownUntilSlowTick = 0;
  if (!startDiplomaticWar(world, aggressorId, targetId)) return false;
  relation.trust = Math.max(0, relation.trust - 40); relation.grievance = Math.min(100, relation.grievance + 40);
  relation.territorialSettlement = undefined;
  for (const other of getDiplomacyState(world).relations.values()) if (other !== relation &&
    (other.nationAId === aggressorId || other.nationBId === aggressorId)) other.trust = Math.max(0, other.trust - 15);
  recordSimulationEvent(world, { category: "diplomacy", nationIds: [aggressorId, targetId],
    message: `${aggressorId} betrayed a territorial settlement and attacked ${targetId}; international trust fell.` });
  return true;
}
