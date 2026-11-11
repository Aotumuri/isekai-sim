import { createScenarioWorld } from "../scenarios";
import { semanticWorldSignature, assertWorldInvariants } from "../helpers/invariants";
import { fixedSocietyDistrict } from "../helpers/fixed-society-world";
import { createUnitForType } from "../../src/sim/create-units";
import { createUnitId } from "../../src/sim/unit";
import { declareWar } from "../../src/sim/war-state";
import { enterPlayerNation } from "../../src/sim/player-nation";
import { issuePlayerLandOrder } from "../../src/sim/player-land-orders";
import assert from "node:assert/strict";
import test from "node:test";
import { createFixedSocietyWorld } from "../helpers/fixed-society-world";
import { setupTwoIslandAmphibious } from "../scenarios/two-island-amphibious";
import { runSimulation } from "../helpers/simulation-driver";
import { withMutedSimulationLogs } from "../helpers/muted-logs";
import { updateWarCampaigns } from "../../src/sim/war-campaign/update";
import { campaignPrefersSettlement } from "../../src/sim/war-campaign/peace-guidance";
import { updateAmphibiousOperations, updateAmphibiousPlanning } from "../../src/sim/amphibious";
import type { WorldState } from "../../src/sim/world-state";
import type { NationId } from "../../src/worldgen/nation";

function settle(world: WorldState, nationId: NationId) {
  world.settings!.warCampaignEnabled = true;
  world.settings!.diplomacyEnabled = true;
  world.wars[0]!.isTest = false;
  updateWarCampaigns(world);
  const campaign = world.warCampaigns!.byNationId.get(nationId)!;
  campaign.mode = "consolidate";
  campaign.constraints.objectivesSecured = true;
  return campaign;
}

function assembledIslandWorld() {
  const world = createFixedSocietyWorld();
  world.settings!.diplomacyEnabled = false;
  world.settings!.mobilizationEnabled = false;
  world.settings!.researchEnabled = false;
  setupTwoIslandAmphibious(world);
  withMutedSimulationLogs(() => {
    for (let tick = 0; tick < 1000; tick++) {
      if (world.amphibiousOperations.operations.some((op) => op.phase === "escort-wait")) break;
      runSimulation(world, { ticks: 1 });
    }
  });
  const operation = world.amphibiousOperations.operations.find((op) => op.phase === "escort-wait");
  assert(operation, "fixture assembles a fleet with embarked troops before launch");
  return { world, operation };
}

test("settlement stops a loaded unlaunched invasion without losing troops", () => {
  const { world, operation } = assembledIslandWorld();
  const cargo = world.units.filter((unit) => operation.transportIds.includes(unit.id))
    .flatMap((unit) => unit.cargoUnits);
  assert.ok(cargo.length);
  const failures = world.amphibiousOperations.failedLandings;
  settle(world, operation.nationId);
  updateAmphibiousOperations(world);
  assert.equal(operation.phase, "cancelled");
  assert.equal(operation.cancellationReason, "campaign-settlement");
  for (const unit of cargo) {
    assert(world.units.includes(unit));
    assert.equal(unit.regionId, operation.departurePortId);
  }
  assert.equal(world.amphibiousOperations.failedLandings, failures);
  updateAmphibiousPlanning(world);
  assert(!world.amphibiousOperations.operations.some((op) => op.nationId === operation.nationId &&
    !["cancelled", "landed"].includes(op.phase)));
});

test("settlement preserves a fleet already at sea and its cargo", () => {
  const { world, operation } = assembledIslandWorld();
  updateAmphibiousOperations(world);
  assert.equal(operation.phase, "transporting");
  const ships = world.units.filter((unit) => operation.transportIds.includes(unit.id));
  const cargo = ships.flatMap((ship) => ship.cargoUnits);
  assert.ok(cargo.length);
  settle(world, operation.nationId);
  updateAmphibiousOperations(world);
  assert.equal(operation.phase, "transporting");
  assert.deepEqual(ships.flatMap((ship) => ship.cargoUnits), cargo);
});

test("settlement preference survives a capital override but requires a legal diplomatic exit", () => {
  const { world, operation } = assembledIslandWorld();
  const campaign = settle(world, operation.nationId);
  campaign.mode = "defend";
  campaign.constraints.objectivesSecured = false;
  campaign.constraints.capitalCritical = true;
  campaign.constraints.foodSeconds = 10;
  assert(campaignPrefersSettlement(world, operation.nationId, operation.enemyNationId));
  world.wars[0]!.isTest = true;
  assert(!campaignPrefersSettlement(world, operation.nationId, operation.enemyNationId));
  world.wars[0]!.isTest = false;
  world.settings!.diplomacyEnabled = false;
  assert(!campaignPrefersSettlement(world, operation.nationId, operation.enemyNationId));
});

test("settlement preserves an explicit player landing plan", () => {
  const { world, operation } = assembledIslandWorld();
  const demand = world.amphibiousOperations.capabilityDemands.find((item) => item.id === operation.capabilityDemandId)!;
  assert(demand);
  demand.playerPlan = { unitCount: operation.assignedUnitIds.length, launchTick: world.time.fastTick };
  settle(world, operation.nationId);
  updateAmphibiousOperations(world);
  assert.equal(operation.phase, "transporting");
  assert.equal(operation.cancellationReason, null);
});

test("enabled campaigns replay deterministically through full normal simulation", () => {
  const worlds = [0, 1].map(() => createScenarioWorld("active-war", {
    seed: 822_748_319_788, width: 640, height: 360, quick: true,
  }));
  withMutedSimulationLogs(() => {
    for (const world of worlds) {
      Object.assign(world.settings!, { warCampaignEnabled: true, diplomacyEnabled: true,
        mobilizationEnabled: true, researchEnabled: true, armsAidEnabled: true, tradeEnabled: true,
        politicalTurbulenceEnabled: true });
      world.wars.forEach((war) => { war.isTest = false; });
      runSimulation(world, { ticks: 1200 });
      assertWorldInvariants(world);
    }
  });
  assert.deepEqual(semanticWorldSignature(worlds[0]), semanticWorldSignature(worlds[1]));
  assert.deepEqual(worlds[0].warCampaigns, worlds[1].warCampaigns);
  assert.deepEqual(worlds[0].offensiveOperations.operations, worlds[1].offensiveOperations.operations);
});

test("a direct land order survives enabled national planning during war", () => {
  const world = createFixedSocietyWorld();
  const [home, foreign] = world.nations;
  declareWar(world.wars, home.id, foreign.id, 0);
  world.settings!.warCampaignEnabled = true;
  assert(enterPlayerNation(world, home.id));
  const unit = createUnitForType(createUnitId(world.unitIdCounter++), home.id,
    fixedSocietyDistrict(1, 3), "Infantry");
  world.units.push(unit);
  const target = fixedSocietyDistrict(4, 1);
  assert.equal(issuePlayerLandOrder(world, target, unit.id), 1);
  withMutedSimulationLogs(() => runSimulation(world, { ticks: 10 }));
  assert(world.warCampaigns!.byNationId.has(home.id));
  assert.equal(world.playerNation!.landOrders.get(unit.id), target);
  assert(!world.offensiveOperations.operationIdByUnitId.has(unit.id));
  assert(!world.reorganization.planIdByUnitId.has(unit.id));
});
