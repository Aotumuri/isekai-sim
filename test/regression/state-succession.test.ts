import assert from "node:assert/strict";
import test from "node:test";
import { STRATEGIC_RESOURCES } from "../../src/data/strategic-resources";
import { prisonerGroupKey, repatriatePrisoners } from "../../src/sim/defeated-formations";
import { getRelation } from "../../src/sim/diplomacy";
import { getInternationalTradeState, updateInternationalTrade } from "../../src/sim/international-trade";
import { allMobilizedUnits } from "../../src/sim/mobilization";
import { designFromResearch, getResearchPortfolio, updateResearch } from "../../src/sim/research";
import { updateResourceReparations } from "../../src/sim/resource-reparations";
import { updateSurrender } from "../../src/sim/surrender";
import { getSubjectOverlord } from "../../src/sim/subject-governments";
import { integrateSubjectGovernment } from "../../src/sim/territorial-governance";
import { transferTerritories } from "../../src/sim/territory-transfer";
import { createUnitId, type UnitState } from "../../src/sim/unit";
import { declareWar } from "../../src/sim/war-state";
import { getMesoById, getOwnerByMesoId } from "../../src/sim/world-cache";
import { createFixedSocietyWorld, fixedSocietyDistrict } from "../helpers/fixed-society-world";

function integrationScene() {
  const world = createFixedSocietyWorld(), [overlord, subject, partner] = world.nations;
  world.settings!.politicalTurbulenceEnabled = true;
  world.time.slowTick = 200;
  subject.subjectGovernment = { overlordId: overlord.id, establishedAtFastTick: 0 };
  subject.governance = { policy: "assimilation", stability: 90, alignment: 1, diversity: 0, since: 0 };
  getRelation(world, overlord.id, subject.id).trust = 65;
  return { world, overlord, subject, partner, integrate: () => integrateSubjectGovernment(world, overlord.id, subject.id) };
}

test("peaceful integration conserves every stock, including both sides of trade escrow, and is deterministic", () => {
  function run() {
    const { world, overlord, subject, partner, integrate } = integrationScene();
    const keys = ["steel", "fuel", "weapons", "manpower", ...STRATEGIC_RESOURCES] as const;
    for (const [index, key] of keys.entries()) subject.resources[key] = index + 15;
    overlord.resources.copper = 7;
    delete overlord.resources.rubber;
    const expected = Object.fromEntries(keys.map((key) => [key, (overlord.resources[key] ?? 0) + subject.resources[key]!]));
    assert.equal(expected.copper, 26);

    // Reproduce a charter that has already withdrawn the subject's copper and the buyer's cash.
    expected.copper += 3;
    const trade = getInternationalTradeState(world);
    trade.deals.push({ id: "charter", sellerId: subject.id, buyerId: partner.id, offeredResource: "copper",
      requestedResource: "cash", offeredAmount: 3, requestedAmount: 8, status: "in-transit",
      route: { maritime: false, regionIds: [] }, arrivesAtSlowTick: 230 });
    const buyerBalance = partner.treasury!.balance;
    const cash = subject.treasury!.balance, grain = subject.food!.stock;
    subject.treasury!.spent.military = 22;
    subject.food!.shortageCycles = 4;
    subject.food!.deaths = 3;
    delete overlord.treasury;
    delete overlord.food;
    const people = world.regionalPopulations!.get(subject.capitalMesoId);
    assert(integrate());
    assert.deepEqual(overlord.resources, expected);
    assert(keys.every((key) => subject.resources[key] === 0));
    const funds = world.nations[0].treasury!, food = world.nations[0].food!;
    assert.equal(funds.balance, cash);
    assert.equal(funds.spent.military, 0);
    assert.equal(food.stock, grain);
    assert.equal(food.shortageCycles, 0);
    assert.equal(food.deaths, 0);
    assert.equal(subject.treasury!.balance, 0);
    assert.equal(subject.treasury!.spent.military, 22);
    assert.equal(subject.food!.stock, 0);
    assert.equal(subject.food!.deaths, 3);
    assert.equal(getOwnerByMesoId(world).get(subject.capitalMesoId), overlord.id);
    assert.equal(world.regionalPopulations!.get(subject.capitalMesoId), people);
    assert.equal(subject.macroRegionIds.length, 0);
    assert.equal(getSubjectOverlord(world, subject.id), undefined);
    assert.equal(trade.deals[0].status, "returned");
    assert(!integrate());
    updateInternationalTrade(world);
    assert.equal(trade.returned, 1);
    assert.equal(partner.treasury!.balance, buyerBalance + 8);
    assert.deepEqual(overlord.resources, expected);
    return { stocks: overlord.resources, funds, food, provinces: world.macroRegions, events: world.events };
  }
  assert.deepEqual(run(), run());
});

