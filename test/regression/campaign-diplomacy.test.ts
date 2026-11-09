import assert from "node:assert/strict";
import test from "node:test";
import { getCampaignDeadline } from "../../src/sim/campaign-deadline";
import { getCampaignObjectives } from "../../src/sim/campaign-objectives";
import { getCrisisDeploymentReadiness, updateCrisisDeployments } from "../../src/sim/crisis-deployment";
import { getDiplomacyState, getRelation } from "../../src/sim/diplomacy";
import { getNationalMilitaryStrength, openDiplomaticCrisis, resolveCrisisPeacefully, startDiplomaticWar, updateDiplomaticCrises } from "../../src/sim/diplomatic-crises";
import { getWarFatigue, updateDiplomaticPeace } from "../../src/sim/diplomatic-peace";
import { getDomesticUnrest } from "../../src/sim/domestic-unrest";
import { getMobilization, updateMobilization } from "../../src/sim/mobilization";
import { repositionUnits } from "../../src/sim/nation/reposition-units";
import { updateNationFrontPlans } from "../../src/sim/nation-front-plans";
import { updateLandFronts } from "../../src/sim/land-fronts";
import { getWholeProvinces, selectPeaceProvinces } from "../../src/sim/peace-borders";
import { getRegionalPopulations } from "../../src/sim/regional-population";
import { createSimulationSettings } from "../../src/sim/simulation-settings";
import { updateStrategicThreatObservation } from "../../src/sim/strategic-threat-observation";
import { updateSupplyAssessment } from "../../src/sim/supply-assessment";
import { getTerritorialClaims } from "../../src/sim/territorial-claims";
import { assessPeaceOffer, getWarNegotiation, getPeaceTermsIssue, updateWarNegotiations, whitePeaceTerms } from "../../src/sim/war-negotiations";
import { addWarContribution, declareWar, findWar } from "../../src/sim/war-state";
import { getAdjacentNationPairs, getMesoById, getOwnerByMesoId } from "../../src/sim/world-cache";
import { createSeededWorld } from "../helpers/seeded-world";

function campaign() {
  const world = createSeededWorld({ seed: 101, quick: true, width: 960, height: 540 });
  world.settings = createSimulationSettings();
  const [aId, bId] = getAdjacentNationPairs(world)[0];
  const a = world.nations.find(({ id }) => id === aId)!;
  const b = world.nations.find(({ id }) => id === bId)!;
  const ratio = getNationalMilitaryStrength(world, b.id) / getNationalMilitaryStrength(world, a.id);
  for (const unit of world.units) if (unit.nationId === a.id) unit.manpower *= ratio * 1.2;
  a.resources.weapons = b.resources.weapons = 100;
  a.warCooperation = b.warCooperation = 1;
  a.character = b.character = { doctrine: "pragmatist", aggression: 0.6, cooperation: 0.5, innovation: 0.5, thrift: 0.5 };
  return { world, a, b };
}

test("large valid demands can span more than three provinces and carry through an ultimatum into war", () => {
  const { world } = campaign();
  const owners = getOwnerByMesoId(world);
  const parcels = getAdjacentNationPairs(world).flatMap(([a, b]) => [[a, b], [b, a]])
    .map(([a, b]) => ({ a, b, ids: selectPeaceProvinces(world, b, a, [...owners].filter(([, owner]) => owner === b).map(([id]) => id)) }))
    .find(({ b, ids }) => (getWholeProvinces(world, b, ids)?.length ?? 0) > 3);
  assert(parcels, "the map must contain a valid large cession");
  const { a, b, ids } = parcels;
  const ratio = getNationalMilitaryStrength(world, b) / getNationalMilitaryStrength(world, a);
  for (const unit of world.units) if (unit.nationId === a) unit.manpower *= ratio * 1.2;
  updateSupplyAssessment(world);
  updateStrategicThreatObservation(world);
  getDiplomacyState(world).influenceByNationId.set(a, 100);
  for (const id of ids) getTerritorialClaims(world).history.get(id)!.set(a, { heldTicks: 500, attachment: 70 });
  assert(openDiplomaticCrisis(world, a, b, ids));
  assert(startDiplomaticWar(world, a, b));
  const war = findWar(world.wars, a, b)!;
  const negotiation = getWarNegotiation(world, war);
  assert.deepEqual(getCampaignObjectives(world, a, b), ids);
  assert.deepEqual(negotiation.offers.get(a)!.terms.demandedRegionIds, ids);
  assert.equal(getPeaceTermsIssue(world, a, b, negotiation.offers.get(a)!.terms), null);
  const counter = negotiation.offers.get(b)!.terms;
  assert(counter.demandedRegionIds.length > 0 || counter.demandedWeapons > 0);
});

