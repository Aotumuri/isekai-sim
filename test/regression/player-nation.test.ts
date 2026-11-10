import { acceptPeaceOffer, getWarNegotiation, updateWarNegotiations } from "../../src/sim/war-negotiations";
import { getPlayerWarIssue, startPlayerWar } from "../../src/sim/diplomatic-crises";
import { getRelation } from "../../src/sim/diplomacy";
import { offerPeace } from "../../src/sim/diplomatic-peace";
import { createSimulationSettings } from "../../src/sim/simulation-settings";
import assert from "node:assert/strict";
import test from "node:test";
import { updateBattles } from "../../src/sim/battles";
import { declareWar } from "../../src/sim/war-state";
import { createUnitForType } from "../../src/sim/create-units";
import { repositionUnits } from "../../src/sim/nation/reposition-units";
import { issuePlayerLandOrder, setPlayerCommandMode } from "../../src/sim/player-land-orders";
import { issuePlayerNavalOrder, updatePlayerNavalOrders } from "../../src/sim/player-naval-orders";
import { enterPlayerNation, getPlayerNation, leavePlayerNation } from "../../src/sim/player-nation";
import { createUnitId } from "../../src/sim/unit";
import { createFixedSocietyWorld, fixedSocietyDistrict } from "../helpers/fixed-society-world";

test("manual land movement accepts only the controlled nation's units and preserves the order through AI ticks", () => {
  const world = createFixedSocietyWorld();
  const [home, foreign] = world.nations;
  const ownUnit = createUnitForType(createUnitId(world.unitIdCounter++), home.id, fixedSocietyDistrict(2, 2), "Infantry");
  const otherUnit = createUnitForType(createUnitId(world.unitIdCounter++), foreign.id, foreign.capitalMesoId, "Infantry");
  world.units = [ownUnit, otherUnit];
  const target = fixedSocietyDistrict(3, 2);
  assert(enterPlayerNation(world, home.id));
  setPlayerCommandMode(world, "automatic");
  assert.equal(issuePlayerLandOrder(world, target, ownUnit.id), 0);
  setPlayerCommandMode(world, "manual");
  assert.equal(issuePlayerLandOrder(world, target, otherUnit.id), 0);
  assert.equal(issuePlayerLandOrder(world, foreign.capitalMesoId, ownUnit.id), 0);
  assert.equal(issuePlayerLandOrder(world, target, ownUnit.id), 1);
  repositionUnits(world, 10_000);
  assert.equal(ownUnit.regionId, target);
  leavePlayerNation(world);
  assert.equal(getPlayerNation(world), undefined);
  assert(enterPlayerNation(world, foreign.id));
  assert.equal(getPlayerNation(world)?.commandMode, "manual");
});

test("manual naval orders move ships into battle and reject inland targets", () => {
  const world = createFixedSocietyWorld();
  const [home, foreign] = world.nations;
  const ship = createUnitForType(createUnitId(world.unitIdCounter++), home.id, fixedSocietyDistrict(1, 1), "CombatShip");
  world.units.push(ship);
  assert(enterPlayerNation(world, home.id));
  setPlayerCommandMode(world, "manual");
  assert.equal(issuePlayerNavalOrder(world, ship.id, home.capitalMesoId), false);
  const sea = fixedSocietyDistrict(1, 0);
  assert(issuePlayerNavalOrder(world, ship.id, sea));
  updatePlayerNavalOrders(world, 10_000);
  assert.equal(ship.regionId, sea);
  const enemy = createUnitForType(createUnitId(world.unitIdCounter++), foreign.id, sea, "CombatShip");
  world.units.push(enemy);
  declareWar(world.wars, home.id, foreign.id, 0);
  updateBattles(world);
  assert(world.battles.some((battle) => battle.mesoId === sea));
});


test("the player can declare war and offer peace with automatic diplomacy disabled", () => {
  const world = createFixedSocietyWorld();
  const [home, foreign] = world.nations;
  world.settings = createSimulationSettings({ diplomacyEnabled: false, legacyWarDeclarationsEnabled: false });
  assert.equal(startPlayerWar(world, foreign.id), false);
  assert(enterPlayerNation(world, home.id));
  getRelation(world, home.id, foreign.id).treaties.push({ type: "truce", expiresAtSlowTick: 10 });
  assert.equal(getPlayerWarIssue(world, foreign.id), "truce");
  assert.equal(startPlayerWar(world, foreign.id), false);
  world.time.slowTick = 10;
  assert(startPlayerWar(world, foreign.id));
  assert.equal(world.wars[0]?.cause, "player-declaration");
  assert.equal(getPlayerWarIssue(world, foreign.id), "already-at-war");
  assert(offerPeace(world, home.id, foreign.id));
});

test("the controlled government must explicitly accept or propose peace", () => {
  const world = createFixedSocietyWorld();
  const [home, foreign] = world.nations;
  assert(enterPlayerNation(world, home.id));
  assert(startPlayerWar(world, foreign.id));
  const negotiation = getWarNegotiation(world, world.wars[0]!);
  const opening = negotiation.offers.get(home.id);
  assert(offerPeace(world, foreign.id, home.id));
  world.time.slowTick = 120;
  world.time.fastTick = 1200;
  updateWarNegotiations(world);
  assert.equal(world.wars.length, 1);
  assert.equal(negotiation.offers.get(home.id), opening);
  assert(acceptPeaceOffer(world, home.id, foreign.id));
  assert.equal(world.wars.length, 0);
});
