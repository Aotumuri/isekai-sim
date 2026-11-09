import assert from "node:assert/strict";
import test from "node:test";
import { canRevolt, getDomesticUnrest, updateDomesticUnrest } from "../../src/sim/domestic-unrest";
import { getRelation } from "../../src/sim/diplomacy";
import { FOOD_INTERVAL, updateFoodSupply } from "../../src/sim/food-supply";
import { updateFoodTrade } from "../../src/sim/food-trade";
import { findTradeRoute, proposeResourceTrade, updateInternationalTrade } from "../../src/sim/international-trade";
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
  const previous = buyer.food!.stock;
  world.time.slowTick = shipment.arrivesAtSlowTick;
  updateInternationalTrade(world);
  assert.equal(shipment.status, "delivered");
  assert.equal(buyer.food!.stock, previous + shipment.offeredAmount);
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
