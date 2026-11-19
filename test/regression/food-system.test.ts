import assert from "node:assert/strict";
import test from "node:test";
import { canRevolt, getDomesticUnrest, updateDomesticUnrest } from "../../src/sim/domestic-unrest";
import { getRelation } from "../../src/sim/diplomacy";
import { FAMINE_THRESHOLD, FOOD_INTERVAL, updateFoodSupply } from "../../src/sim/food-supply";
import { updateFoodTrade } from "../../src/sim/food-trade";
import { findTradeRoute, proposeResourceTrade, sendGrainAid, updateInternationalTrade } from "../../src/sim/international-trade";
import { enterPlayerNation } from "../../src/sim/player-nation";
import { createSimulationSettings } from "../../src/sim/simulation-settings";
import { installSubjectGovernment } from "../../src/sim/subject-governments";
import { setSubjectFoodLevy } from "../../src/sim/subject-food-levy";
import { updateSupplyAssessment } from "../../src/sim/supply-assessment";
import { setTradeEmbargo } from "../../src/sim/trade-embargo";
import { getAdjacentNationPairs, getOwnerByMesoId } from "../../src/sim/world-cache";
import { mapAgriculturalLand } from "../../src/worldgen/agricultural-land";
import { createMesoRegionId, type MesoRegion } from "../../src/worldgen/meso-region";
import { createMicroRegionId, type MicroRegion } from "../../src/worldgen/micro-region";
import { createSeededWorld } from "../helpers/seeded-world";

function scene() {
  const world = createSeededWorld({ quick: true });
  world.settings = createSimulationSettings();
  return world;
}

function tradingScene() {
  const world = scene();
  updateSupplyAssessment(world);
  const pair = getAdjacentNationPairs(world).find(([a, b]) => findTradeRoute(world, a, b));
  assert(pair);
  const seller = world.nations.find((nation) => nation.id === pair[0])!;
  const buyer = world.nations.find((nation) => nation.id === pair[1])!;
  seller.food!.stock = 1000;
  seller.food!.harvest = seller.food!.demand;
  buyer.treasury!.balance = 1000;
  const relation = getRelation(world, seller.id, buyer.id);
  relation.treaties.push({ type: "trade", expiresAtSlowTick: 300 });
  return { world, seller, buyer };
}

test("low river valleys have arable land and high peaks do not", () => {
  const cells: MicroRegion[] = [0.11, 0.11, 0.9].map((elevation, index) => ({
    id: createMicroRegionId(index), site: { x: 10, y: 50 }, polygon: [], neighbors: [],
    elevation, isSea: false, isRiver: index === 1, mesoRegionId: createMesoRegionId(index),
  }));
  cells[0]!.neighbors = [cells[1]!.id];
  const districts: MesoRegion[] = cells.map((cell) => ({
    id: cell.mesoRegionId!, centerId: cell.id, center: cell.site, type: "land",
    microRegionIds: [cell.id], neighbors: [], building: null, resource: null,
  }));
  const agriculture = mapAgriculturalLand(districts, cells, 0.05, 100);
  assert.equal(agriculture.get(districts[0]!.id)?.arableShare, 1);
  assert.equal(agriculture.get(districts[2]!.id)?.harvest, 0);
});

test("prolonged shortages reduce population and can cause revolt in peacetime", () => {
  const world = scene(), nation = world.nations[0]!;
  const ids = [...getOwnerByMesoId(world)].filter(([, owner]) => owner === nation.id).map(([id]) => id);
  for (const id of ids) world.agriculturalLand?.set(id, { arableShare: 0, harvest: 0 });
  nation.food!.stock = 0;
  const population = () => ids.reduce((sum, id) => sum + (world.regionalPopulations?.get(id)?.size ?? 0), 0);
  const before = population();
  getDomesticUnrest(world, nation.id);
  for (let cycle = 1; cycle <= 8; cycle++) {
    world.time.slowTick = cycle * FOOD_INTERVAL;
    updateFoodSupply(world);
    updateDomesticUnrest(world);
  }
  assert(nation.food!.deaths > 0);
  assert(Math.abs(before - population() - nation.food!.deaths) < 1e-8);
  assert.equal(world.wars.length, 0);
  assert(canRevolt(world, nation.id));
  for (const id of ids) {
    const people = world.regionalPopulations?.get(id);
    if (people) assert(Math.abs(people.ancestry.reduce((sum, count) => sum + count, 0) - people.size) < 1e-8);
  }
});

