import { getNationalTerritorialValue, getTerritorialValue } from "./territorial-value";
import { getSeparatePeaceIssue } from "./separate-peace";
import { hasConferenceWar } from "./peace-conference";
import { dividePartitionResources, getPartitionIssue, planLocalSubject, planPuppetPartition, preparePartitionNation, type PuppetPartition } from "./puppet-partition";
import { estimateAnnexationResistance, recordAnnexation } from "./annexation";
import { getPuppetTermsIssue, installSubjectGovernment } from "./subject-governments";
import { getRelation } from "./diplomacy";
import { getPeaceBorderIssue, selectPeaceProvinces } from "./peace-borders";
import type { NationId } from "../worldgen/nation";
import type { MesoRegionId } from "../worldgen/meso-region";
import type { WorldState } from "./world-state";
import type { WarState } from "./war-state";
import { findWar } from "./war-state";
import { getNationCharacter } from "./nation-character";
import { getNationName } from "./nation-identity";
import { getRevolutionRisk } from "./domestic-unrest";
import { allFieldUnits } from "./mobilization";
import { getUnitCombatStrength } from "./unit-strength";
import { getForeignClaims } from "./territorial-claims";
import { canTransferTerritories, transferTerritories, type TerritoryTransfer } from "./territory-transfer";
import { changeResource } from "./international-trade";
import { getOwnerByMesoId } from "./world-cache";
import { getWarDeclarationMode, hasPoliticalTurbulence, recordSimulationEvent } from "./simulation-settings";
import { concludePeace, getWarFatigue, warFatigueKey } from "./diplomatic-peace";

