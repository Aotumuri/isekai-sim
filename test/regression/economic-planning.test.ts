import assert from "node:assert/strict";
import test from "node:test";
import { createUnitForType } from "../../src/sim/create-units";
import { getRelation } from "../../src/sim/diplomacy";
import { findTradeRoute, getInternationalTradeState, updateInternationalTrade } from "../../src/sim/international-trade";
import type { IndustrialProcurementObservation } from "../../src/sim/instrumentation";
import { updateProduction } from "../../src/sim/production";
import { EQUIPMENT_FAMILIES, getResearchPortfolio, updateResearch } from "../../src/sim/research";
import { assessIndustrialReserve } from "../../src/sim/resource-planning";
import { updateSupplyAssessment } from "../../src/sim/supply-assessment";
import { setTradeEmbargo } from "../../src/sim/trade-embargo";
import { createTreasury } from "../../src/sim/treasury";
import { createUnitId } from "../../src/sim/unit";
import { declareWar } from "../../src/sim/war-state";
import { createWorldCache } from "../../src/sim/world-cache";
import { createMacroRegionId } from "../../src/worldgen/macro-region";
import { createMesoRegionId } from "../../src/worldgen/meso-region";
import { createNationId } from "../../src/worldgen/nation";
import { createFixedSocietyWorld } from "../helpers/fixed-society-world";

function connectedMarkets(mode: "land" | "sea" | "unreachable" = "land") {
  const world = createFixedSocietyWorld();
  const seller = world.nations[0]!, buyer = world.nations[1]!;
  world.nations = [seller, buyer];
  world.units = [];
  if (mode !== "land") {
    const ids = [seller.capitalMesoId, buyer.capitalMesoId];
    const template = world.mesoRegions[0]!;
    const sea = template.id;
    const neighbors = (id: typeof sea) => [{ id, hasRiver: false }];
    world.mesoRegions = [
      ...ids.map((id, index) => ({ ...template, id, type: "land" as const, building: "port" as const,
        neighbors: mode === "unreachable" && index === 1 ? [] : neighbors(sea) })),
      { ...template, type: "sea", building: null, neighbors: ids.slice(0, mode === "unreachable" ? 1 : 2).flatMap(neighbors) },
    ];
    world.macroRegions = [seller, buyer].map((nation, index) => {
      const id = createMacroRegionId(index);
      nation.macroRegionIds = [id];
      return { id, nationId: nation.id, mesoRegionIds: [nation.capitalMesoId], isCore: true };
    });
    world.cache = createWorldCache();
    world.mapVersion++;
    world.territoryVersion++;
    world.buildingVersion++;
  }
  for (const nation of world.nations) {
    Object.assign(nation.resources, { steel: 120, weapons: 120, fuel: 120 });
    nation.treasury!.balance = 500;
    nation.resourceFlow = { ...nation.resourceFlow, lastTick: -1 };
    nation.nextUnitProductionTick = 10_000;
  }
  getRelation(world, seller.id, buyer.id).treaties.push({ type: "trade", expiresAtSlowTick: 1000 });
  updateSupplyAssessment(world);
  return { world, seller, buyer };
}

test("ample peacetime weapons preserve scarce steel and production resumes after stock is used", () => {
  const run = (economicPlanningEnabled: boolean) => {
    const { world, buyer } = connectedMarkets();
    world.settings!.economicPlanningEnabled = economicPlanningEnabled;
    buyer.resources.steel = 8;
    buyer.resources.weapons = 500;
    updateProduction(world);
    return { world, buyer };
  };
  const before = run(false).buyer;
  const { world, buyer } = run(true);
  assert(before.resources.weapons > 500);
  assert.equal(buyer.resources.weapons, 500);
  assert(buyer.resources.steel > before.resources.steel);
  buyer.resources.weapons = 25;
  buyer.resources.steel = 100;
  const output: number[] = [];
  for (let tick = 1; tick <= 12; tick++) {
    world.time.slowTick = tick;
    updateProduction(world);
    output.push(buyer.resourceFlow.industry!.output.weapons);
  }
  assert(output[0]! > 0);
  assert(output.slice(2).every((value) => value === 0));
});

test("an ongoing war raises replacement reserves and draws steel into weapons", () => {
  const run = (atWar: boolean) => {
    const { world, seller, buyer } = connectedMarkets();
    buyer.character = { doctrine: "guardian", aggression: 0.35, cooperation: 0.8, innovation: 0.55, thrift: 0.5 };
    buyer.resources.weapons = 35;
    if (atWar) assert(declareWar(world.wars, buyer.id, seller.id, 0));
    updateProduction(world);
    return buyer.resourceFlow.industry!;
  };
  const peace = run(false), war = run(true);
  assert.equal(peace.output.weapons, 0);
  assert(war.weaponsTarget > peace.weaponsTarget);
  assert(war.output.weapons > 0);
});

