import { isPeaceNegotiationMature } from "./peace-maturity";
import { readPeaceAssessmentFact, type PeaceAssessmentContext } from "./peace-assessment-context";
import { campaignRecognitionRegions, campaignRecognitionWeapons, campaignCanHoldRecognition, reciprocalRecognitionTerms } from "./war-campaign/peace-recognition";
import { getCampaignObjectives } from "./campaign-objectives";
import { campaignContinuationPressure, campaignPeaceValue, campaignPrefersSettlement } from "./war-campaign/peace-guidance";
import { PEACE_OUTLOOK_LIMIT, PEACE_OUTLOOK_WEIGHT } from "./peace-outlook";
import { getManualGovernmentId } from "./player-nation";
import { isValidResourceReparation, REPARATION_INTERVAL, REPARATION_RESOURCES, type ResourceReparation } from "./resource-reparations";
import { foodReserveSeconds } from "./food-supply";
import { getNationalTerritorialValue, getTerritorialValue } from "./territorial-value";
import { getSeparatePeaceIssue } from "./separate-peace";
import { hasConferenceWar } from "./peace-conference";
import { dividePartitionResources, getPartitionIssue, planLocalSubject, planPuppetPartition, preparePartitionNation, type PuppetPartition } from "./puppet-partition";
import { estimateAnnexationResistance, recordAnnexation } from "./annexation";
import { getPuppetTermsIssue, installSubjectGovernment } from "./subject-governments";
import { getRelation } from "./diplomacy";
import { getPeaceBorderIssue, getWholeProvinces, selectPeaceDistricts, selectPeaceProvinces } from "./peace-borders";
import type { NationId } from "../worldgen/nation";
import type { MesoRegionId } from "../worldgen/meso-region";
import type { WorldState } from "./world-state";
import type { WarState } from "./war-state";
import { findWar, getWarCasualties } from "./war-state";
import { FAST_TICK_MS } from "./time";
import { getNationCharacter } from "./nation-character";
import { getNationName } from "./nation-identity";
import { getRevolutionRisk } from "./domestic-unrest";
import { allFieldUnits } from "./mobilization";
import { getUnitCombatStrength } from "./unit-strength";
import { getForeignClaims } from "./territorial-claims";
import { canTransferTerritories, transferTerritories, type TerritoryTransfer } from "./territory-transfer";
import { changeResource } from "./international-trade";
import { getNeighborsById, getOwnerByMesoId } from "./world-cache";
import { getWarDeclarationMode, hasPoliticalTurbulence, recordSimulationEvent } from "./simulation-settings";
import { concludePeace, getWarFatigue, warFatigueKey } from "./diplomatic-peace";