export interface PeaceTerms {
  demandedRegionIds: MesoRegionId[]; offeredRegionIds: MesoRegionId[];
  demandedWeapons: number; offeredWeapons: number; truceSeconds: number;
  puppetTarget?: boolean;
  partition?: PuppetPartition;
  localSubject?: boolean;
}
export interface PeaceOffer { proposerId: NationId; terms: PeaceTerms; revisedAtSlowTick: number; revision: number; source: "opening" | "automatic" | "manual" }
export interface WarNegotiation {
  key: string; a: NationId; b: NationId; openingPower: Map<NationId, number>;
  offers: Map<NationId, PeaceOffer>; automatic: Map<NationId, boolean>; lastRevisionSlowTick: Map<NationId, number>;
}
export interface PeaceSettlement { a: NationId; b: NationId; proposerId: NationId; terms: PeaceTerms; atSlowTick: number }
export interface WarNegotiationState { active: Map<string, WarNegotiation>; settlements: PeaceSettlement[]; lastAISlowTick: number }
export function whitePeaceTerms(): PeaceTerms { return { demandedRegionIds: [], offeredRegionIds: [], demandedWeapons: 0, offeredWeapons: 0, truceSeconds: 300 }; }
export function getWarNegotiationState(world: WorldState): WarNegotiationState {
  return world.warNegotiations ??= { active: new Map(), settlements: [], lastAISlowTick: -10 };
}
function nationalPower(world: WorldState, id: NationId): number {
  return allFieldUnits(world).reduce((sum, unit) => sum + (unit.nationId === id ? getUnitCombatStrength(unit) * (unit.type === "TransportShip" ? 0.1 : 1) : 0), 0);
}
function ownedLand(world: WorldState, id: NationId): MesoRegionId[] {
  const owners = getOwnerByMesoId(world);
  return world.mesoRegions.filter((region) => region.type !== "sea" && owners.get(region.id) === id).map((region) => region.id);
}
function occupationRatio(world: WorldState, id: NationId, enemy: NationId): number {
  const land = ownedLand(world, id); return land.filter((region) => world.occupation.mesoById.get(region) === enemy).length / Math.max(1, land.length);
}
export function getWarAdvantage(world: WorldState, a: NationId, b: NationId): number {
  const military = Math.log((nationalPower(world, a) + 1) / (nationalPower(world, b) + 1)) * 0.25;
  return Math.max(-1, Math.min(1, military + (occupationRatio(world, b, a) - occupationRatio(world, a, b)) * 0.75));
}
export function isFightOnGovernment(world: WorldState, id: NationId): boolean {
  const character = getNationCharacter(world, id); return character.aggression >= 0.85 && character.cooperation <= 0.4;
}
export function getPeaceUrgency(world: WorldState, id: NationId): number {
  const nation = world.nations.find((item) => item.id === id);
  if (!nation) return 0;
  return isFightOnGovernment(world, id) ? getRevolutionRisk(world, id) * 0.1 : Math.max(getRevolutionRisk(world, id), Math.max(0, 0.35 - nation.warCooperation) * 1.5);
}
function legsFor(proposer: NationId, target: NationId, terms: PeaceTerms): TerritoryTransfer[] {
  return [...(terms.demandedRegionIds.length ? [{ from: target, to: proposer, regionIds: terms.demandedRegionIds }] : []),
    ...(terms.offeredRegionIds.length ? [{ from: proposer, to: target, regionIds: terms.offeredRegionIds }] : [])];
}
export function getPeaceTermsIssue(world: WorldState, proposer: NationId, target: NationId, terms: PeaceTerms): string | null {
  if (getWarDeclarationMode(world) !== "diplomacy" || !findWar(world.wars, proposer, target)) return "These nations are not negotiating an active war.";
  if (!Array.isArray(terms.demandedRegionIds) || !Array.isArray(terms.offeredRegionIds)) return "Select valid territories.";
  if (![terms.demandedWeapons, terms.offeredWeapons].every((amount) => Number.isInteger(amount) && amount >= 0 && amount <= 100) ||
    (terms.demandedWeapons > 0 && terms.offeredWeapons > 0) || !Number.isInteger(terms.truceSeconds) || terms.truceSeconds < 180 || terms.truceSeconds > 900) return "Check reparations and the truce duration.";
  if (terms.puppetTarget || terms.partition) {
    if (terms.offeredRegionIds.length) return "A puppet settlement cannot grant provinces to the defeated government.";
    const targetCapital = world.nations.find((nation) => nation.id === target)?.capitalMesoId;
    if (targetCapital && terms.demandedRegionIds.includes(targetCapital)) {
      return "The defeated government must retain its capital.";
    }
    const puppetIssue = getPuppetTermsIssue(world, proposer, target);
    if (puppetIssue) return puppetIssue;
    if (terms.partition) {
      const partitionIssue = getPartitionIssue(world, proposer, target, terms.demandedRegionIds, terms.partition);
      if (partitionIssue) return partitionIssue;
    }
  }
  const a = world.nations.find((nation) => nation.id === proposer && nation.macroRegionIds.length);
  const b = world.nations.find((nation) => nation.id === target && nation.macroRegionIds.length);
  if (!a || !b) return "Both governments need territory to sign this settlement.";
  if (a.resources.weapons < terms.offeredWeapons || b.resources.weapons < terms.demandedWeapons) return "The paying country cannot afford the proposed reparations.";
  const legs = legsFor(proposer, target, terms);
  if (terms.localSubject) {
    if (!hasPoliticalTurbulence(world) || terms.puppetTarget || terms.partition || terms.offeredRegionIds.length) {
      return "A local subject settlement only transfers the selected demands to a new government.";
    }
    const plan = planLocalSubject(world, proposer, target, terms.demandedRegionIds);
    if (!plan) return "A local subject needs at least two connected districts and a seat outside the defeated capital.";
    const nation = preparePartitionNation(world, b, plan);
    return canTransferTerritories(world, [{ from: target, to: nation.id, regionIds: plan.districtIds }],
      { nation, occupationSponsor: proposer }) ? null : "A third party controls part of the proposed subject.";
  }
  if (legs.length && !canTransferTerritories(world, legs)) return "Territory changed, a third party controls a district, or a country would lose its last territory.";
  const borderIssue = getPeaceBorderIssue(world, legs);
  if (borderIssue) return borderIssue;
  return null;
}
function candidateDistricts(world: WorldState, taker: NationId, donor: NationId): MesoRegionId[] {
  const donorNation = world.nations.find((nation) => nation.id === donor)!;
  const owned = ownedLand(world, donor), owners = getOwnerByMesoId(world);
  const claimed = getForeignClaims(world, taker, donor).map((claim) => claim.regionId);
  const occupied = owned.filter((id) => world.occupation.mesoById.get(id) === taker);
  return [...new Set([...occupied, ...claimed])].filter((id) => owners.get(id) === donor && id !== donorNation.capitalMesoId &&
    (!world.occupation.mesoById.has(id) || world.occupation.mesoById.get(id) === taker));
}
function automaticTerms(world: WorldState, proposer: NationId, target: NationId, opening = false): PeaceTerms {
  const terms = whitePeaceTerms(), advantage = getWarAdvantage(world, proposer, target), urgency = getPeaceUrgency(world, proposer);
  const a = world.nations.find((nation) => nation.id === proposer)!, b = world.nations.find((nation) => nation.id === target)!;
  const pursuingOpeningGoals = opening || getWarFatigue(world, proposer, target) < 35;
  const hardline = isFightOnGovernment(world, proposer);
  const aggressor = findWar(world.wars, proposer, target)?.aggressorId === proposer;
  if (advantage > 0.15 || hardline || (aggressor && pursuingOpeningGoals && urgency < 0.55)) {
    const candidates = candidateDistricts(world, proposer, target).filter((id) => estimateAnnexationResistance(world, proposer, id) < 0.55);
    if (hardline) for (const id of ownedLand(world, target)) if (id !== b.capitalMesoId && !candidates.includes(id) &&
      (!world.occupation.mesoById.has(id) || world.occupation.mesoById.get(id) === proposer)) candidates.push(id);
    if (!opening && advantage > 0.45 && getNationCharacter(world, proposer).aggression >= 0.65 &&
      !getPuppetTermsIssue(world, proposer, target)) {
      terms.puppetTarget = true;
      if (advantage > 0.65) terms.partition = planPuppetPartition(world, proposer, target, []);
    } else {
      terms.demandedRegionIds = selectPeaceProvinces(world, target, proposer, candidates);
      if (!opening && advantage > 0.35 && hasPoliticalTurbulence(world) &&
        terms.demandedRegionIds.some((id) => estimateAnnexationResistance(world, proposer, id) >= 0.4) &&
        planLocalSubject(world, proposer, target, terms.demandedRegionIds)) terms.localSubject = true;
    }
    terms.demandedWeapons = Math.min(hardline ? 40 : 30, Math.floor(b.resources.weapons * (hardline ? 0.35 : 0.15)),
      Math.max(pursuingOpeningGoals || hardline ? 15 : 0, Math.floor(advantage * 40)));
  } else if (!opening && (advantage < -0.15 || urgency >= 0.55)) {
    terms.offeredRegionIds = selectPeaceProvinces(world, proposer, target, candidateDistricts(world, target, proposer));
    terms.offeredWeapons = Math.min(25, Math.floor(a.resources.weapons * 0.15));
    terms.truceSeconds = 600;
  }
  return terms;
}
export function getWarNegotiation(world: WorldState, war: WarState): WarNegotiation {
  const state = getWarNegotiationState(world), key = warFatigueKey(war);
  let negotiation = state.active.get(key);
  if (!negotiation) {
    negotiation = { key, a: war.nationAId, b: war.nationBId, openingPower: new Map([[war.nationAId, nationalPower(world, war.nationAId)], [war.nationBId, nationalPower(world, war.nationBId)]]), offers: new Map(), automatic: new Map(), lastRevisionSlowTick: new Map() };
    state.active.set(key, negotiation);
    for (const [proposer, target] of [[negotiation.a, negotiation.b], [negotiation.b, negotiation.a]]) {
      negotiation.automatic.set(proposer, true); negotiation.lastRevisionSlowTick.set(proposer, world.time.slowTick);
      negotiation.offers.set(proposer, { proposerId: proposer, terms: automaticTerms(world, proposer, target, true), revisedAtSlowTick: world.time.slowTick, revision: 0, source: "opening" });
    }
    recordSimulationEvent(world, { category: "diplomacy", nationIds: [negotiation.a, negotiation.b],
      message: `${getNationName(world, negotiation.a)} and ${getNationName(world, negotiation.b)} published opening peace conditions.` });
  }
  return negotiation;
}
export function assessPeaceOffer(world: WorldState, recipient: NationId, proposer: NationId, terms: PeaceTerms) {
  const issue = getPeaceTermsIssue(world, proposer, recipient, terms);
  if (issue) return { accepts: false, score: -Infinity, reason: issue };
  const war = findWar(world.wars, recipient, proposer)!, negotiation = getWarNegotiation(world, war);
  const nation = world.nations.find((item) => item.id === recipient)!, character = getNationCharacter(world, recipient);
  const militaryLoss = Math.max(0, 1 - nationalPower(world, recipient) / Math.max(1, negotiation.openingPower.get(recipient) ?? 1));
  const advantage = getWarAdvantage(world, recipient, proposer), fatigue = getWarFatigue(world, recipient, proposer);
  const ageSeconds = Math.max(0, world.time.fastTick - war.startedAtFastTick) / 10;
  const domestic = getPeaceUrgency(world, recipient) * 42;
  const pressure = fatigue * 0.7 + Math.min(18, ageSeconds * 0.025) + occupationRatio(world, recipient, proposer) * 45 + militaryLoss * 15 + Math.max(0, -advantage) * 30 + (1 - nation.warCooperation) * 12 + domestic;
  const totalValue = getNationalTerritorialValue(world, recipient);
  const landCost = getTerritorialValue(world, recipient, terms.demandedRegionIds) / totalValue * 100 +
    (terms.demandedRegionIds.includes(nation.capitalMesoId) ? 25 : 0);
  const landBenefit = getTerritorialValue(world, recipient, terms.offeredRegionIds) / totalValue * 80;
  const paymentCost = terms.demandedWeapons / Math.max(10, nation.resources.weapons) * 25;
  const paymentBenefit = Math.min(18, terms.offeredWeapons * 0.5);
  const disposition = character.doctrine === "merchant" || character.doctrine === "isolationist" ? 12 : character.doctrine === "pragmatist" ? 8 : character.cooperation * 7;
  const resolve = 45 + (isFightOnGovernment(world, recipient) ? 35 : character.aggression * 8) + Math.max(0, advantage) * 25;
  const score = pressure + disposition + landBenefit + paymentBenefit + Math.min(6, (terms.truceSeconds - 300) / 100) - landCost - paymentCost - resolve - (terms.partition ? 38 : terms.puppetTarget ? 25 : terms.localSubject ? 8 : 0);
  return { accepts: score >= 0, score, reason: score >= 0 ? "Ending the war now is preferable to continued losses and domestic danger." : landCost + paymentCost > 25 ? "The requested concessions outweigh the current cost of continuing the war." : "The government expects a better outcome by continuing the war." };
}
export function proposePeaceTerms(world: WorldState, proposer: NationId, target: NationId, terms: PeaceTerms): boolean {
  if (getPeaceTermsIssue(world, proposer, target, terms)) return false;
  const negotiation = getWarNegotiation(world, findWar(world.wars, proposer, target)!);
  const old = negotiation.offers.get(proposer)!;
  negotiation.offers.set(proposer, { proposerId: proposer, terms: { ...terms, demandedRegionIds: [...terms.demandedRegionIds], offeredRegionIds: [...terms.offeredRegionIds],
    ...(terms.partition ? { partition: { ...terms.partition, districtIds: [...terms.partition.districtIds] } } : {}) }, revisedAtSlowTick: world.time.slowTick, revision: old.revision + 1, source: "manual" });
  negotiation.automatic.set(proposer, false);
  recordSimulationEvent(world, { category: "diplomacy", nationIds: [proposer, target], message: `${getNationName(world, proposer)} proposed peace to ${getNationName(world, target)}: ${terms.puppetTarget ? "puppet government, " : ""}${terms.demandedRegionIds.length} districts demanded, ${terms.offeredRegionIds.length} offered, ${terms.demandedWeapons || -terms.offeredWeapons} weapons reparations.` });
  return true;
}
export function acceptPeaceOffer(world: WorldState, recipient: NationId, proposer: NationId, expectedRevision?: number): boolean {
  const war = findWar(world.wars, recipient, proposer); if (!war) return false;
  const negotiation = getWarNegotiation(world, war), offer = negotiation.offers.get(proposer)!;
  const terms = offer.terms;
  if (expectedRevision !== undefined && expectedRevision !== offer.revision) return false;
  if (getSeparatePeaceIssue(world, proposer, recipient) || getPeaceTermsIssue(world, proposer, recipient, terms)) return false;
  const defeated = world.nations.find((nation) => nation.id === recipient)!;
  const localPlan = terms.localSubject ? planLocalSubject(world, proposer, recipient, terms.demandedRegionIds) : undefined;
  const plan = localPlan ?? terms.partition;
  const successor = plan && preparePartitionNation(world, defeated, plan);
  const legs = localPlan ? [] : legsFor(proposer, recipient, terms);
  if (successor && plan) legs.push({ from: recipient, to: successor.id, regionIds: plan.districtIds });
  const founding = successor && { nation: successor, occupationSponsor: proposer };
  if (legs.length && !transferTerritories(world, legs, "agreement", founding)) return false;
  // Validation and territory transfer are synchronous and cannot remove this war.
  if (!concludePeace(world, recipient, proposer, "accepted negotiated terms")) return false;
  const a = world.nations.find((nation) => nation.id === proposer)!, b = world.nations.find((nation) => nation.id === recipient)!;
  const payment = terms.demandedWeapons - terms.offeredWeapons;
  changeResource(a, "weapons", payment); changeResource(b, "weapons", -payment);
  const relation = getRelation(world, proposer, recipient);
  const truce = relation.treaties.find((treaty) => treaty.type === "truce")!; truce.expiresAtSlowTick = world.time.slowTick + terms.truceSeconds;
  relation.cooldownUntilSlowTick = truce.expiresAtSlowTick;
  if (!localPlan) recordAnnexation(world, proposer, terms.demandedRegionIds);
  recordAnnexation(world, recipient, terms.offeredRegionIds);
  if (terms.puppetTarget || terms.partition) installSubjectGovernment(world, proposer, recipient);
  if (successor && plan) {
    dividePartitionResources(world, b, successor, plan);
    installSubjectGovernment(world, proposer, successor.id);
    const successorRelation = getRelation(world, proposer, successor.id);
    successorRelation.treaties.push({ ...truce });
    successorRelation.cooldownUntilSlowTick = truce.expiresAtSlowTick;
  }
  const state = getWarNegotiationState(world); state.active.delete(negotiation.key);
  state.settlements.push({ a: recipient, b: proposer, proposerId: proposer, terms, atSlowTick: world.time.slowTick });
  if (state.settlements.length > 40) state.settlements.splice(0, state.settlements.length - 40);
  return true;
}
export function updateWarNegotiations(world: WorldState): void {
  if (getWarDeclarationMode(world) !== "diplomacy") return;
  const state = getWarNegotiationState(world), live = new Set(world.wars.map(warFatigueKey));
  for (const key of state.active.keys()) if (!live.has(key)) state.active.delete(key);
  for (const war of world.wars) getWarNegotiation(world, war);
  if (world.time.slowTick - state.lastAISlowTick < 10) return;
  state.lastAISlowTick = world.time.slowTick;
  for (const war of [...world.wars]) {
    if (hasConferenceWar(world, war)) continue;
    const negotiation = getWarNegotiation(world, war);
    for (const [proposer, target] of [[negotiation.a, negotiation.b], [negotiation.b, negotiation.a]]) {
      if (negotiation.automatic.get(proposer) && world.time.slowTick - (negotiation.lastRevisionSlowTick.get(proposer) ?? 0) >= 30) {
        const terms = automaticTerms(world, proposer, target), old = negotiation.offers.get(proposer)!;
        negotiation.lastRevisionSlowTick.set(proposer, world.time.slowTick);
        if (JSON.stringify(terms) !== JSON.stringify(old.terms)) negotiation.offers.set(proposer, { proposerId: proposer, terms, revisedAtSlowTick: world.time.slowTick, revision: old.revision + 1, source: "automatic" });
      }
    }
    for (const [recipient, proposer] of [[negotiation.a, negotiation.b], [negotiation.b, negotiation.a]]) {
      const offer = negotiation.offers.get(proposer)!;
      if (!negotiation.automatic.get(recipient) || world.time.slowTick - offer.revisedAtSlowTick < 10 || world.time.fastTick - war.startedAtFastTick < 300) continue;
      if (assessPeaceOffer(world, recipient, proposer, offer.terms).accepts && acceptPeaceOffer(world, recipient, proposer)) break;
    }
  }
}