test("integration inherits forces and completed research while preserving cargo and equipment provenance", () => {
  const { world, overlord, subject, partner, integrate } = integrationScene();
  const unit = world.units.find((item) => item.nationId === subject.id)!;
  const research = getResearchPortfolio(world, subject.id);
  research.levels.firepower = 14;
  research.progress.firepower = 170;
  research.completedProjects = 14;
  research.totalScience = 700;
  getResearchPortfolio(world, subject.id, "CombatShip").levels.armor = 3;
  const domestic = getResearchPortfolio(world, overlord.id);
  domestic.levels.reliability = 2;
  domestic.progress.reliability = 22;
  domestic.progress.firepower = 31;
  const design = designFromResearch(subject.id, research.levels);
  unit.design = design;
  const sea = fixedSocietyDistrict(5, 0);
  const fleet: UnitState = { ...unit, id: createUnitId(world.unitIdCounter++), type: "TransportShip",
    domain: "naval", regionId: sea, cargoUnits: [unit], design: undefined };
  const routed: UnitState = { ...unit, id: createUnitId(world.unitIdCounter++), cargoUnits: [], regionId: subject.capitalMesoId };
  const visitor: UnitState = { ...unit, id: createUnitId(world.unitIdCounter++), cargoUnits: [], regionId: partner.capitalMesoId,
    moveToId: overlord.capitalMesoId };
  world.units = world.units.filter((item) => item !== unit);
  world.units.push(fleet, visitor);
  const captives = { captor: partner.id, belligerent: subject.id, home: subject.id, manpower: 50, releaseAt: 200 };
  world.defeatedFormations = {
    withdrawals: new Map([[routed.id, { unit: routed, destination: routed.regionId, arrived: true, arrivalTick: 0 }]]),
    prisoners: new Map([[prisonerGroupKey(partner.id, subject.id, subject.id), captives]]),
    capturedManpower: 50, missingManpower: 0, recoveredManpower: 0, repatriatedManpower: 0, displacedManpower: 0,
  };
  const before = allMobilizedUnits(world).map(({ id }) => id).sort();
  const manpower = overlord.resources.manpower + subject.resources.manpower;
  assert(integrate());
  assert.deepEqual(allMobilizedUnits(world).map(({ id }) => id).sort(), before);
  assert.deepEqual(fleet.cargoUnits, [unit]);
  assert.equal(unit.regionId, fleet.regionId);
  assert.equal(fleet.regionId, sea);
  for (const inherited of [unit, fleet, routed, visitor]) assert.equal(inherited.nationId, overlord.id);
  assert.equal(visitor.regionId, overlord.capitalMesoId);
  assert.equal(visitor.moveToId, null);
  assert.equal(unit.design, design);
  assert.equal(unit.design.manufacturerId, subject.id);
  assert.equal(domestic.levels.firepower, 14);
  assert.equal(domestic.progress.firepower, 0);
  assert.equal(domestic.levels.reliability, 2);
  assert.equal(domestic.progress.reliability, 22);
  assert.equal(domestic.completedProjects, 0);
  assert.equal(domestic.totalScience, 0);
  assert.equal(getResearchPortfolio(world, overlord.id, "CombatShip").levels.armor, 3);
  updateResearch(world);
  assert.equal(world.research!.byNationId.get(subject.id), research);
  assert.equal(research.completedProjects, 14);
  assert.equal(research.progress.firepower, 170);
  assert.equal(overlord.resources.manpower, manpower);
  repatriatePrisoners(world);
  assert.equal(world.defeatedFormations.prisoners.size, 0);
  assert.equal(overlord.resources.manpower, manpower + 50);
});

test("integration closes bilateral rights but continues third-party reparations", () => {
  const { world, overlord, subject, partner, integrate } = integrationScene();
  const relation = getRelation(world, subject.id, partner.id);
  relation.treaties.push({ type: "alliance", expiresAtSlowTick: 300 });
  partner.subjectGovernment = { overlordId: subject.id, establishedAtFastTick: 0 };
  const payment = { resource: "copper" as const, amount: 4, nextPaymentAt: 200, expiresAt: 300 };
  world.resourceReparations = [
    { ...payment, payerId: overlord.id, recipientId: subject.id },
    { ...payment, payerId: subject.id, recipientId: partner.id },
  ];
  subject.resources.copper = 19;
  const copper = (overlord.resources.copper ?? 0) + 19;
  const partnerCopper = partner.resources.copper ?? 0;
  assert(integrate());
  assert.equal(relation.treaties.length, 0);
  assert.equal(partner.subjectGovernment, undefined);
  assert.equal(world.resourceReparations.length, 1);
  assert.equal(world.resourceReparations[0].payerId, overlord.id);
  updateResourceReparations(world);
  assert.equal(overlord.resources.copper, copper - 4);
  assert.equal(partner.resources.copper, partnerCopper + 4);
  assert.equal(subject.resources.copper, 0);
});