test("an embargo recalls in-transit grain and returns payment once", () => {
  const { world, seller, buyer } = tradingScene();
  assert(proposeResourceTrade(world, seller.id, buyer.id, "food", 20, "cash", 14));
  assert.equal(seller.food!.stock, 980);
  assert.equal(buyer.treasury!.balance, 986);
  assert(setTradeEmbargo(world, buyer.id, seller.id, true));
  world.time.slowTick = 1;
  updateInternationalTrade(world);
  updateInternationalTrade(world);
  assert.equal(seller.food!.stock, 1000);
  assert.equal(buyer.treasury!.balance, 1000);
  assert.equal(world.internationalTrade?.deals[0]?.status, "returned");
  assert(!proposeResourceTrade(world, seller.id, buyer.id, "food", 20, "cash", 14));
  assert(setTradeEmbargo(world, buyer.id, seller.id, false));
  assert(proposeResourceTrade(world, seller.id, buyer.id, "food", 20, "cash", 14));
});

test("a food deficit triggers an automatic cash purchase", () => {
  const { world, seller, buyer } = tradingScene();
  buyer.food!.stock = buyer.food!.harvest = 0;
  world.time.slowTick = FOOD_INTERVAL;
  updateFoodTrade(world);
  const shipment = world.internationalTrade?.deals.find((deal) => deal.sellerId === seller.id && deal.buyerId === buyer.id);
  assert.equal(shipment?.offeredResource, "food");
  assert.equal(shipment?.requestedResource, "cash");
  assert.equal(shipment?.status, "in-transit");
  assert(!shipment.humanitarian);
  const previous = buyer.food!.stock;
  world.time.slowTick = shipment.arrivesAtSlowTick;
  updateInternationalTrade(world);
  assert.equal(shipment.status, "delivered");
  assert.equal(buyer.food!.stock, previous + shipment.offeredAmount);
});

function reliefScene() {
  const { world, seller, buyer } = tradingScene();
  getRelation(world, seller.id, buyer.id).treaties.push({ type: "alliance", expiresAtSlowTick: 300 });
  buyer.treasury!.balance = buyer.food!.stock = buyer.food!.harvest = 0;
  seller.food!.stock = seller.food!.demand * 10 + buyer.food!.demand * FAMINE_THRESHOLD;
  for (const [id, owner] of getOwnerByMesoId(world)) {
    if (owner === buyer.id) world.agriculturalLand?.set(id, { arableShare: 0, harvest: 0 });
  }
  return { world, seller, buyer };
}

test("AI relief sustains rations in a cashless ally and conserves dispatched grain", () => {
  const { world, seller, buyer } = reliefScene();
  const stock = seller.food!.stock;
  world.time.slowTick = FOOD_INTERVAL;
  updateFoodTrade(world);
  updateFoodTrade(world);
  const deals = world.internationalTrade?.deals.filter((deal) => deal.buyerId === buyer.id);
  assert.equal(deals?.length, 1);
  const shipment = deals![0]!;
  assert(shipment.humanitarian);
  assert.equal(shipment.sellerId, seller.id);
  assert.equal(shipment.offeredAmount, buyer.food!.demand * FAMINE_THRESHOLD);
  assert.equal(seller.food!.stock + shipment.offeredAmount, stock);
  const cash = seller.treasury!.balance;
  world.time.slowTick = shipment.arrivesAtSlowTick;
  updateInternationalTrade(world);
  assert.equal(buyer.food!.stock, shipment.offeredAmount);
  assert.equal(seller.treasury!.balance, cash);
  assert.equal(buyer.treasury!.balance, 0);

  const control = reliefScene();
  const start = Math.ceil(shipment.arrivesAtSlowTick / FOOD_INTERVAL) * FOOD_INTERVAL;
  for (let offset = 0; offset < FAMINE_THRESHOLD; offset++) {
    world.time.slowTick = control.world.time.slowTick = start + offset * FOOD_INTERVAL;
    updateFoodSupply(world);
    updateFoodSupply(control.world);
    assert.equal(buyer.food!.rationCoverage, 1);
  }
  assert.equal(buyer.food!.deaths, 0);
  assert(control.buyer.food!.deaths > 0);
});

