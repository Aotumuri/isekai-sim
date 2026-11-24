import assert from "node:assert/strict";
import test from "node:test";
import { createUnitForType } from "../../src/sim/create-units";
import { getInternationalTradeState, updateInternationalTrade } from "../../src/sim/international-trade";
import { updateProduction } from "../../src/sim/production";
import { createUnitId } from "../../src/sim/unit";
import { createNationId } from "../../src/worldgen/nation";
import { worldSignature } from "../diagnostics/world-signature";
import { createFixedSocietyWorld, fixedSocietyDistrict } from "../helpers/fixed-society-world";

function upkeepScene(stock: number) {
  const world = createFixedSocietyWorld();
  const nation = world.nations[0]!;
  world.nations = [nation];
  for (const district of world.mesoRegions) if (district.resource === "fuel") district.resource = null;
  nation.resources.fuel = stock;
  nation.nextUnitProductionTick = 10_000;
  world.units = [0, 1, 2].map(() => createUnitForType(
    createUnitId(world.unitIdCounter++), nation.id, nation.capitalMesoId, "Tank",
  ));
  return { world, nation };
}

test("fuel allocation fully funds only affordable units and carries fractional stock", () => {
  for (const [stock, paid, funded] of [[12, 9, 3], [9, 9, 3], [4, 3, 1], [2, 0, 0], [0, 0, 0]] as const) {
    const { world, nation } = upkeepScene(stock);
    const last = world.units[2]!;
    last.moveToId = nation.capitalMesoId;
    updateProduction(world);
    assert.equal(nation.resourceFlow.industry!.fuelDemand, 9);
    assert.equal(nation.resourceFlow.industry!.fuelConsumed, paid);
    assert.equal(nation.resources.fuel, stock - paid);
    assert.deepEqual(world.units.map((unit) => unit.combatPower > 0),
      [0, 1, 2].map((index) => index < funded));
    assert.equal(Number.isFinite(last.moveTicksPerRegion), funded === 3);
    if (funded !== 3) assert.equal(last.moveToId, null);
  }
});

test("deposit output is credited before upkeep and leaves genuine excess in stock", () => {
  const { world, nation } = upkeepScene(0);
  for (const x of [1, 2, 3, 4]) {
    const deposit = world.mesoRegions.find(({ id }) => id === fixedSocietyDistrict(x, 3))!;
    deposit.resource = "fuel";
  }
  updateProduction(world);
  assert.equal(nation.resourceFlow.industry!.output.fuel, 12);
  assert.equal(nation.resourceFlow.industry!.fuelConsumed, 9);
  assert.equal(nation.resources.fuel, 3);
  assert(world.units.every((unit) => Number.isFinite(unit.moveTicksPerRegion)));
});

test("a single country cannot import, and fuel status recovers at the next settlement exactly once", () => {
  const { world, nation } = upkeepScene(2);
  for (let tick = 1; tick <= 25; tick++) {
    world.time.slowTick = tick;
    updateProduction(world);
    updateInternationalTrade(world);
    assert.equal(nation.resources.fuel, 2);
    assert(world.units.every((unit) => unit.combatPower === 0));
  }
  assert.equal(getInternationalTradeState(world).procurement!.attempted, 0);
  nation.resources.fuel += 7;
  updateProduction(world);
  assert.equal(nation.resources.fuel, 9);
  assert(world.units.every((unit) => unit.combatPower === 0));
  world.time.slowTick++;
  updateProduction(world);
  const signature = worldSignature(world);
  updateProduction(world);
  assert.equal(worldSignature(world), signature);
  assert.equal(nation.resources.fuel, 0);
  assert(world.units.every((unit) => Number.isFinite(unit.moveTicksPerRegion)));
});

test("inactive governments, zero-manpower units and embarked units do not charge upkeep", () => {
  const { world, nation } = upkeepScene(12);
  const [fielded, cargo, depleted] = world.units;
  depleted!.manpower = 0;
  fielded!.cargoUnits = [cargo!];
  world.units = [fielded!, depleted!];
  const inactive = { ...nation, id: createNationId(1), macroRegionIds: [] };
  world.nations.push(inactive);
  const orphan = createUnitForType(createUnitId(world.unitIdCounter++), inactive.id, nation.capitalMesoId, "Tank");
  world.units.push(orphan);
  updateProduction(world);
  assert.equal(nation.resourceFlow.industry!.fuelDemand, 3);
  assert.equal(nation.resources.fuel, 9);
  assert([cargo!, depleted!, orphan].every((unit) => !Number.isFinite(unit.moveTicksPerRegion)));
});

test("the non-planning flow records withdrawals, with requests and allocation deterministic under instrumentation", () => {
  function run(instrumented: boolean) {
    const { world, nation } = upkeepScene(4);
    world.settings!.economicPlanningEnabled = false;
    if (instrumented) world.instrumentation = { incrementCounter() {}, recordDuration() {} };
    updateProduction(world);
    assert.equal(nation.resourceFlow.fuelUpkeepDemand, 9);
    assert.equal(nation.resourceFlow.usage.fuel, 3);
    assert.equal(nation.resourceFlow.delta.fuel, -3);
    return worldSignature(world);
  }
  assert.equal(run(true), run(false));
});