test("invalid integration is atomic through both entry points", () => {
  const { world, overlord, subject, partner, integrate } = integrationScene();
  const districts = [...getOwnerByMesoId(world)].filter(([, id]) => id === subject.id).map(([id]) => id);
  const transfer = (regionIds = districts) => transferTerritories(world, [{ from: subject.id, to: overlord.id, regionIds }], "integration");
  getMesoById(world);
  let snapshot = structuredClone(world);
  assert(!transfer(districts.slice(1)));
  assert.deepEqual(structuredClone(world), snapshot);
  declareWar(world.wars, subject.id, partner.id, 0);
  snapshot = structuredClone(world);
  assert(!transfer());
  assert(!integrate());
  assert.deepEqual(structuredClone(world), snapshot);
});

test("an unrelated cession cannot demote an active capital at a former government's historic seat", () => {
  const world = createFixedSocietyWorld(), [a, b, c, historical] = world.nations;
  const oldCapital = historical.capitalMesoId;
  for (const macro of world.macroRegions) if (macro.nationId === historical.id) macro.nationId = b.id;
  b.macroRegionIds.push(...historical.macroRegionIds);
  historical.macroRegionIds = [];
  getMesoById(world).get(b.capitalMesoId)!.building = "city";
  b.capitalMesoId = oldCapital;
  world.territoryVersion++;
  const district = [...getOwnerByMesoId(world)].find(([, owner]) => owner === a.id)![0];
  assert(transferTerritories(world, [{ from: a.id, to: c.id, regionIds: [district] }]));
  assert.equal(getMesoById(world).get(oldCapital)!.building, "capital");
});

test("capitulation removes the defeated army but keeps a surviving fleet and cargo at sea", () => {
  const world = createFixedSocietyWorld(), [winner, loser, neutral] = world.nations;
  const oldCapital = loser.capitalMesoId;
  const port = fixedSocietyDistrict(5, 1), sea = fixedSocietyDistrict(5, 0);
  const unit = world.units.find((item) => item.nationId === neutral.id)!;
  const fleet: UnitState = { ...unit, id: createUnitId(world.unitIdCounter++), type: "TransportShip", domain: "naval",
    regionId: port, cargoUnits: [unit], moveToId: sea };
  world.units = world.units.filter((item) => item !== unit && item.nationId !== loser.id);
  world.units.push(fleet);
  declareWar(world.wars, winner.id, loser.id, 0);
  loser.resources.copper = 19;
  const oldStocks = { ...loser.resources }, victorStocks = { ...winner.resources };
  updateSurrender(world);
  assert.equal(loser.macroRegionIds.length, 0);
  assert.deepEqual(loser.resources, oldStocks);
  assert.deepEqual(winner.resources, victorStocks);
  assert.equal(getOwnerByMesoId(world).get(oldCapital), winner.id);
  assert.equal(getMesoById(world).get(oldCapital)!.building, "city");
  assert.equal(getMesoById(world).get(winner.capitalMesoId)!.building, "capital");
  assert.equal(world.wars.length, 0);
  assert(world.units.includes(fleet));
  assert.equal(fleet.regionId, sea);
  assert.equal(fleet.moveToId, null);
  assert.deepEqual(fleet.cargoUnits, [unit]);
  assert.equal(unit.regionId, sea);
});

test("a stale occupation cannot award a second capitulation to the government just eliminated", () => {
  const world = createFixedSocietyWorld(), [first, second] = world.nations;
  const secondCapital = second.capitalMesoId;
  world.units = world.units.filter((unit) => unit.nationId !== first.id && unit.nationId !== second.id);
  world.occupation.mesoById.set(secondCapital, first.id);
  declareWar(world.wars, first.id, second.id, 0);
  updateSurrender(world);
  assert.equal(first.macroRegionIds.length, 0);
  assert(second.macroRegionIds.length > 0);
  assert.equal(getOwnerByMesoId(world).get(secondCapital), second.id);
  assert(!world.occupation.mesoById.has(secondCapital));
  assert.equal(world.wars.length, 0);
});