test("an ultimatum sends both sides to their own border, waits for assembly, and clears orders on settlement", () => {
  const { world, a, b } = campaign();
  updateSupplyAssessment(world);
  updateStrategicThreatObservation(world);
  getDiplomacyState(world).influenceByNationId.set(a.id, 100);
  assert(openDiplomaticCrisis(world, a.id, b.id));
  const relation = getRelation(world, a.id, b.id);
  const owners = getOwnerByMesoId(world), regions = getMesoById(world);
  for (const [nation, enemy] of [[a, b], [b, a]]) {
    const interior = [...regions.values()].find((region) => owners.get(region.id) === nation.id &&
      !region.neighbors.some(({ id }) => owners.get(id) === enemy.id));
    assert(interior);
    for (const unit of world.units) if (unit.nationId === nation.id && unit.domain === "land") unit.regionId = interior.id;
  }
  updateCrisisDeployments(world);
  repositionUnits(world, 100);
  for (const [nation, enemy] of [[a, b], [b, a]]) {
    assert(world.units.some((unit) => unit.nationId === nation.id && unit.moveTargetId &&
      owners.get(unit.moveTargetId) === nation.id &&
      regions.get(unit.moveTargetId)?.neighbors.some(({ id }) => owners.get(id) === enemy.id)));
  }
  assert.equal(getCrisisDeploymentReadiness(world, a.id, b.id), 0);
  world.time.slowTick = 30;
  updateDiplomaticCrises(world);
  assert.equal(world.wars.length, 0);
  assert.equal(relation.crisis?.deadlineSlowTick, 40);
  resolveCrisisPeacefully(world, a.id, b.id, "fixture settlement");
  updateCrisisDeployments(world);
  assert.equal(getCrisisDeploymentReadiness(world, a.id, b.id), undefined);
});

test("each side's exhaustion counts new losses once and past sacrifices can still hurt a white peace", () => {
  const { world, a, b } = campaign();
  const war = declareWar(world.wars, a.id, b.id, 0)!;
  getWarNegotiation(world, war);
  world.time.fastTick = 1000;
  const before = assessPeaceOffer(world, b.id, a.id, whitePeaceTerms()).score;
  addWarContribution(world.wars, a.id, b.id, 30_000);
  assert(assessPeaceOffer(world, b.id, a.id, whitePeaceTerms()).score < before);
  updateDiplomaticPeace(world);
  const fatigue = getWarFatigue(world, b.id, a.id);
  assert(fatigue > getWarFatigue(world, a.id, b.id));
  world.time.slowTick += 10;
  updateDiplomaticPeace(world);
  assert.equal(getWarFatigue(world, b.id, a.id), fatigue + 1);
});

test("automatic acceptance waits for contact, and severe unrest induces staged concessions", () => {
  const { world, a, b } = campaign();
  const war = declareWar(world.wars, a.id, b.id, 0)!;
  const negotiation = getWarNegotiation(world, war);
  const offer = { ...whitePeaceTerms(), offeredWeapons: 70, truceSeconds: 900 };
  world.time.fastTick = 310;
  assert.match(assessPeaceOffer(world, b.id, a.id, offer).reason, /battlefield evidence/);
  b.warCooperation = 0;
  const unrest = getDomesticUnrest(world, b.id);
  unrest.pressure = 95; unrest.lowSupportSeconds = 300;
  const initial = negotiation.offers.get(b.id)!;
  world.time.slowTick = 30;
  updateWarNegotiations(world);
  const revision = negotiation.offers.get(b.id)!;
  assert(revision.revision > initial.revision);
  assert(revision.terms.demandedRegionIds.length < initial.terms.demandedRegionIds.length ||
    revision.terms.demandedWeapons < initial.terms.demandedWeapons);
});