test("a solvent buyer pays a surplus exporter, with each side of escrow delivered once", () => {
  const { world, seller, buyer } = connectedMarkets();
  buyer.resources.steel = 0;
  const totalCash = buyer.treasury!.balance + seller.treasury!.balance;
  const totalSteel = seller.resources.steel + buyer.resources.steel;
  updateInternationalTrade(world);
  const state = getInternationalTradeState(world);
  const deal = state.deals[0]!;
  assert.equal(deal.requestedResource, "cash");
  assert.equal(deal.offeredResource, "steel");
  assert.equal(deal.industrialPurchase, true);
  assert.equal(deal.offeredAmount, 36);
  assert.equal(buyer.resources.steel, 0);
  assert.equal(seller.resources.steel + deal.offeredAmount, totalSteel);
  assert.equal(buyer.treasury!.balance + seller.treasury!.balance + deal.requestedAmount, totalCash);
  world.time.slowTick = deal.arrivesAtSlowTick;
  updateInternationalTrade(world);
  updateInternationalTrade(world);
  assert(Math.abs(buyer.treasury!.balance + seller.treasury!.balance - totalCash) < 1e-9);
  assert.equal(seller.resources.steel + buyer.resources.steel, totalSteel);
  assert.equal(buyer.resources.steel, deal.offeredAmount);
  assert.equal(state.procurement!.delivered, 1);
});

test("a limited budget buys a smaller shipment while retaining cash for essential needs", () => {
  const { world, buyer } = connectedMarkets();
  buyer.resources.steel = 0;
  buyer.food = undefined;
  buyer.treasury!.lastRevenue = 0;
  buyer.treasury!.balance = 15;
  updateInternationalTrade(world);
  const deal = getInternationalTradeState(world).deals[0]!;
  assert(deal.offeredAmount >= 1 && deal.offeredAmount < 36);
  assert.equal(buyer.treasury!.balance, 10);
  assert.equal(deal.requestedAmount, 5);
});

test("cash, seller reserves, and a valid agreement each constrain purchases independently", () => {
  for (const constraint of ["cash", "seller-reserve", "invalid-agreement", "embargo"] as const) {
    const { world, seller, buyer } = connectedMarkets();
    buyer.resources.steel = 0;
    if (constraint === "cash") buyer.treasury!.balance = 10;
    if (constraint === "seller-reserve") seller.resources.steel = 36;
    if (constraint === "invalid-agreement") getRelation(world, seller.id, buyer.id).treaties[0]!.expiresAtSlowTick = 0;
    if (constraint === "embargo") assert(setTradeEmbargo(world, seller.id, buyer.id, true));
    const before = [buyer.treasury!.balance, seller.resources.steel];
    updateInternationalTrade(world);
    assert.deepEqual(getInternationalTradeState(world).deals, [], constraint);
    assert.deepEqual([buyer.treasury!.balance, seller.resources.steel], before, constraint);
  }
});

function fuelShortage(mode: "land" | "sea" | "unreachable") {
  const fixture = connectedMarkets(mode);
  const { world, buyer } = fixture;
  buyer.resources.fuel = 0;
  for (let index = 0; index < 3; index++) {
    world.units.push(createUnitForType(createUnitId(world.unitIdCounter++), buyer.id, buyer.capitalMesoId, "Tank"));
  }
  updateProduction(world);
  return fixture;
}

test("fuel usage records only consumed units and keeps requested upkeep distinct", () => {
  const { buyer } = fuelShortage("land");
  const industry = buyer.resourceFlow.industry!;
  assert.equal(industry.fuelDemand, 9);
  assert.equal(industry.fuelConsumed, 3);
  assert.equal(buyer.resourceFlow.usage.fuel, 3);
  assert.equal(buyer.resources.fuel, 0);
});

test("reserve recovery counts domestic production after covering ongoing consumption", () => {
  const { buyer } = fuelShortage("land");
  const industry = buyer.resourceFlow.industry!;
  industry.fuelDemand = 19;
  industry.output.fuel = 20;
  assert(assessIndustrialReserve(buyer, "fuel", false).shortage > 0);
  industry.output.fuel = 40;
  assert.equal(assessIndustrialReserve(buyer, "fuel", false).shortage, 0);
});

test("an unaffordable peacetime tank expansion recruits infantry with available weapons", () => {
  const { world, buyer } = fuelShortage("land");
  world.settings!.mobilizationEnabled = false;
  buyer.nextUnitProductionTick = 1;
  buyer.resources.manpower = 10_000;
  buyer.resources.weapons = 500;
  const nextId = world.unitIdCounter;
  world.time.slowTick = 1;
  updateProduction(world);
  assert(world.unitIdCounter > nextId);
  assert(world.units.slice(3).every((unit) => unit.nationId === buyer.id && unit.type === "Infantry"));
});

