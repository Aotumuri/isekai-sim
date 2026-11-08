import assert from "node:assert/strict";
import test from "node:test";
import { getDiplomacyState, getRelation, proposeTreaty } from "../../src/sim/diplomacy";
import { findTradeRoute, getInternationalTradeState, proposeResourceTrade, updateInternationalTrade } from "../../src/sim/international-trade";
import { getAdjacentNationPairs } from "../../src/sim/world-cache";
import { updateSupplyAssessment } from "../../src/sim/supply-assessment";
import { declareWar } from "../../src/sim/war-state";
import { createSocietyWorld } from "../helpers/society-world";

function tradingWorld() {
  const world = createSocietyWorld(); updateSupplyAssessment(world);
  const pair = getAdjacentNationPairs(world).find(([a, b]) => findTradeRoute(world, a, b));
  assert(pair);
  const a = world.nations.find((nation) => nation.id === pair[0])!, b = world.nations.find((nation) => nation.id === pair[1])!;
  a.resources = { ...a.resources, steel: 100, weapons: 30, fuel: 100 };
  b.resources = { ...b.resources, steel: 30, weapons: 100, fuel: 100 };
  const relation = getRelation(world, a.id, b.id); relation.opinion = 80; relation.trust = 80;
  getDiplomacyState(world).influenceByNationId.set(a.id, 100);
  assert(proposeTreaty(world, a.id, b.id, "trade"));
  return { world, a, b };
}

test("resource exchanges escrow both sides and deliver without creating resources", () => {
  const { world, a, b } = tradingWorld();
  const totals = { steel: a.resources.steel + b.resources.steel, weapons: a.resources.weapons + b.resources.weapons };
  assert(proposeResourceTrade(world, a.id, b.id, "steel", 12, "weapons", 5));
  assert.equal(a.resources.steel, 88); assert.equal(b.resources.weapons, 95);
  const state = getInternationalTradeState(world), deal = state.deals[0]!;
  assert.equal(deal.status, "in-transit");
  world.time.slowTick = deal.arrivesAtSlowTick; state.lastAISlowTick = world.time.slowTick;
  updateInternationalTrade(world);
  assert.equal(deal.status, "delivered");
  assert.equal(a.resources.steel + b.resources.steel, totals.steel);
  assert.equal(a.resources.weapons + b.resources.weapons, totals.weapons);
  assert.equal(a.resources.weapons, 35);
  updateInternationalTrade(world);
  assert.equal(a.resources.weapons, 35);
});

test("war interrupts trade and returns escrow instead of giving either side free imports", () => {
  const { world, a, b } = tradingWorld();
  assert(proposeResourceTrade(world, a.id, b.id, "steel", 12, "weapons", 5));
  declareWar(world.wars, a.id, b.id, 0);
  updateInternationalTrade(world);
  assert.equal(getInternationalTradeState(world).deals[0]!.status, "returned");
  assert.equal(a.resources.steel, 100); assert.equal(b.resources.weapons, 100);
});

test("trade rejects unfair prices, invalid amounts, depleted reserves and duplicate shipments", () => {
  const { world, a, b } = tradingWorld();
  assert.equal(proposeResourceTrade(world, a.id, b.id, "steel", 1, "weapons", 20), false);
  assert.equal(proposeResourceTrade(world, a.id, b.id, "steel", NaN, "weapons", 5), false);
  assert.equal(proposeResourceTrade(world, a.id, b.id, "steel", 99, "weapons", 41.25), false);
  assert(proposeResourceTrade(world, a.id, b.id, "steel", 12, "weapons", 5));
  assert.equal(proposeResourceTrade(world, a.id, b.id, "steel", 12, "weapons", 5), false);
});

test("AI trades complementary surpluses and suspends dispatch when trading is disabled", () => {
  const { world } = tradingWorld();
  updateInternationalTrade(world);
  assert(getInternationalTradeState(world).deals.length > 0);
  world.settings!.tradeEnabled = false;
  world.time.slowTick += 20;
  updateInternationalTrade(world);
  assert(getInternationalTradeState(world).deals.every((deal) => deal.status !== "in-transit"));
});

test("maritime trade pays charter fuel and returns cargo when a third-party navy blockades its route", async () => {
  const { createMacroRegionId } = await import("../../src/worldgen/macro-region");
  const { createWorldCache } = await import("../../src/sim/world-cache");
  const { createUnitForType } = await import("../../src/sim/create-units");
  const { createUnitId } = await import("../../src/sim/unit");
  const world = createSocietyWorld(), [a, b, c] = world.nations.slice(0, 3);
  assert(a && b && c);
  const ids = [a.capitalMesoId, b.capitalMesoId, c.capitalMesoId];
  const sea = "trade-sea" as typeof a.capitalMesoId;
  const template = world.mesoRegions[0]!;
  world.mesoRegions = [...ids.map((id) => ({ ...template, id, type: "land" as const, building: "port" as const,
    neighbors: [{ id: sea, hasRiver: false }] })), { ...template, id: sea, type: "sea", building: null,
    neighbors: ids.map((id) => ({ id, hasRiver: false })) }];
  world.nations = [a, b, c];
  world.macroRegions = [a, b, c].map((nation, index) => {
    const id = createMacroRegionId(index); nation.macroRegionIds = [id];
    return { id, nationId: nation.id, mesoRegionIds: [ids[index]!], isCore: true };
  });
  world.units = []; world.cache = createWorldCache(); world.mapVersion += 1; world.territoryVersion += 1; world.buildingVersion += 1;
  a.resources.steel = 100; a.resources.fuel = 100; b.resources.weapons = 100;
  updateSupplyAssessment(world);
  const relation = getRelation(world, a.id, b.id); relation.opinion = 80; relation.trust = 80;
  assert(proposeTreaty(world, a.id, b.id, "trade"));
  assert(proposeResourceTrade(world, a.id, b.id, "steel", 12, "weapons", 5));
  assert(a.resources.fuel < 100);
  const paidFuel = a.resources.fuel;
  world.units.push(createUnitForType(createUnitId(world.unitIdCounter++), c.id, sea, "CombatShip"));
  declareWar(world.wars, a.id, c.id, 0);
  updateInternationalTrade(world);
  assert.equal(getInternationalTradeState(world).deals[0]!.status, "returned");
  assert.equal(a.resources.steel, 100);
  assert.equal(a.resources.fuel, paidFuel);
});