test("an additional enemy increases the value of an enforceable truce and occupation changes the price of a demand", () => {
  const { world, a, b } = campaign();
  declareWar(world.wars, a.id, b.id, 0);
  world.time.fastTick = 1000;
  const score = (seconds: number) => assessPeaceOffer(world, b.id, a.id, { ...whitePeaceTerms(), truceSeconds: seconds }).score;
  const baseTruce = score(600) - score(300);
  const c = world.nations.find(({ id }) => id !== a.id && id !== b.id)!;
  declareWar(world.wars, c.id, b.id, 0);
  assert(score(600) - score(300) > baseTruce);
  const target = getCampaignObjectives(world, a.id, b.id)[0];
  assert(target);
  const cost = () => score(300) - assessPeaceOffer(world, b.id, a.id, { ...whitePeaceTerms(), demandedRegionIds: [...getCampaignObjectives(world, a.id, b.id)] }).score;
  const unoccupied = cost();
  world.occupation.mesoById.set(target, a.id);
  world.occupation.version++;
  assert(cost() < unoccupied);
});

test("a valid opening window and a published objective reach the active front planner", () => {
  const { world, a, b } = campaign();
  const war = declareWar(world.wars, a.id, b.id, 0)!;
  war.cause = "diplomatic-crisis";
  const negotiation = getWarNegotiation(world, war);
  assert(getCampaignDeadline(world, a.id, b.id) <= 75);
  updateLandFronts(world);
  const sector = world.landFronts.operationalSectors.find((item) =>
    (item.nationAId === a.id && item.nationBId === b.id) || (item.nationBId === a.id && item.nationAId === b.id))!;
  assert(sector);
  const own = sector.sideA.nationId === a.id ? sector.sideA : sector.sideB;
  const enemy = own === sector.sideA ? sector.sideB : sector.sideA;
  own.strength = 1100; enemy.strength = 1000;
  const target = enemy.borderRegionIds[0];
  negotiation.offers.get(a.id)!.terms.demandedRegionIds = [target];
  updateNationFrontPlans(world);
  const plan = world.frontPlans.plans.find((item) => item.nationId === a.id && item.frontId === sector.id)!;
  assert.equal(plan.posture, "attack");
  assert(plan.reasonFlags.includes("closing-campaign-window"));
  assert(plan.reasonFlags.includes("declared-war-objective"));
});

test("the same deployed force produces less strain with a larger controlled population", () => {
  const { world, a } = campaign();
  const first = getMobilization(world, a.id);
  const population = getRegionalPopulations(world), owners = getOwnerByMesoId(world);
  for (const unit of world.units) if (unit.nationId === a.id) unit.manpower *= 10;
  world.time.slowTick = 100;
  updateMobilization(world);
  assert(first.burden > 0);
  const base = first.burden;
  first.burden = 0;
  first.continuousDeployment = 0;
  for (const [id, district] of population) if (owners.get(id) === a.id) district.size *= 4;
  world.time.slowTick += 100;
  updateMobilization(world);
  assert(first.burden < base);
});

test("rival demands can yield to a mutually acceptable longer truce", () => {
  const { world, a, b } = campaign();
  const war = declareWar(world.wars, a.id, b.id, 0)!;
  const negotiation = getWarNegotiation(world, war);
  world.time.fastTick = 1200; world.time.slowTick = 120;
  getDiplomacyState(world).fatigueByWarId.set(negotiation.key, 65);
  const hardTerms = { ...whitePeaceTerms(), demandedWeapons: 100 };
  for (const [nation, enemy] of [[a, b], [b, a]]) {
    negotiation.lastRevisionSlowTick.set(nation.id, world.time.slowTick);
    negotiation.offers.get(nation.id)!.terms = hardTerms;
    assert(!assessPeaceOffer(world, enemy.id, nation.id, hardTerms).accepts);
  }
  updateWarNegotiations(world);
  assert(!findWar(world.wars, a.id, b.id));
  assert.equal(world.warNegotiations?.settlements[0]?.terms.truceSeconds, 600);
});

test("a collapsing food reserve makes fighting on less attractive at the same military strength", () => {
  const { world, a, b } = campaign();
  declareWar(world.wars, a.id, b.id, 0);
  world.time.fastTick = 1000;
  b.food = { stock: 200, demand: 20, harvest: 10, rationCoverage: 1, shortageCycles: 0, deaths: 0 };
  const supplied = assessPeaceOffer(world, b.id, a.id, whitePeaceTerms()).score;
  b.food.stock = 0;
  b.food.rationCoverage = 0.3;
  assert(assessPeaceOffer(world, b.id, a.id, whitePeaceTerms()).score > supplied);
});