test("a peacetime prototype buffer consumes real domestic fuel and yields to wartime upkeep", () => {
  const { world, buyer, seller } = fuelShortage("land");
  for (const family of EQUIPMENT_FAMILIES) getResearchPortfolio(world, buyer.id, family).priority = family === "Tank" ? "high" : "paused";
  updateResearch(world);
  const program = getResearchPortfolio(world, buyer.id, "Tank");
  assert.equal(program.totalScience, 0);
  for (let tick = 1; tick <= 15; tick++) {
    const initialFuel = buyer.resources.fuel;
    world.time.slowTick = tick;
    updateProduction(world);
    updateResearch(world);
    assert(Math.abs(initialFuel + buyer.resourceFlow.industry!.output.fuel -
      buyer.resourceFlow.usage.fuel - buyer.resources.fuel) < 1e-9);
    assert.equal(buyer.resourceFlow.productionSurplus!.fuel, 0);
  }
  assert(program.totalScience > 0);
  // One full upkeep payment in stock, plus one from the next cycle's deposit.
  buyer.resources.fuel = 3;
  assert(declareWar(world.wars, buyer.id, seller.id, 0));
  world.time.slowTick++;
  updateProduction(world);
  assert.equal(buyer.resourceFlow.industry!.prototypeFuelReserve, 0);
  assert.equal(buyer.resourceFlow.industry!.fuelConsumed, 6);
  assert.equal(buyer.resources.fuel, 0);
});

test("zero-fuel buyer can charter imports with seller fuel and reimburse freight", () => {
  const { world, buyer, seller } = fuelShortage("sea");
  const cash = buyer.treasury!.balance + seller.treasury!.balance;
  const fuel = seller.resources.fuel;
  assert(findTradeRoute(world, seller.id, buyer.id)?.maritime);
  updateInternationalTrade(world);
  const state = getInternationalTradeState(world), deal = state.deals[0]!;
  assert.equal(deal.offeredResource, "fuel");
  assert.equal(deal.offeredAmount, 60);
  assert.equal(state.fuelSpent, 2);
  assert.equal(seller.resources.fuel, fuel - deal.offeredAmount - state.fuelSpent);
  assert(deal.requestedAmount > (deal.offeredAmount + state.fuelSpent) * 1.4);
  state.procurement!.lastReview = deal.arrivesAtSlowTick;
  world.time.slowTick = deal.arrivesAtSlowTick;
  updateInternationalTrade(world);
  assert.equal(buyer.resources.fuel, 60);
  assert.equal(buyer.resources.fuel + seller.resources.fuel + state.fuelSpent, fuel);
  assert(Math.abs(buyer.treasury!.balance + seller.treasury!.balance - cash) < 1e-9);
});

test("unreachable ports are retried with a delay and cannot deliver fuel", () => {
  const { world, buyer, seller } = fuelShortage("unreachable");
  assert.equal(findTradeRoute(world, seller.id, buyer.id), null);
  updateInternationalTrade(world);
  const state = getInternationalTradeState(world);
  assert.equal(state.procurement!.attempted, 1);
  for (const tick of [5, 10, 15]) {
    world.time.slowTick = tick;
    updateInternationalTrade(world);
    assert.equal(state.procurement!.attempted, tick < 15 ? 1 : 2);
    assert.equal(state.deals.length, 0);
    assert.equal(buyer.resources.fuel, 0);
  }
});

test("a maritime exporter keeps its own fuel reserve and a new embargo refunds escrow", () => {
  const { world, buyer, seller } = fuelShortage("sea");
  const initialCash = buyer.treasury!.balance;
  seller.resources.fuel = 21;
  updateInternationalTrade(world);
  const state = getInternationalTradeState(world);
  assert.equal(state.deals.length, 0);
  seller.resources.fuel = 120;
  world.time.slowTick = 5;
  updateInternationalTrade(world);
  const deal = state.deals[0]!;
  assert(setTradeEmbargo(world, buyer.id, seller.id, true));
  world.time.slowTick++;
  updateInternationalTrade(world);
  updateInternationalTrade(world);
  assert.equal(deal.status, "returned");
  assert.equal(state.procurement!.returned, 1);
  assert.equal(buyer.treasury!.balance, initialCash);
  assert.equal(buyer.resources.fuel, 0);
  assert.equal(seller.resources.fuel + state.fuelSpent, 120);
});

