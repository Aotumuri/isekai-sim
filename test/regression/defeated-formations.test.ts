import assert from "node:assert/strict";
import test from "node:test";
import { updateBattles } from "../../src/sim/battles";
import { createUnitForType } from "../../src/sim/create-units";
import { advanceDefeatedWithdrawals, recoverDefeatedFormations, repatriatePrisoners } from "../../src/sim/defeated-formations";
import { startPlayerWar } from "../../src/sim/diplomatic-crises";
import { allMobilizedUnits } from "../../src/sim/mobilization";
import { repositionUnits } from "../../src/sim/nation/reposition-units";
import { updateOccupation } from "../../src/sim/occupation";
import { issuePlayerLandOrder } from "../../src/sim/player-land-orders";
import { enterPlayerNation } from "../../src/sim/player-nation";
import { createUnitId } from "../../src/sim/unit";
import { acceptPeaceOffer, proposePeaceTerms, whitePeaceTerms } from "../../src/sim/war-negotiations";
import { createFixedSocietyWorld, fixedSocietyDistrict } from "../helpers/fixed-society-world";

function createBattlefield(blocked: boolean, mutual = false, enabled = true) {
  const world = createFixedSocietyWorld();
  world.settings!.defeatedFormationsEnabled = enabled;
  const [home, enemy] = world.nations;
  const front = fixedSocietyDistrict(4, 2);
  const rally = fixedSocietyDistrict(3, 2);
  const defender = createUnitForType(createUnitId(world.unitIdCounter++), home.id, front, "Infantry");
  const attacker = createUnitForType(createUnitId(world.unitIdCounter++), enemy.id, fixedSocietyDistrict(5, 2), "Infantry");
  attacker.moveToId = front;
  defender.org = 0.000001;
  defender.combatExperience = 12;
  if (mutual) attacker.org = defender.org;
  world.units = [defender, attacker];
  assert(enterPlayerNation(world, home.id));
  assert(startPlayerWar(world, enemy.id));
  assert.equal(issuePlayerLandOrder(world, rally, defender.id), 1);
  for (const id of [fixedSocietyDistrict(4, 1), fixedSocietyDistrict(4, 3), ...(blocked ? [rally] : [])]) {
    world.occupation.mesoById.set(id, enemy.id);
  }
  return { world, home, enemy, front, rally, defender, attacker };
}

test("defeat allows occupation while survivors take time to withdraw and regain manual control", () => {
  const { world, home, enemy, front, rally, defender, attacker } = createBattlefield(false);
  const before = { manpower: home.resources.manpower, weapons: home.resources.weapons, equipment: structuredClone(defender.equipment) };
  updateBattles(world);
  assert(!world.units.includes(defender));
  assert(allMobilizedUnits(world).includes(defender));
  assert.equal(world.playerNation?.landOrders.has(defender.id), false);
  assert.equal(issuePlayerLandOrder(world, rally, defender.id), 0);
  attacker.regionId = front;
  attacker.moveToId = null;
  updateOccupation(world);
  assert.equal(world.occupation.mesoById.get(front), enemy.id);
  const state = world.defeatedFormations!;
  const withdrawal = state.withdrawals.get(defender.id)!;
  assert.equal(withdrawal.destination, rally);
  world.time.fastTick = withdrawal.arrivalTick - 1;
  advanceDefeatedWithdrawals(world);
  assert.equal(defender.regionId, front);
  assert.equal(defender.org, 0);
  world.time.fastTick++;
  advanceDefeatedWithdrawals(world);
  assert.equal(defender.regionId, rally);
  assert(!world.units.includes(defender));

  for (let tick = 0; tick < 40; tick++) {
    world.time.fastTick += 10;
    world.time.slowTick++;
    recoverDefeatedFormations(world);
  }
  assert.equal(state.withdrawals.size, 0);
  assert.equal(state.recoveredManpower, defender.manpower);
  assert.equal(world.units.filter((unit) => unit.id === defender.id).length, 1);
  assert.equal(defender.combatExperience, 12);
  assert.deepEqual(defender.equipment, before.equipment);
  assert.equal(home.resources.manpower, before.manpower);
  assert.equal(home.resources.weapons, before.weapons);
  const next = fixedSocietyDistrict(2, 2);
  assert.equal(issuePlayerLandOrder(world, next, defender.id), 1);
  repositionUnits(world, 10_000);
  assert.equal(defender.regionId, next);
});

test("cut-off survivors become prisoners and are credited once after negotiated peace", () => {
  const { world, home, enemy, defender } = createBattlefield(true);
  const { manpower, weapons } = home.resources;
  const strength = defender.manpower;
  updateBattles(world);
  const state = world.defeatedFormations!;
  assert.equal(state.withdrawals.size, 0);
  assert.equal(state.capturedManpower, defender.manpower);
  assert(defender.manpower > 0 && defender.manpower < strength);
  assert.equal([...state.prisoners.values()][0].captor, enemy.id);
  world.time.slowTick = 20;
  repatriatePrisoners(world);
  assert.equal(home.resources.manpower, manpower);

  assert(proposePeaceTerms(world, home.id, enemy.id, whitePeaceTerms()));
  assert(acceptPeaceOffer(world, enemy.id, home.id));
  repatriatePrisoners(world);
  world.time.slowTick = 29;
  repatriatePrisoners(world);
  assert.equal(home.resources.manpower, manpower);
  world.time.slowTick++;
  repatriatePrisoners(world);
  repatriatePrisoners(world);
  assert.equal(state.prisoners.size, 0);
  assert.equal(state.repatriatedManpower, defender.manpower);
  assert.equal(home.resources.manpower, manpower + defender.manpower);
  assert.equal(home.resources.weapons, weapons);
  assert(!world.units.includes(defender));
});

test("an advancing enemy can intercept the withdrawal before the survivors rally", () => {
  const { world, defender, attacker, rally } = createBattlefield(false);
  updateBattles(world);
  attacker.regionId = rally;
  updateOccupation(world);
  advanceDefeatedWithdrawals(world);
  const state = world.defeatedFormations!;
  assert.equal(state.withdrawals.size, 0);
  assert.equal(state.capturedManpower, defender.manpower);
  assert(!world.units.includes(defender));
});

test("mutual collapse without a retreat or surviving captor accounts for missing personnel", () => {
  const { world, defender, attacker } = createBattlefield(true, true);
  world.occupation.mesoById.clear();
  // Each belligerent controls only the district currently occupied by its troops.
  for (const unit of [defender, attacker]) {
    for (const region of world.macroRegions.filter((region) => region.nationId === unit.nationId)) {
      region.mesoRegionIds = region.mesoRegionIds.filter((id) => id === unit.regionId);
    }
  }
  world.territoryVersion++;
  updateBattles(world);
  assert.equal(world.units.length, 0);
  assert.equal(world.defeatedFormations?.prisoners.size, 0);
  assert.equal(world.defeatedFormations?.missingManpower, defender.manpower + attacker.manpower);
});

test("disabled defeated formations preserve the previous battle-removal behavior", () => {
  const { world, defender } = createBattlefield(false, false, false);
  updateBattles(world);
  assert(!world.units.includes(defender));
  assert.equal(world.defeatedFormations, undefined);
});