test("AI relief respects a protected grain reserve, embargoes and manual donor control", () => {
  for (const restriction of ["protected reserve", "embargo", "manual", "trade only"] as const) {
    const { world, seller, buyer } = reliefScene();
    if (restriction === "protected reserve") {
      seller.food!.protectGrainExports = true;
      seller.food!.stock = seller.food!.demand * 6;
    } else if (restriction === "embargo") assert(setTradeEmbargo(world, seller.id, buyer.id, true));
    else if (restriction === "manual") assert(enterPlayerNation(world, seller.id));
    else {
      const relation = getRelation(world, seller.id, buyer.id);
      relation.treaties = relation.treaties.filter((treaty) => treaty.type !== "alliance");
      relation.opinion = 25;
    }
    const stock = seller.food!.stock;
    world.time.slowTick = FOOD_INTERVAL;
    updateFoodTrade(world);
    assert.equal(seller.food!.stock, stock, restriction);
    assert(!world.internationalTrade?.deals.some((deal) => deal.humanitarian && deal.sellerId === seller.id), restriction);
  }
});

test("subject requisitions transfer a share of the harvest and stop under embargo", () => {
  const { world, seller: subject, buyer: overlord } = tradingScene();
  installSubjectGovernment(world, overlord.id, subject.id);
  assert(setSubjectFoodLevy(world, overlord.id, subject.id, 0.5));
  world.time.slowTick = FOOD_INTERVAL;
  updateFoodSupply(world);
  assert(subject.food!.harvest > 0);
  assert.equal(subject.food!.levy, -subject.food!.harvest * 0.5);
  assert.equal(overlord.food!.levy, -subject.food!.levy);
  assert(setTradeEmbargo(world, subject.id, overlord.id, true));
  world.time.slowTick += FOOD_INTERVAL;
  updateFoodSupply(world);
  assert.equal(subject.food!.levy, 0);
  assert.equal(overlord.food!.levy, 0);
});

test("grain aid reaches a recipient with an empty treasury without charging it", () => {
  const { world, seller, buyer } = tradingScene();
  buyer.treasury!.balance = 0;
  const before = buyer.food!.stock;
  assert(sendGrainAid(world, seller.id, buyer.id, 20));
  const deal = world.internationalTrade!.deals[0]!;
  assert(deal.humanitarian);
  world.time.slowTick = deal.arrivesAtSlowTick;
  updateInternationalTrade(world);
  assert.equal(deal.status, "delivered");
  assert.equal(buyer.treasury!.balance, 0);
  assert.equal(buyer.food!.stock, before + 20);
});

test("a low grain reserve warns once until the reserve recovers", () => {
  const world = scene(), nation = world.nations[0]!;
  for (const [id, owner] of getOwnerByMesoId(world)) if (owner === nation.id) {
    world.agriculturalLand?.set(id, { arableShare: 0, harvest: 0 });
  }
  nation.food!.stock = nation.food!.demand * 6;
  for (const tick of [10, 20]) {
    world.time.slowTick = tick;
    updateFoodSupply(world);
  }
  const warnings = () => world.events!.filter((event) => event.nationIds.includes(nation.id) && event.message.includes("grain reserve will last")).length;
  assert.equal(warnings(), 1);
  nation.food!.stock = nation.food!.demand * 15;
  world.time.slowTick = 30;
  updateFoodSupply(world);
  nation.food!.stock = nation.food!.demand * 6;
  world.time.slowTick = 40;
  updateFoodSupply(world);
  assert.equal(warnings(), 2);
});