test("procurement observations distinguish demand, rejected routes, delivery, and returns", () => {
  for (const outcome of ["noCandidate", "noRoute", "rejected", "delivered", "returned"] as const) {
    const { world, buyer, seller } = fuelShortage(
      outcome === "noRoute" ? "unreachable" : outcome === "rejected" ? "sea" : "land");
    const samples: IndustrialProcurementObservation[] = [];
    world.instrumentation = {
      observeIndustrialProcurement: (sample) => samples.push(sample),
      recordDuration() {},
      incrementCounter() {},
    };
    if (outcome === "noCandidate") assert(setTradeEmbargo(world, buyer.id, seller.id, true));
    if (outcome === "rejected") {
      buyer.food = undefined;
      buyer.treasury!.lastRevenue = 0;
      buyer.treasury!.balance = 13;
    }
    updateInternationalTrade(world);
    const state = getInternationalTradeState(world);
    if (outcome === "delivered" || outcome === "returned") {
      const deal = state.deals[0]!;
      if (outcome === "returned") assert(setTradeEmbargo(world, buyer.id, seller.id, true));
      state.procurement!.lastReview = deal.arrivesAtSlowTick;
      world.time.slowTick = deal.arrivesAtSlowTick;
      updateInternationalTrade(world);
      const linked = samples.filter((sample) => "dealId" in sample && sample.dealId === deal.id);
      assert.deepEqual(linked.map((sample) => sample.phase), ["dispatched", outcome]);
      for (const sample of linked) {
        assert("quantity" in sample);
        assert.equal(sample.quantity, deal.offeredAmount);
      }
    }
    const observed = samples.filter((sample) => sample.buyerId === buyer.id && sample.resource === "fuel");
    assert.equal(observed[0]?.phase, "considered", outcome);
    assert(observed.some((sample) => sample.phase === outcome), outcome);
    assert.equal(samples.filter((sample) => ["dispatched", "rejected", "noRoute"].includes(sample.phase)).length,
      state.procurement!.attempted, outcome);
  }
});

test("prototype shortages lead to actual material purchases and restored research", () => {
  const { world, buyer, seller } = connectedMarkets();
  for (const nation of [seller, buyer]) Object.assign(nation.resources, { copper: 100, rubber: 100, tungsten: 100 });
  buyer.resources.tungsten = 0;
  updateProduction(world);
  for (const family of EQUIPMENT_FAMILIES) getResearchPortfolio(world, buyer.id, family).priority = family === "Tank" ? "high" : "paused";
  updateResearch(world);
  const program = getResearchPortfolio(world, buyer.id, "Tank");
  assert.equal(program.status, "saving resources");
  updateInternationalTrade(world);
  const state = getInternationalTradeState(world), deal = state.deals[0]!;
  assert.equal(deal.offeredResource, "tungsten");
  world.time.slowTick = deal.arrivesAtSlowTick;
  updateInternationalTrade(world);
  const imported = buyer.resources.tungsten;
  updateResearch(world);
  assert(program.lastScience > 0);
  assert(buyer.resources.tungsten < imported);
  assert.equal(program.status, "researching");
});

test("resource plans and delivered orders repeat exactly for the same seeded situation", () => {
  const run = () => {
    const { world, buyer, seller } = fuelShortage("sea");
    for (let tick = 1; tick <= 25; tick++) {
      world.time.slowTick = tick;
      updateProduction(world);
      updateResearch(world);
      updateInternationalTrade(world);
    }
    return { buyer, seller, trade: world.internationalTrade, events: world.events };
  };
  assert.deepEqual(run(), run());
});

test("a fuel buyer checks only three routes even among 220 eligible exporters", () => {
  const { world, buyer, seller } = fuelShortage("unreachable");
  const port = world.mesoRegions[0]!;
  for (let index = 2; index < 221; index++) {
    const id = createNationId(index);
    const capitalMesoId = createMesoRegionId(index + 1000);
    const macroId = createMacroRegionId(index);
    world.mesoRegions.push({ ...port, id: capitalMesoId, neighbors: [] });
    world.macroRegions.push({ id: macroId, nationId: id, mesoRegionIds: [capitalMesoId], isCore: true });
    world.nations.push({ ...seller, id, capitalMesoId, macroRegionIds: [macroId],
      resources: { ...seller.resources }, treasury: createTreasury(500) });
    getRelation(world, buyer.id, id).treaties.push({ type: "trade", expiresAtSlowTick: 1000 });
  }
  world.territoryVersion++;
  world.mapVersion++;
  world.buildingVersion++;
  updateSupplyAssessment(world);
  updateInternationalTrade(world);
  const state = getInternationalTradeState(world);
  assert.equal(state.procurement!.attempted, 3);
  assert.equal(state.deals.length, 0);
});