export interface PeaceTerms {
  demandedRegionIds: MesoRegionId[]; offeredRegionIds: MesoRegionId[];
  demandedWeapons: number; offeredWeapons: number; truceSeconds: number;
  resourceReparation?: ResourceReparation;
  puppetTarget?: boolean;
  partition?: PuppetPartition;
  localSubject?: boolean;
}
export interface PeaceOffer { proposerId: NationId; terms: PeaceTerms; revisedAtSlowTick: number; revision: number; source: "opening" | "automatic" | "manual" }
export interface WarNegotiation {
  key: string; a: NationId; b: NationId; openingPower: Map<NationId, number>;
  outlook?: { advantageA: number; trendA: number; sampledAtSlowTick: number };
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
function sampleWarOutlook(world: WorldState, negotiation: WarNegotiation): void {
  const advantage = getWarAdvantage(world, negotiation.a, negotiation.b);
  const old = negotiation.outlook;
  if (old && world.time.slowTick <= old.sampledAtSlowTick) return;
  const change = old ? (advantage - old.advantageA) * 30 / (world.time.slowTick - old.sampledAtSlowTick) : 0;
  const trend = Math.max(-PEACE_OUTLOOK_LIMIT, Math.min(PEACE_OUTLOOK_LIMIT, change));
  negotiation.outlook = { advantageA: advantage, trendA: old ? old.trendA * 0.4 + trend * 0.6 : 0, sampledAtSlowTick: world.time.slowTick };
}

export function getWarTrend(negotiation: WarNegotiation, nation: NationId): number {
  return (negotiation.outlook?.trendA ?? 0) * (nation === negotiation.a ? 1 : -1);
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
export function getPeaceTermsIssue(world: WorldState, proposer: NationId, target: NationId, terms: PeaceTerms, context?: PeaceAssessmentContext): string | null {
  const war = findWar(world.wars, proposer, target);
  if (!war || (war.cause !== "player-declaration" && getWarDeclarationMode(world) !== "diplomacy")) return "These nations are not negotiating an active war.";
  if (!Array.isArray(terms.demandedRegionIds) || !Array.isArray(terms.offeredRegionIds)) return "Select valid territories.";
  if (![terms.demandedWeapons, terms.offeredWeapons].every((amount) => Number.isInteger(amount) && amount >= 0 && amount <= 100) ||
    (terms.demandedWeapons > 0 && terms.offeredWeapons > 0) || !Number.isInteger(terms.truceSeconds) || terms.truceSeconds < 180 || terms.truceSeconds > 900) return "Check reparations and the truce duration.";
  if (terms.resourceReparation !== undefined && !isValidResourceReparation(terms.resourceReparation)) {
    return "Select a resource and demand between 1 and 10 units per delivery.";
  }
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
  if (terms.resourceReparation && (a.resources[terms.resourceReparation.resource] === undefined ||
    b.resources[terms.resourceReparation.resource] === undefined)) return "This resource is unavailable in this world.";
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
  const borderIssue = readPeaceAssessmentFact(context?.borderIssue, JSON.stringify(legs),
    () => getPeaceBorderIssue(world, legs));
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
function openingTerms(world: WorldState, war: WarState, proposer: NationId, target: NationId): PeaceTerms {
  const terms = whitePeaceTerms();
  const treasury = world.nations.find((nation) => nation.id === target)!.resources.weapons;
  terms.demandedWeapons = Math.min(60, Math.floor(treasury * 0.3));
  if (war.aggressorId === proposer && war.ultimatumRegionIds?.length) {
    terms.demandedRegionIds = [...war.ultimatumRegionIds];
    if (!getPeaceTermsIssue(world, proposer, target, terms)) return terms;
  }
  const candidates = candidateDistricts(world, proposer, target);
  terms.demandedRegionIds = selectPeaceProvinces(world, target, proposer, candidates);
  if (!terms.demandedRegionIds.length) {
    const owners = getOwnerByMesoId(world), neighbors = getNeighborsById(world);
    const capital = world.nations.find((nation) => nation.id === target)?.capitalMesoId;
    const border = ownedLand(world, target).filter((id) => id !== capital &&
      (!world.occupation.mesoById.has(id) || world.occupation.mesoById.get(id) === proposer) &&
      (neighbors.get(id) ?? []).some((neighbor) => owners.get(neighbor) === proposer));
    terms.demandedRegionIds = selectPeaceProvinces(world, target, proposer, border, 1);
    if (!terms.demandedRegionIds.length) terms.demandedRegionIds = selectPeaceDistricts(world, target, proposer, [...candidates, ...border], 1);
  }
  if (getPeaceTermsIssue(world, proposer, target, terms)) terms.demandedRegionIds = [];
  return terms;
}
function reviseTerms(world: WorldState, negotiation: WarNegotiation, proposer: NationId, target: NationId): PeaceTerms {
  const current = negotiation.offers.get(proposer)!.terms;
  const country = world.nations.find((nation) => nation.id === proposer)!;
  const opponent = world.nations.find((nation) => nation.id === target)!;
  const advantage = getWarAdvantage(world, proposer, target);
  const urgency = getPeaceUrgency(world, proposer);
  const exitValue = assessPeaceOffer(world, proposer, target, whitePeaceTerms()).score;
  const settling = campaignPrefersSettlement(world, proposer, target);
  const wantsCompromise = settling || exitValue > -18 || urgency >= 0.5 || getWarTrend(negotiation, proposer) < -0.16;
  const terms = { ...current, demandedWeapons: Math.min(current.demandedWeapons, Math.floor(opponent.resources.weapons)),
    offeredWeapons: Math.min(current.offeredWeapons, Math.floor(country.resources.weapons)) };

  const recognition = settling ? campaignRecognitionRegions(world, proposer, target) : [];
  const recognitionWeapons = settling ? campaignRecognitionWeapons(world, proposer, target) : 0;
  if (campaignCanHoldRecognition(world, proposer) && (recognition.length || recognitionWeapons > 0) &&
    (!recognition.every((id) => terms.demandedRegionIds.includes(id)) || terms.demandedWeapons !== recognitionWeapons)) {
    const recognized = { ...whitePeaceTerms(), demandedRegionIds: recognition,
      demandedWeapons: recognitionWeapons, truceSeconds: terms.truceSeconds };
    if (!getPeaceTermsIssue(world, proposer, target, recognized)) return recognized;
  }
  if (campaignCanHoldRecognition(world, proposer) && recognitionWeapons > 0 && terms.demandedWeapons === recognitionWeapons) return terms;

  if (wantsCompromise) {
    if (terms.resourceReparation) return { ...terms, resourceReparation: undefined };
    if (terms.partition) return { ...terms, partition: undefined };
    if (terms.puppetTarget) return { ...terms, puppetTarget: false };
    if (terms.localSubject) return { ...terms, localSubject: false };
    if (terms.demandedRegionIds.length) {
      const provinces = getWholeProvinces(world, target, terms.demandedRegionIds);
      const parcels = provinces?.map(({ mesoRegionIds }) => mesoRegionIds) ?? terms.demandedRegionIds.map((id) => [id]);
      const goals = new Set(settling ? getCampaignObjectives(world, proposer, target) : []);
      const isGoal = (parcel: MesoRegionId[]) => parcel.some((id) => goals.has(id));
      parcels.sort((a, b) => Number(isGoal(a)) - Number(isGoal(b)) ||
        getTerritorialValue(world, target, b) - getTerritorialValue(world, target, a));
      if (settling && parcels.every(isGoal) && terms.demandedWeapons > 0) {
        return { ...terms, demandedWeapons: Math.max(0, terms.demandedWeapons - 15) };
      }
      for (const parcel of parcels) {
        if (campaignCanHoldRecognition(world, proposer) && parcel.some((id) => recognition.includes(id))) continue;
        const removed = new Set(parcel);
        const reduced = { ...terms, demandedRegionIds: terms.demandedRegionIds.filter((id) => !removed.has(id)) };
        if (!getPeaceTermsIssue(world, proposer, target, reduced)) return reduced;
      }
      return campaignCanHoldRecognition(world, proposer) && recognition.length ? terms : { ...terms, demandedRegionIds: [] };
    }
    if (terms.demandedWeapons > 0) return { ...terms, demandedWeapons: Math.max(0, terms.demandedWeapons - 15) };
    if (exitValue >= 0 && (advantage < -0.15 || urgency >= 0.65)) {
      return { ...terms, offeredWeapons: Math.min(25, Math.floor(country.resources.weapons * 0.15), terms.offeredWeapons + 5),
        truceSeconds: 600 };
    }
    return terms;
  }

  if (advantage > 0.45 && getWarTrend(negotiation, proposer) >= -0.08 &&
    getNationCharacter(world, proposer).aggression >= 0.65 && !getPuppetTermsIssue(world, proposer, target)) {
    const partition = advantage > 0.65 ? planPuppetPartition(world, proposer, target, []) : undefined;
    const escalation = { ...whitePeaceTerms(), demandedWeapons: terms.demandedWeapons, puppetTarget: true, partition };
    if (!getPeaceTermsIssue(world, proposer, target, escalation)) return escalation;
  }

  if (advantage > 0.25 && getWarTrend(negotiation, proposer) >= 0.05 && !terms.puppetTarget && !terms.offeredRegionIds.length) {
    const candidates = [...new Set([...terms.demandedRegionIds, ...candidateDistricts(world, proposer, target)])]
      .filter((id) => estimateAnnexationResistance(world, proposer, id) < 0.55);
    const demands = selectPeaceProvinces(world, target, proposer, candidates);
    if (demands.length > terms.demandedRegionIds.length) {
      const localSubject = advantage > 0.35 && hasPoliticalTurbulence(world) &&
        demands.some((id) => estimateAnnexationResistance(world, proposer, id) >= 0.4) &&
        !!planLocalSubject(world, proposer, target, demands);
      const escalation = { ...terms, demandedRegionIds: demands, localSubject };
      if (!getPeaceTermsIssue(world, proposer, target, escalation)) return escalation;
    }
  }
  if (advantage > 0.3 && !terms.resourceReparation && !terms.offeredWeapons && !terms.offeredRegionIds.length) {
    const resource = REPARATION_RESOURCES.find((key) =>
      (country.resources[key] ?? Infinity) < 12 && (opponent.resources[key] ?? 0) >= 20);
    if (resource) return { ...terms, resourceReparation: { resource, amount: 3 } };
  }
  return terms;
}
export function getWarNegotiation(world: WorldState, war: WarState): WarNegotiation {
  const state = getWarNegotiationState(world), key = warFatigueKey(war);
  let negotiation = state.active.get(key);
  if (!negotiation) {
    negotiation = { key, a: war.nationAId, b: war.nationBId, openingPower: new Map([[war.nationAId, nationalPower(world, war.nationAId)], [war.nationBId, nationalPower(world, war.nationBId)]]), offers: new Map(), automatic: new Map(), lastRevisionSlowTick: new Map() };
    state.active.set(key, negotiation);
    sampleWarOutlook(world, negotiation);
    for (const [proposer, target] of [[negotiation.a, negotiation.b], [negotiation.b, negotiation.a]]) {
      negotiation.automatic.set(proposer, true); negotiation.lastRevisionSlowTick.set(proposer, world.time.slowTick);
      negotiation.offers.set(proposer, { proposerId: proposer, terms: openingTerms(world, war, proposer, target), revisedAtSlowTick: world.time.slowTick, revision: 0, source: "opening" });
    }
    recordSimulationEvent(world, { category: "diplomacy", nationIds: [negotiation.a, negotiation.b],
      message: `${getNationName(world, negotiation.a)} and ${getNationName(world, negotiation.b)} published opening peace conditions.` });
  }
  return negotiation;
}
function competingWarPressure(world: WorldState, nation: NationId, negotiatingWith: NationId): number {
  const ownPower = Math.max(1, nationalPower(world, nation));
  let pressure = 0;
  for (const war of world.wars) {
    if (war.nationAId !== nation && war.nationBId !== nation) continue;
    const enemy = war.nationAId === nation ? war.nationBId : war.nationAId;
    if (enemy === negotiatingWith) continue;
    pressure += Math.min(12, nationalPower(world, enemy) / ownPower * 9) +
      occupationRatio(world, nation, enemy) * 20;
  }
  return Math.min(25, pressure);
}

export function assessPeaceOffer(world: WorldState, recipient: NationId, proposer: NationId, terms: PeaceTerms, context?: PeaceAssessmentContext) {
  const issue = getPeaceTermsIssue(world, proposer, recipient, terms, context);
  if (issue) return { accepts: false, score: -Infinity, reason: issue };
  const war = findWar(world.wars, recipient, proposer)!, negotiation = getWarNegotiation(world, war);
  const nation = world.nations.find((item) => item.id === recipient)!, character = getNationCharacter(world, recipient);
  const power = readPeaceAssessmentFact(context?.power, recipient, () => nationalPower(world, recipient));
  const militaryLoss = Math.max(0, 1 - power / Math.max(1, negotiation.openingPower.get(recipient) ?? 1));
  const pair = `${recipient}:${proposer}`;
  const advantage = readPeaceAssessmentFact(context?.advantage, pair, () => getWarAdvantage(world, recipient, proposer));
  const fatigue = getWarFatigue(world, recipient, proposer);
  const ageSeconds = Math.max(0, world.time.fastTick - war.startedAtFastTick) * FAST_TICK_MS / 1000;
  const urgency = readPeaceAssessmentFact(context?.urgency, recipient, () => getPeaceUrgency(world, recipient));
  const domestic = urgency * 42;
  const forecast = campaignContinuationPressure(world, recipient, proposer) ??
    -getWarTrend(negotiation, recipient) * PEACE_OUTLOOK_WEIGHT;
  const competingWars = readPeaceAssessmentFact(context?.competingPressure, pair, () => competingWarPressure(world, recipient, proposer));
  const foodRunway = nation.food ? foodReserveSeconds(nation.food) : Infinity;
  const foodPressure = nation.food ? Math.max(0, 1 - foodRunway / 90) * 10 +
    (1 - nation.food.rationCoverage) * 10 : 0;
  const totalValue = readPeaceAssessmentFact(context?.territorialValue, recipient, () => getNationalTerritorialValue(world, recipient));
  const occupied = readPeaceAssessmentFact(context?.occupied, pair,
    () => ownedLand(world, recipient).filter((id) => world.occupation.mesoById.get(id) === proposer));
  const occupiedValue = getTerritorialValue(world, recipient, occupied) / totalValue;
  const pressure = fatigue * 0.7 + Math.min(18, ageSeconds * 0.025) + occupiedValue * 45 + militaryLoss * 15 + Math.max(0, -advantage) * 30 + (1 - nation.warCooperation) * 12 + domestic + forecast + competingWars + foodPressure;
  const occupiedSet = new Set(occupied);
  const securedDemands = terms.demandedRegionIds.filter((id) => occupiedSet.has(id));
  const landCost = (getTerritorialValue(world, recipient, terms.demandedRegionIds) -
    getTerritorialValue(world, recipient, securedDemands) * 0.35) / totalValue * 100 +
    (terms.demandedRegionIds.includes(nation.capitalMesoId) ? 25 : 0);
  const landBenefit = getTerritorialValue(world, recipient, terms.offeredRegionIds) / totalValue * 80;
  const reparation = terms.resourceReparation;
  const resourceCost = reparation ? reparation.amount * 2 + (terms.truceSeconds / REPARATION_INTERVAL - 1) * 0.4 : 0;
  const paymentCost = terms.demandedWeapons / Math.max(10, nation.resources.weapons) * 25 + resourceCost;
  const paymentBenefit = Math.min(18, terms.offeredWeapons * 0.5);
  const disposition = character.doctrine === "merchant" || character.doctrine === "isolationist" ? 12 : character.doctrine === "pragmatist" ? 8 : character.cooperation * 7;
  const resolve = 45 + (isFightOnGovernment(world, recipient) ? 35 : character.aggression * 8) + Math.max(0, advantage) * 25;
  // Replacements can restore combat strength, but they do not erase past casualties.
  const casualties = getWarCasualties(war, recipient);
  const politicalInvestment = Math.min(40, casualties / Math.max(1_000, negotiation.openingPower.get(recipient) ?? 0) * 45);
  const recognition = Math.max(0, landBenefit + paymentBenefit - landCost - paymentCost);
  const sacrificeCost = Math.max(0, politicalInvestment - recognition) * (1 - Math.min(0.85, urgency));
  // A longer truce secures the rear while forces move to other theaters.
  const truceValue = (terms.truceSeconds - 300) / 100 * (1 + competingWars / 12);
  const score = pressure + disposition + landBenefit + paymentBenefit + truceValue + campaignPeaceValue(world, recipient, proposer, terms) - landCost - paymentCost - resolve - sacrificeCost - (terms.partition ? 38 : terms.puppetTarget ? 25 : terms.localSubject ? 8 : 0);
  const exchangedBlows = casualties + getWarCasualties(war, proposer) > 0 ||
    occupationRatio(world, proposer, recipient) + occupationRatio(world, recipient, proposer) > 0;
  const matureEnough = isPeaceNegotiationMature(ageSeconds, exchangedBlows, urgency);
  if (!matureEnough) return { accepts: false, score, reason: "The government is waiting for battlefield evidence before accepting terms." };
  const reason = score >= 0 ? foodPressure >= 10 ? "The food emergency makes continued fighting too costly."
    : "Ending the war now is preferable to continued losses and domestic danger."
    : sacrificeCost > 8 && score + sacrificeCost >= 0 ? "The government needs gains it can justify against the casualties already suffered."
    : landCost + paymentCost > 25 ? "The requested concessions outweigh the current cost of continuing the war."
    : "The government expects a better outcome by continuing the war.";
  return { accepts: score >= 0, score, reason };
}
export function proposePeaceTerms(world: WorldState, proposer: NationId, target: NationId, terms: PeaceTerms): boolean {
  if (getPeaceTermsIssue(world, proposer, target, terms)) return false;
  const negotiation = getWarNegotiation(world, findWar(world.wars, proposer, target)!);
  const old = negotiation.offers.get(proposer)!;
  negotiation.offers.set(proposer, { proposerId: proposer, terms: { ...terms, demandedRegionIds: [...terms.demandedRegionIds], offeredRegionIds: [...terms.offeredRegionIds],
    ...(terms.resourceReparation ? { resourceReparation: { ...terms.resourceReparation } } : {}),
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
  if (terms.resourceReparation) {
    (world.resourceReparations ??= []).push({ ...terms.resourceReparation, payerId: recipient, recipientId: proposer,
      nextPaymentAt: world.time.slowTick + REPARATION_INTERVAL, expiresAt: truce.expiresAtSlowTick });
  }
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
/** Prefer a mutually acceptable recognition offer over a white peace that
 * returns the achieved goal. Never override manual policy or offer maturity. */
function settleOrAwaitCampaignRecognition(world: WorldState, negotiation: WarNegotiation): boolean {
  if (!negotiation.automatic.get(negotiation.a) || !negotiation.automatic.get(negotiation.b)) return false;
  for (const [proposer, recipient] of [[negotiation.a, negotiation.b], [negotiation.b, negotiation.a]]) {
    const ids = campaignRecognitionRegions(world, proposer, recipient);
    const weapons = campaignRecognitionWeapons(world, proposer, recipient);
    const offer = negotiation.offers.get(proposer)!;
    if (!(ids.length || weapons > 0) || !ids.every((id) => offer.terms.demandedRegionIds.includes(id)) ||
      weapons > 0 && offer.terms.demandedWeapons < weapons ||
      offer.terms.puppetTarget || offer.terms.partition || offer.terms.localSubject || offer.terms.resourceReparation) continue;
    if (!assessPeaceOffer(world, recipient, proposer, offer.terms).accepts ||
      !assessPeaceOffer(world, proposer, recipient, reciprocalRecognitionTerms(offer.terms)).accepts) continue;
    if (world.time.slowTick - offer.revisedAtSlowTick < 10) {
      if (campaignCanHoldRecognition(world, proposer)) return true;
      continue;
    }
    if (acceptPeaceOffer(world, recipient, proposer)) return true;
  }
  return false;
}

function tryMutualCompromise(world: WorldState, negotiation: WarNegotiation): boolean {
  const { a, b, automatic, offers } = negotiation;
  if (!automatic.get(a) || !automatic.get(b) || getSeparatePeaceIssue(world, a, b)) return false;
  const candidates: { proposer: NationId; recipient: NationId; terms: PeaceTerms; value: number }[] = [];
  for (const [proposer, recipient] of [[a, b], [b, a]]) {
    const requested = offers.get(proposer)!.terms.demandedWeapons;
    const stock = world.nations.find(({ id }) => id === recipient)!.resources.weapons;
    // Seek a face-saving payment against the announced demand, with a longer truce for both sides.
    for (const payment of new Set([0, Math.min(15, requested, Math.floor(stock))])) {
      const terms = { ...whitePeaceTerms(), demandedWeapons: payment, truceSeconds: 600 };
      const theirs = assessPeaceOffer(world, recipient, proposer, terms);
      const ours = assessPeaceOffer(world, proposer, recipient, { ...terms, demandedWeapons: 0, offeredWeapons: payment });
      if (theirs.accepts && ours.accepts) candidates.push({ proposer, recipient, terms, value: Math.min(theirs.score, ours.score) });
    }
  }
  const deal = candidates.sort((a, b) => b.value - a.value)[0];
  if (!deal) return false;
  const original = offers.get(deal.proposer)!;
  offers.set(deal.proposer, { ...original, terms: deal.terms, revisedAtSlowTick: world.time.slowTick, revision: original.revision + 1, source: "automatic" });
  if (!acceptPeaceOffer(world, deal.recipient, deal.proposer)) {
    offers.set(deal.proposer, original);
    return false;
  }
  recordSimulationEvent(world, { category: "diplomacy", nationIds: [a, b],
    message: `${a} and ${b} found a mutual compromise: a longer truce and ${deal.terms.demandedWeapons} weapons in reparations.` });
  return true;
}

export function updateWarNegotiations(world: WorldState): void {
  const wars = getWarDeclarationMode(world) === "diplomacy" ? world.wars
    : world.wars.filter((war) => war.cause === "player-declaration");
  if (!wars.length && getWarDeclarationMode(world) !== "diplomacy") return;
  const state = getWarNegotiationState(world), live = new Set(world.wars.map(warFatigueKey));
  for (const key of state.active.keys()) if (!live.has(key)) state.active.delete(key);
  for (const war of wars) getWarNegotiation(world, war);
  if (world.time.slowTick - state.lastAISlowTick < 10) return;
  state.lastAISlowTick = world.time.slowTick;
  const player = getManualGovernmentId(world);
  for (const war of [...wars]) {
    if (hasConferenceWar(world, war)) continue;
    const negotiation = getWarNegotiation(world, war);
    sampleWarOutlook(world, negotiation);
    for (const [proposer, target] of [[negotiation.a, negotiation.b], [negotiation.b, negotiation.a]]) {
      if (proposer !== player && negotiation.automatic.get(proposer) && world.time.slowTick - (negotiation.lastRevisionSlowTick.get(proposer) ?? 0) >= 30) {
        const old = negotiation.offers.get(proposer)!;
        const revised = reviseTerms(world, negotiation, proposer, target);
        const terms = getPeaceTermsIssue(world, proposer, target, revised) ? whitePeaceTerms() : revised;
        negotiation.lastRevisionSlowTick.set(proposer, world.time.slowTick);
        if (JSON.stringify(terms) !== JSON.stringify(old.terms)) {
          negotiation.offers.set(proposer, { proposerId: proposer, terms, revisedAtSlowTick: world.time.slowTick, revision: old.revision + 1, source: "automatic" });
          recordSimulationEvent(world, { category: "diplomacy", nationIds: [proposer, target],
            message: `${getNationName(world, proposer)} revised its peace terms: ${terms.demandedRegionIds.length} districts demanded, ${terms.demandedWeapons || -terms.offeredWeapons} weapons reparations.` });
        }
      }
    }
    if (negotiation.a !== player && negotiation.b !== player && settleOrAwaitCampaignRecognition(world, negotiation)) continue;
    let settled = false;
    for (const [recipient, proposer] of [[negotiation.a, negotiation.b], [negotiation.b, negotiation.a]]) {
      const offer = negotiation.offers.get(proposer)!;
      if (recipient === player || (proposer === player && offer.source !== "manual") || !negotiation.automatic.get(recipient) || world.time.slowTick - offer.revisedAtSlowTick < 10) continue;
      if (assessPeaceOffer(world, recipient, proposer, offer.terms).accepts && acceptPeaceOffer(world, recipient, proposer)) {
        settled = true;
        break;
      }
    }
    if (!settled && negotiation.a !== player && negotiation.b !== player && world.time.fastTick - war.startedAtFastTick >= 900) tryMutualCompromise(world, negotiation);
  }
}
