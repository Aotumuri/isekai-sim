import assert from "node:assert/strict";
import test from "node:test";
import { concludePeace } from "../../src/sim/diplomatic-peace";
import { getRelation } from "../../src/sim/diplomacy";
import { industrialRecoveryFactor, updateIndustrialRecovery } from "../../src/sim/industrial-recovery";
import { enterPlayerNation } from "../../src/sim/player-nation";
import { updateProduction } from "../../src/sim/production";
import { updateSupplyAssessment } from "../../src/sim/supply-assessment";
import { declareWar } from "../../src/sim/war-state";
import { createFixedSocietyWorld, fixedSocietyDistrict } from "../helpers/fixed-society-world";

function scene() {
  const world = createFixedSocietyWorld();
  const [owner, enemy] = world.nations;
  const city = fixedSocietyDistrict(1, 2), fuel = fixedSocietyDistrict(3, 3);
  owner.resources.steel = 100;
  owner.treasury!.balance = 50;
  declareWar(world.wars, enemy.id, owner.id, 0);
  world.occupation.mesoById.set(city, enemy.id);
  world.occupation.mesoById.set(fuel, enemy.id);
  assert(concludePeace(world, owner.id, enemy.id));
  updateSupplyAssessment(world);
  return { world, owner, enemy, city, fuel };
}

test("industry restarts at partial output and AI funds one priority site without repeated charges", () => {
  const { world, owner, city, fuel } = scene();
  assert.equal(industrialRecoveryFactor(world, owner.id, fuel), 0.5);
  updateProduction(world);
  assert.equal(owner.resourceFlow.income.fuel, 1.5);
  const before = owner.resources.steel;
  world.time.slowTick = 10;
  updateIndustrialRecovery(world);
  updateIndustrialRecovery(world);
  assert.equal(world.industrialRecovery?.get(city)?.remaining, 25);
  assert.equal(world.industrialRecovery?.get(fuel)?.remaining, 50);
  assert.equal(owner.treasury!.balance, 41);
  assert.equal(owner.resources.steel, before - 16);
  assert.equal(owner.treasury!.spent.construction, 9);
});

test("manual budgets are preserved, contested districts pause, and recovery records expire", () => {
  const { world, owner, enemy, city, fuel } = scene();
  assert(enterPlayerNation(world, owner.id));
  world.occupation.mesoById.set(fuel, enemy.id);
  world.time.slowTick = 10;
  updateIndustrialRecovery(world);
  assert.equal(world.industrialRecovery?.get(fuel)?.remaining, 60);
  assert.equal(world.industrialRecovery?.get(city)?.remaining, 50);
  assert.equal(owner.treasury!.balance, 50);
  world.occupation.mesoById.delete(fuel);
  world.time.slowTick = 70;
  updateIndustrialRecovery(world);
  assert.equal(world.industrialRecovery?.size, 0);
  assert.equal(industrialRecoveryFactor(world, owner.id, fuel), 1);
});

test("a solvent ally can fund reconstruction when the former belligerent lacks cash", () => {
  for (const donorType of ["ally", "neutral", "manual", "short of reserves"] as const) {
    const { world, owner, city } = scene();
    const donor = world.nations[2];
    owner.treasury!.balance = 0;
    donor.treasury!.balance = donorType === "short of reserves" ? 35 : 85;
    donor.treasury!.lastRevenue = 15;
    if (donorType !== "neutral") {
      getRelation(world, donor.id, owner.id).treaties.push({ type: "alliance", expiresAtSlowTick: 300 });
    }
    if (donorType === "manual") assert(enterPlayerNation(world, donor.id));
    const before = donor.treasury!.balance;
    world.time.slowTick = 10;
    updateIndustrialRecovery(world);
    assert.equal(world.industrialRecovery?.get(city)?.funded ?? false, donorType === "ally", donorType);
    assert.equal(donor.treasury!.balance, before - (donorType === "ally" ? 25 : 0), donorType);
    assert.equal(owner.treasury!.balance, donorType === "ally" ? 16 : 0, donorType);
  }
});
