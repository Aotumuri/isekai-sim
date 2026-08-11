import assert from "node:assert/strict";
import test from "node:test";
import { SeededRng } from "../../src/utils/seeded-rng";
import { WORLD_BALANCE } from "../../src/data/balance";
import type { MacroRegion } from "../../src/worldgen/macro-region";
import { createMacroRegionId } from "../../src/worldgen/macro-region";
import type { MesoRegion, MesoRegionId } from "../../src/worldgen/meso-region";
import type { MicroRegionId } from "../../src/worldgen/micro-region";
import type { NationId } from "../../src/worldgen/nation";
import { createBattlefieldTopologyState, updateBattlefieldTopology } from "../../src/sim/battlefield-topology";
import { createUnitForType } from "../../src/sim/create-units";
import { createCapitalDefenseState } from "../../src/sim/capital-defense";
import { createCollapseAdvanceState } from "../../src/sim/collapse-advance";
import { createFrontlineCoverageState } from "../../src/sim/frontline-coverage";
import { createLandFrontState, updateLandFronts } from "../../src/sim/land-fronts";
import { createNationFrontAllocationState } from "../../src/sim/nation-front-allocations";
import { createNationFrontPlanState } from "../../src/sim/nation-front-plans";
import { createNationResourceFlow, createNationResources, type NationRuntime } from "../../src/sim/nation-runtime";
import { createOccupationState } from "../../src/sim/occupation";
import { createOffensiveOperationState } from "../../src/sim/offensive-operations";
import {
  createReorganizationState,
  getReorganizationPlanForUnit,
  updateReorganization,
} from "../../src/sim/reorganization";
import { createRetreatPlanState } from "../../src/sim/retreat-plans";
import { createStalematePressureState } from "../../src/sim/stalemate-pressure";
import { createStrategicProgressState } from "../../src/sim/strategic-progress";
import { createStrategicThreatObservationState } from "../../src/sim/strategic-threat-observation";
import { createWarIntentState } from "../../src/sim/war-intent";
import { createCommonThreatCoalitionState } from "../../src/sim/common-threat-coalitions";
import { createStrategicReserveState } from "../../src/sim/strategic-reserves";
import {
  createSupplyAssessmentState,
  getNationSupplyAssessment,
  isNationRegionSupplied,
  updateSupplyAssessment,
} from "../../src/sim/supply-assessment";
import {
  createIsolationEffectsState,
  updateIsolationEffects,
} from "../../src/sim/isolation-effects";
import { createUnitId } from "../../src/sim/unit";
import { createSimTime, FAST_TICK_MS } from "../../src/sim/time";
import { updateMaritimeLogisticsMovement } from "../../src/sim/maritime-supply";
import {
  getEscortAssignment,
  getMaritimeLinkProtection,
  updateMaritimeEscortMovement,
} from "../../src/sim/maritime-escort";
import type { WorldState } from "../../src/sim/world-state";
import { createWorldCache } from "../../src/sim/world-cache";
import {
  createProductionDiagnosticsState,
  updateProduction,
} from "../../src/sim/production";
import { createSupplyCutoffAnalysisState, updateSupplyCutoffAnalysis } from "../../src/sim/supply-cutoff";
import {
  createSupplyDefenseState,
  updateSupplyDefense,
} from "../../src/sim/supply-defense";
import { createSupplyReliefState } from "../../src/sim/supply-relief";
import {
  createAmphibiousOperationState,
  getAmphibiousOperationValidation,
  updateAmphibiousCapabilityAssembly,
  updateAmphibiousOperations,
  updateAmphibiousPlanning,
} from "../../src/sim/amphibious";
import { repositionUnits } from "../../src/sim/nation/reposition-units";
import { declareWar } from "../../src/sim/war-state";
import { updateBattles } from "../../src/sim/battles";
import {
  recordMaritimeInterdictionCombat,
  updateMaritimeInterdictionMovement,
} from "../../src/sim/maritime-interdiction";
import { updateConvoyMovement } from "../../src/sim/convoy-system";
import {
  getNavalUnitOwnership,
  updateNavalStrategy,
  updateNavalStrategyMovement,
} from "../../src/sim/naval-strategy";

const NATION_A = "nation-a" as NationId;
const NATION_B = "nation-b" as NationId;

test("amphibious planning creates one deterministic leased plan and reserves physical ships", () => {
  const world = createMaritimeWorld(true, 3);
  const enemyMacroIds = world.macroRegions
    .filter((macro) => macro.mesoRegionIds.includes(id("port-b")) || macro.mesoRegionIds.includes(id("island-b")))
    .map((macro) => { macro.nationId = NATION_B; return macro.id; });
  world.nations.push(createNation(NATION_B, id("island-b"), enemyMacroIds));
  world.cache.ownerByMesoId.clear();
  declareWar(world.wars, NATION_A, NATION_B, 0);
  const infantry = createUnitForType(createUnitId(world.unitIdCounter++), NATION_A, id("port-a"), "Infantry");
  const escort = createUnitForType(createUnitId(world.unitIdCounter++), NATION_A, id("port-a"), "CombatShip");
  world.units.push(infantry, escort);
  world.supplyAssessment.navalStrategy.missions = [{
    id: "reserve-test", nationId: NATION_A, type: "RESERVE", shipIds: [escort.id],
    targetPortId: id("port-a"), priority: 10, createdTick: 0, status: "ACTIVE", reasonFlags: ["test-reserve"],
  }];
  updateAmphibiousPlanning(world);
  const operation = world.amphibiousOperations.operations[0];
  assert(operation);
  assert.equal(operation.destinationPortId, id("port-b"));
  assert.deepEqual(operation.assignedUnitIds, [infantry.id]);
  assert.deepEqual(operation.escortIds, [escort.id]);
  assert.equal(operation.manifest[0].departurePortId, id("port-a"));
  assert.equal(world.amphibiousOperations.operationByUnitId.get(operation.transportId)?.id, operation.id);
  assert.equal(world.amphibiousOperations.landingPlans, 1);
  assert.equal(world.amphibiousOperations.operationsAccepted, 1);
  assert.equal(world.amphibiousOperations.operationsRejected, 0);
  assert.equal(operation.launchFeasibility.accepted, true);
  assert(operation.launchFeasibility.estimatedCompletionTicks > 0);
  assert(operation.launchFeasibility.safetyMarginTicks >= 0);
  for (let tick = 0; tick < 400 && operation.phase !== "landed"; tick += 1) {
    world.time.fastTick += 1;
    updateAmphibiousOperations(world);
    updateConvoyMovement(world, FAST_TICK_MS);
  }
  assert.equal(operation.phase, "landed");
  assert.equal(infantry.regionId, id("port-b"));
  assert.equal(world.units.includes(infantry), true);
  assert.equal(world.amphibiousOperations.operationByUnitId.has(infantry.id), false);
  assert.equal(world.amphibiousOperations.successfulBeachheads, 1);
  assert.equal(world.amphibiousOperations.launchedOperations, 1);
});

test("a launched amphibious voyage survives loss of its historical departure port", () => {
  const world = createMaritimeWorld(true, 3);
  const enemyMacroIds = world.macroRegions
    .filter((macro) => macro.mesoRegionIds.includes(id("port-b")) || macro.mesoRegionIds.includes(id("island-b")))
    .map((macro) => { macro.nationId = NATION_B; return macro.id; });
  world.nations.push(createNation(NATION_B, id("island-b"), enemyMacroIds));
  world.cache.ownerByMesoId.clear();
  declareWar(world.wars, NATION_A, NATION_B, 0);
  const infantry = createUnitForType(createUnitId(world.unitIdCounter++), NATION_A, id("port-a"), "Infantry");
  const escort = createUnitForType(createUnitId(world.unitIdCounter++), NATION_A, id("port-a"), "CombatShip");
  world.units.push(infantry, escort);
  world.supplyAssessment.navalStrategy.missions = [{
    id: "reserve-test", nationId: NATION_A, type: "RESERVE", shipIds: [escort.id],
    targetPortId: id("port-a"), priority: 10, createdTick: 0, status: "ACTIVE", reasonFlags: ["test-reserve"],
  }];
  updateAmphibiousPlanning(world);
  const operation = world.amphibiousOperations.operations[0]!;

  const departureMacro = world.macroRegions.find((macro) => macro.mesoRegionIds.includes(id("port-a")))!;
  departureMacro.nationId = NATION_B;
  world.territoryVersion += 1;
  world.cache.ownerByMesoId.clear();
  const readyValidation = getAmphibiousOperationValidation(world, operation);
  assert.equal(readyValidation.phase, "ready");
  assert(readyValidation.failures.includes("departure-port-lost"));
  departureMacro.nationId = NATION_A;
  world.territoryVersion += 1;
  world.cache.ownerByMesoId.clear();

  for (let tick = 0; tick < 4 && operation.phase !== "transporting"; tick += 1) {
    world.time.fastTick += 1;
    updateAmphibiousOperations(world);
  }
  assert.equal(operation.phase, "transporting");
  assert(operation.convoyId);

  departureMacro.nationId = NATION_B;
  world.territoryVersion += 1;
  world.cache.ownerByMesoId.clear();
  world.time.fastTick += 1;
  updateAmphibiousOperations(world);

  assert.equal(operation.phase, "transporting");
  assert.equal(operation.cancellationReason, null);
  assert.equal(world.amphibiousOperations.departurePortCancellations, 0);
  assert.equal(world.amphibiousOperations.voyageFailures, 0);

  for (let tick = 0; tick < 400 && (operation.phase as string) !== "landed"; tick += 1) {
    world.time.fastTick += 1;
    updateConvoyMovement(world, FAST_TICK_MS);
    updateAmphibiousOperations(world);
  }
  assert.equal(operation.phase, "landed");
  assert.equal(infantry.regionId, id("port-b"));
});

test("an island war bootstraps amphibious capability from zero through naval production", () => {
  const world = createMaritimeWorld(true, 0);
  const enemyMacroIds = world.macroRegions
    .filter((macro) => macro.mesoRegionIds.includes(id("port-b")) || macro.mesoRegionIds.includes(id("island-b")))
    .map((macro) => { macro.nationId = NATION_B; return macro.id; });
  world.nations.push(createNation(NATION_B, id("island-b"), enemyMacroIds));
  world.cache.ownerByMesoId.clear();
  declareWar(world.wars, NATION_A, NATION_B, 0);
  world.units.push(createUnitForType(
    createUnitId(world.unitIdCounter++), NATION_A, id("port-a"), "Infantry",
  ));
  const nation = world.nations[0]!;
  nation.resources.manpower = 100_000;
  nation.resources.weapons = 10_000;
  nation.resources.fuel = 10_000;

  updateAmphibiousPlanning(world);

  const demand = world.amphibiousOperations.capabilityDemands[0];
  assert(demand);
  assert.equal(demand.state, "waiting-transport");
  assert.equal(world.amphibiousOperations.operations.length, 0);

  nation.nextUnitProductionTick = 0;
  updateProduction(world);
  assert.equal(world.units.filter((unit) => unit.type === "TransportShip").length, 1);
  assert.equal(world.amphibiousOperations.operations.length, 0);
  assert.equal(world.units.filter((unit) => unit.type === "CombatShip").length, 1);
  updateAmphibiousPlanning(world);
  assert.equal(demand.state, "waiting-escort");
  assert.equal(world.amphibiousOperations.operations.length, 0);

  nation.nextUnitProductionTick = 0;
  updateProduction(world);
  assert.equal(world.units.filter((unit) => unit.type === "CombatShip").length, 2);
  updateAmphibiousPlanning(world);

  assert.equal(demand.state, "ready");
  assert(demand.operationId);
  assert.equal(world.amphibiousOperations.operations.length, 1);
  assert.equal(world.amphibiousOperations.capabilityDemandsSatisfied, 1);
  assert(world.amphibiousOperations.capabilityProductionRequests >= 2);
});

test("amphibious capability assembles reachable ships and land force before preflight", () => {
  const world = createMaritimeWorld(true, 1);
  const enemyMacroIds = world.macroRegions
    .filter((macro) => macro.mesoRegionIds.includes(id("port-b")) || macro.mesoRegionIds.includes(id("island-b")))
    .map((macro) => { macro.nationId = NATION_B; return macro.id; });
  world.nations.push(createNation(NATION_B, id("island-b"), enemyMacroIds));
  world.cache.ownerByMesoId.clear();
  declareWar(world.wars, NATION_A, NATION_B, 0);
  const transport = world.units.find((unit) => unit.type === "TransportShip")!;
  transport.regionId = id("sea-ab");
  const escort = createUnitForType(createUnitId(world.unitIdCounter++), NATION_A, id("sea-ab"), "CombatShip");
  const infantry = createUnitForType(createUnitId(world.unitIdCounter++), NATION_A, id("capital"), "Infantry");
  world.units.push(escort, infantry);
  world.supplyAssessment.navalStrategy.missions = [{
    id: "assembly-reserve", nationId: NATION_A, type: "RESERVE", shipIds: [escort.id],
    targetPortId: id("port-a"), priority: 10, createdTick: 0, status: "ACTIVE", reasonFlags: ["test-reserve"],
  }];

  updateAmphibiousPlanning(world);
  const demand = world.amphibiousOperations.capabilityDemands[0]!;
  assert.equal(demand.state, "assembling");
  assert.equal(demand.fleetReachableAtTick, 0);
  assert(demand.initialAssemblyEtaTicks > 0);
  assert.equal(world.amphibiousOperations.operations.length, 0);
  assert.equal(world.amphibiousOperations.capabilityDemandByUnitId.get(transport.id)?.id, demand.id);
  assert.equal(world.amphibiousOperations.capabilityDemandByUnitId.get(escort.id)?.id, demand.id);
  assert.equal(world.amphibiousOperations.capabilityDemandByUnitId.get(infantry.id)?.id, demand.id);

  for (let tick = 0; tick < 200 && (demand.state as string) !== "ready"; tick += 1) {
    world.time.fastTick += 1;
    repositionUnits(world, FAST_TICK_MS);
    updateAmphibiousCapabilityAssembly(world, FAST_TICK_MS);
  }
  assert.equal(demand.state, "ready");
  assert.equal(transport.regionId, id("port-a"));
  assert.equal(escort.regionId, id("port-a"));
  assert.equal(infantry.regionId, id("port-a"));
  assert(demand.assemblyCompletedAtTick !== null);
  assert.equal(world.amphibiousOperations.assemblySuccesses, 1);

  updateAmphibiousPlanning(world);
  const operation = world.amphibiousOperations.operations[0]!;
  assert(operation);
  assert.equal(operation.capabilityDemandId, demand.id);
  assert.equal(operation.launchFeasibility.estimatedAssemblyTicks, 0);
  assert.equal(operation.launchFeasibility.estimatedTransportDelayTicks, 0);
  assert.equal(operation.launchFeasibility.estimatedEscortDelayTicks, 0);
  assert.equal(world.amphibiousOperations.capabilityDemandByUnitId.size, 0);
  assert.equal(world.amphibiousOperations.operationByUnitId.get(transport.id)?.id, operation.id);
});

test("amphibious capability demand expires when its strategic opportunity disappears", () => {
  const world = createMaritimeWorld(true, 0);
  const enemyMacroIds = world.macroRegions
    .filter((macro) => macro.mesoRegionIds.includes(id("port-b")) || macro.mesoRegionIds.includes(id("island-b")))
    .map((macro) => { macro.nationId = NATION_B; return macro.id; });
  world.nations.push(createNation(NATION_B, id("island-b"), enemyMacroIds));
  world.cache.ownerByMesoId.clear();
  declareWar(world.wars, NATION_A, NATION_B, 0);
  world.units.push(createUnitForType(
    createUnitId(world.unitIdCounter++), NATION_A, id("port-a"), "Infantry",
  ));

  updateAmphibiousPlanning(world);
  const demand = world.amphibiousOperations.capabilityDemands[0];
  assert(demand);
  world.wars = [];
  world.time.fastTick += 1;
  updateAmphibiousPlanning(world);

  assert.equal(demand.state, "expired");
  assert.equal(world.amphibiousOperations.capabilityDemands.every((item) => item.state === "expired"), true);
  assert.equal(world.amphibiousOperations.capabilityDemandsExpired,
    world.amphibiousOperations.capabilityDemands.length);
  const nation = world.nations[0]!;
  nation.resources.manpower = 100_000;
  nation.resources.weapons = 10_000;
  nation.nextUnitProductionTick = 0;
  updateProduction(world);
  assert.equal(world.units.some((unit) => unit.domain === "naval"), false);
});

test("amphibious launch preflight rejects a landing that cannot fit its strategic window", () => {
  const world = createMaritimeWorld(true, 3);
  const enemyMacroIds = world.macroRegions
    .filter((macro) => macro.mesoRegionIds.includes(id("port-b")) || macro.mesoRegionIds.includes(id("island-b")))
    .map((macro) => { macro.nationId = NATION_B; return macro.id; });
  const enemy = createNation(NATION_B, id("island-b"), enemyMacroIds);
  enemy.surrenderScore = 0.99;
  world.nations.push(enemy);
  world.cache.ownerByMesoId.clear();
  declareWar(world.wars, NATION_A, NATION_B, 0);
  const infantry = createUnitForType(createUnitId(world.unitIdCounter++), NATION_A, id("port-a"), "Infantry");
  const escort = createUnitForType(createUnitId(world.unitIdCounter++), NATION_A, id("port-a"), "CombatShip");
  world.units.push(infantry, escort);
  world.supplyAssessment.navalStrategy.missions = [{
    id: "reserve-test", nationId: NATION_A, type: "RESERVE", shipIds: [escort.id],
    targetPortId: id("port-a"), priority: 10, createdTick: 0, status: "ACTIVE", reasonFlags: ["test-reserve"],
  }];

  updateAmphibiousPlanning(world);

  assert.equal(world.amphibiousOperations.operations.length, 0);
  assert.equal(world.amphibiousOperations.operationsAccepted, 0);
  assert.equal(world.amphibiousOperations.operationsRejected, 1);
  assert.equal(world.amphibiousOperations.landingPlans, 0);
  assert.equal(world.amphibiousOperations.transportAssignments, 0);
  const rejection = world.amphibiousOperations.launchRejections[0];
  assert(rejection);
  assert.equal(rejection.reason, "insufficient-strategic-window");
  assert.equal(rejection.accepted, false);
  assert.equal(rejection.estimatedAssemblyTicks, 0);
  assert.equal(rejection.estimatedTransportDelayTicks, 0);
  assert.equal(rejection.estimatedEscortDelayTicks, 0);
  assert(rejection.estimatedVoyageTicks > 0);
  assert(rejection.estimatedLandingTicks > 0);
  assert(rejection.estimatedCompletionTicks > rejection.estimatedOpportunityWindowTicks);
  assert(rejection.safetyMarginTicks < 0);
  assert.equal(world.amphibiousOperations.operationByUnitId.size, 0);
  assert.equal(infantry.moveTargetId, null);
  world.time.fastTick = rejection.estimatedCompletionTick;
  updateAmphibiousPlanning(world);
  assert.equal(world.amphibiousOperations.falsePositiveCount, 1);
});

test("Naval AI gives every CombatShip exactly one mission and never assigns TransportShips", () => {
  const world = createStrategicAllocationWorld(2);
  updateNavalStrategy(world);
  assert.equal(world.supplyAssessment.navalStrategy.missionByShipId.size, 2);
  assert.equal(new Set(world.supplyAssessment.navalStrategy.missions.flatMap((mission) => mission.shipIds)).size, 2);
  assert(world.units.filter((unit) => unit.type === "TransportShip").every((unit) =>
    !world.supplyAssessment.navalStrategy.missionByShipId.has(unit.id)));
  assert(world.units.filter((unit) => unit.domain === "naval").every((unit) =>
    getNavalUnitOwnership(world, unit.id) !== undefined));
  assert(world.units.filter((unit) => unit.type === "TransportShip").every((unit) =>
    getNavalUnitOwnership(world, unit.id)?.controller === "MARITIME_LOGISTICS"));
});

test("Naval AI splits two ships between a critical escort and a worthwhile raid", () => {
  const world = createStrategicAllocationWorld(2);
  updateNavalStrategy(world);
  const types = [...world.supplyAssessment.navalStrategy.missionByShipId.values()].map((mission) => mission.type).sort();
  assert.deepEqual(types, ["ESCORT", "RAID"]);
});

test("Naval AI keeps a deterministic reserve when no strategic demand exists", () => {
  const world = createStrategicAllocationWorld(3);
  world.supplyAssessment.maritimeEscorts.demands = [];
  world.supplyAssessment.maritimeInterdiction.assessments = [];
  updateNavalStrategy(world);
  assert.equal(world.supplyAssessment.navalStrategy.missions.every((mission) => mission.type === "RESERVE"), true);
  assert.equal(world.supplyAssessment.navalStrategy.missionByShipId.size, 3);
});

test("reserve ships return to their deterministic port and do not roam after arrival", () => {
  const world = createStrategicAllocationWorld(3);
  world.supplyAssessment.maritimeEscorts.demands = [];
  world.supplyAssessment.maritimeInterdiction.assessments = [];
  const ship = world.units.find((unit) => unit.type === "CombatShip");
  assert(ship);
  ship.regionId = id("sea-ab");
  ship.moveTicksPerRegion = 1;
  updateNavalStrategy(world);
  const ownership = getNavalUnitOwnership(world, ship.id);
  assert.equal(ownership?.missionType, "RESERVE");
  assert(ownership?.reservePortId);
  updateNavalStrategyMovement(world, FAST_TICK_MS);
  assert.equal(ship.regionId, ownership.reservePortId);
  updateNavalStrategyMovement(world, FAST_TICK_MS);
  assert.equal(ship.regionId, ownership.reservePortId);
  assert.equal(ship.moveTargetId, null);
});

test("Naval AI preserves stable mission identity across unchanged evaluations", () => {
  const world = createStrategicAllocationWorld(1);
  updateNavalStrategy(world);
  const first = world.supplyAssessment.navalStrategy.missions[0];
  world.time.fastTick += 1;
  updateNavalStrategy(world);
  assert.equal(world.supplyAssessment.navalStrategy.missions[0]?.id, first?.id);
  assert.equal(world.supplyAssessment.navalStrategy.missionSwitches, 0);
});

test("Naval AI locally overrides a lower mission for an immediate convoy interception", () => {
  const world = createStrategicAllocationWorld(1);
  updateNavalStrategy(world);
  const defender = world.units.find((unit) => unit.type === "CombatShip");
  const linkId = world.supplyAssessment.maritimeEscorts.demands[0]?.maritimeLinkId;
  assert(defender && linkId);
  defender.regionId = id("port-b");
  const raider = createUnitForType(createUnitId(world.unitIdCounter++), NATION_B, id("sea-ab"), "CombatShip");
  world.units.push(raider);
  const raid = {
    combatShipId: raider.id, attackerNationId: NATION_B, maritimeLinkId: linkId,
    defenderNationId: NATION_A, targetScore: 90, targetReason: "critical convoy",
    routeRegionIds: [id("port-a"), id("sea-ab"), id("port-b")],
    positioningRouteIds: [id("sea-ab")], status: "intercepting" as const,
    assignedTick: world.time.fastTick,
  };
  world.supplyAssessment.maritimeInterdiction.assignments = [raid];
  world.supplyAssessment.maritimeInterdiction.assignmentsByLinkId = new Map([[linkId, [raid]]]);
  world.time.fastTick += 1;
  updateNavalStrategy(world);
  assert.equal(world.supplyAssessment.navalStrategy.missionByShipId.get(defender.id)?.type, "INTERCEPT");
  assert.equal(world.supplyAssessment.navalStrategy.emergencyOverrides, 1);
});

test("Naval AI creates a real-port blockade mission only as surplus commitment", () => {
  const world = createStrategicAllocationWorld(2);
  const assessment = world.supplyAssessment.maritimeInterdiction.assessments[0];
  assert(assessment);
  assessment.targetPriority.total = 100;
  world.supplyAssessment.maritimeEscorts.demands = [];
  updateNavalStrategy(world);
  const blockade = world.supplyAssessment.navalStrategy.missions.find((mission) => mission.type === "BLOCKADE");
  assert(blockade?.targetPortId);
  assert.equal(blockade.targetLinkId, assessment.maritimeLinkId);
});

test("CombatShips deliberately select moving enemy convoys without interdicting static routes", () => {
  const world = createInterdictionWorld(["sea-ab", "sea-cd"]);
  updateSupplyAssessment(world);
  const raids = world.supplyAssessment.maritimeInterdiction.assignments;
  assert.equal(raids.length, 2);
  assert.equal(new Set(raids.map((raid) => raid.combatShipId)).size, 2);
  assert.equal(new Set(raids.map((raid) => raid.maritimeLinkId)).size, 2);
  assert(raids.every((raid) => Number.isFinite(raid.targetScore) && raid.targetReason.length > 0));
  assert(raids.every((raid) => raid.status === "intercepting"));
  assert.equal(world.supplyAssessment.maritimeInterdiction.interdictedLinkIds.size, 0);
  assert.equal(WORLD_BALANCE.unit.naval?.enabled, true);
});

test("an unprotected raider destroys a transport and isolates a multi-hop overseas army", () => {
  const world = createInterdictionWorld(["sea-ab"]);
  const transport = world.units.find((unit) => unit.type === "TransportShip" && unit.regionId === id("port-a"));
  assert(transport);
  world.units = world.units.filter((unit) => unit.type !== "TransportShip" || unit.id === transport.id);
  transport.moveTicksPerRegion = 1;
  transport.org = 0.01;
  updateSupplyAssessment(world);
  updateMaritimeInterdictionMovement(world, FAST_TICK_MS);
  updateMaritimeLogisticsMovement(world, FAST_TICK_MS);
  updateBattles(world);
  recordMaritimeInterdictionCombat(world);
  assert(!world.units.some((unit) => unit.id === transport.id));
  assert.equal(world.supplyAssessment.maritimeInterdiction.transportsDestroyed, 1);
  updateSupplyAssessment(world);
  assert.equal(isNationRegionSupplied(world, NATION_A, id("island-b")), false);
  assert.equal(isNationRegionSupplied(world, NATION_A, id("island-c")), false);
  assert.equal(world.supplyAssessment.maritimeInterdiction.supplyInterruptions, 1);
});

test("raid movement uses naval pathfinding only toward the selected sea route", () => {
  const world = createInterdictionWorld(["port-b"]);
  updateSupplyAssessment(world);
  const raid = world.supplyAssessment.maritimeInterdiction.assignments[0];
  assert(raid);
  assert.equal(raid.status, "moving-to-route");
  const ship = world.units.find((unit) => unit.id === raid.combatShipId);
  assert(ship);
  updateMaritimeInterdictionMovement(world, FAST_TICK_MS);
  assert(raid.routeRegionIds.includes(ship.regionId));
  assert.equal(world.mesoRegions.find((region) => region.id === ship.regionId)?.type, "sea");
  assert.equal(ship.moveTargetId, null);
  assert.equal(raid.status, "intercepting");
});

test("an escort fights before its transport becomes vulnerable", () => {
  const world = createInterdictionWorld(["sea-ab"]);
  const escort = createUnitForType(
    createUnitId(world.unitIdCounter++), NATION_A, id("sea-ab"), "CombatShip",
  );
  escort.moveTicksPerRegion = 1;
  world.units.push(escort);
  const transport = world.units.find((unit) => unit.type === "TransportShip" && unit.regionId === id("port-a"));
  assert(transport);
  world.units = world.units.filter((unit) => unit.type !== "TransportShip" || unit.id === transport.id);
  transport.moveTicksPerRegion = 1;
  updateSupplyAssessment(world);
  const escortLinkId = getEscortAssignment(world, escort.id)?.maritimeLinkId;
  const escortTransportId = world.supplyAssessment.maritimeLogistics.assignments
    .find((assignment) => assignment.maritimeLinkId === escortLinkId)?.transportId;
  const escortedTransport = world.units.find((unit) => unit.id === escortTransportId);
  assert(escortedTransport);
  escort.regionId = escortedTransport.regionId;
  updateSupplyAssessment(world);
  updateConvoyMovement(world, FAST_TICK_MS);
  updateMaritimeInterdictionMovement(world, FAST_TICK_MS);
  const manpowerBefore = transport.manpower;
  const orgBefore = transport.org;
  updateBattles(world);
  recordMaritimeInterdictionCombat(world);
  assert.equal(transport.manpower, manpowerBefore);
  assert.equal(transport.org, orgBefore);
  assert(escort.manpower < WORLD_BALANCE.unit.types.CombatShip.manpower ||
    world.units.find((unit) => unit.nationId === NATION_B && unit.type === "CombatShip")!.manpower <
      WORLD_BALANCE.unit.types.CombatShip.manpower);
  assert.equal(world.supplyAssessment.maritimeInterdiction.escortEngagements, 1);
  assert.equal(getEscortAssignment(world, escort.id)?.status, "escorting");
});

test("a physical replacement transport restores interdicted supply and records reconnection duration", () => {
  const world = createInterdictionWorld(["sea-ab"]);
  const transport = world.units.find((unit) => unit.type === "TransportShip" && unit.regionId === id("port-a"));
  assert(transport);
  world.units = world.units.filter((unit) => unit.type !== "TransportShip" || unit.id === transport.id);
  transport.moveTicksPerRegion = 1;
  transport.org = 0.01;
  updateSupplyAssessment(world);
  updateConvoyMovement(world, FAST_TICK_MS);
  updateMaritimeInterdictionMovement(world, FAST_TICK_MS);
  updateBattles(world);
  recordMaritimeInterdictionCombat(world);
  updateSupplyAssessment(world);
  assert.equal(isNationRegionSupplied(world, NATION_A, id("island-b")), false);

  const raider = world.units.find((unit) => unit.nationId === NATION_B && unit.type === "CombatShip");
  assert(raider);
  world.units = world.units.filter((unit) => unit.id !== raider.id);
  world.time.fastTick += 7;
  const replacement = createUnitForType(
    createUnitId(world.unitIdCounter++), NATION_A, id("sea-ab"), "TransportShip",
  );
  world.units.push(replacement);
  updateSupplyAssessment(world);
  assert.equal(isNationRegionSupplied(world, NATION_A, id("island-b")), true);
  assert.equal(world.supplyAssessment.maritimeInterdiction.reconnections, 1);
  assert.equal(world.supplyAssessment.maritimeInterdiction.totalInterruptionDurationTicks, 7);
});

test("port capture releases a raid and route restoration deterministically reassigns it", () => {
  const world = createInterdictionWorld(["sea-ab"]);
  updateSupplyAssessment(world);
  const raid = world.supplyAssessment.maritimeInterdiction.assignments[0];
  assert(raid);
  world.occupation.mesoById.set(id("port-b"), NATION_B);
  world.occupation.version += 1;
  updateSupplyAssessment(world);
  assert.equal(world.supplyAssessment.maritimeInterdiction.assignments.length, 0);
  world.occupation.mesoById.delete(id("port-b"));
  world.occupation.version += 1;
  updateSupplyAssessment(world);
  assert.equal(world.supplyAssessment.maritimeInterdiction.assignments[0]?.combatShipId, raid.combatShipId);
});

test("interdiction assessment and assignments are deterministic", () => {
  const first = createInterdictionWorld(["sea-cd", "sea-ab"]);
  const second = createInterdictionWorld(["sea-cd", "sea-ab"]);
  updateSupplyAssessment(first);
  updateSupplyAssessment(second);
  const summarize = (world: WorldState) => ({
    assessments: world.supplyAssessment.maritimeInterdiction.assessments.map((item) => ({
      attacker: item.attackerNationId,
      link: item.maritimeLinkId,
      score: item.targetPriority.total,
      reasons: item.targetPriority.reasons,
    })),
    assignments: world.supplyAssessment.maritimeInterdiction.assignments.map((item) => ({
      ship: item.combatShipId,
      link: item.maritimeLinkId,
      route: item.positioningRouteIds,
    })),
  });
  assert.deepEqual(summarize(first), summarize(second));
});

test("reserve fleets do not start combat through co-location", () => {
  const world = createMaritimeCutoffWorld(false);
  for (const region of world.mesoRegions) {
    if (region.building === "port") region.building = null;
  }
  world.buildingVersion += 1;
  world.units = world.units.filter((unit) => unit.domain === "land");
  const shipA = createUnitForType(
    createUnitId(world.unitIdCounter++), NATION_A, id("sea-ab"), "CombatShip",
  );
  const shipB = createUnitForType(
    createUnitId(world.unitIdCounter++), NATION_B, id("sea-ab"), "CombatShip",
  );
  world.units.push(shipA, shipB);
  updateSupplyAssessment(world);
  assert.equal(world.supplyAssessment.maritimeLinks.length, 0);
  assert.equal(world.supplyAssessment.maritimeInterdiction.assignments.length, 0);
  updateBattles(world);
  assert.equal(shipA.manpower, WORLD_BALANCE.unit.types.CombatShip.manpower);
  assert.equal(shipB.manpower, WORLD_BALANCE.unit.types.CombatShip.manpower);
  assert.equal(world.battles.length, 0);
});

test("a reserve ship defends itself when an enemy raid mission attacks", () => {
  const world = createInterdictionWorld(["sea-ab"]);
  for (let index = 0; index < 3; index += 1) {
    world.units.push(createUnitForType(
      createUnitId(world.unitIdCounter++), NATION_A, id("port-a"), "CombatShip",
    ));
  }
  updateSupplyAssessment(world);
  const raider = world.units.find((unit) =>
    unit.nationId === NATION_B && unit.type === "CombatShip");
  const reserve = world.units.find((unit) =>
    unit.nationId === NATION_A && unit.type === "CombatShip" &&
    getNavalUnitOwnership(world, unit.id)?.missionType === "RESERVE");
  assert(raider && reserve);
  reserve.regionId = raider.regionId;
  const manpowerBefore = reserve.manpower;
  updateBattles(world);
  assert(reserve.manpower < manpowerBefore || !world.units.some((unit) => unit.id === reserve.id));
});

test("a physical convoy continuously travels port-to-port and returns without teleporting", () => {
  const world = createMaritimeWorld(true, 1);
  updateSupplyAssessment(world);
  const link = world.supplyAssessment.maritimeLinks.find((candidate) => candidate.active);
  assert(link);
  const convoy = world.supplyAssessment.convoys.convoyByLinkId.get(link.id);
  assert(convoy?.transportId);
  const transport = world.units.find((unit) => unit.id === convoy.transportId);
  assert(transport);
  transport.moveTicksPerRegion = 1;
  const visited = [transport.regionId];
  for (let tick = 0; tick < 6; tick += 1) {
    world.time.fastTick += 1;
    updateConvoyMovement(world, FAST_TICK_MS);
    visited.push(transport.regionId);
  }
  assert.deepEqual(visited.slice(0, 3), [id("port-a"), id("sea-ab"), id("port-b")]);
  assert(visited.includes(id("port-a")) && visited.includes(id("port-b")));
  assert.equal(convoy.completedCycles, 1);
  assert.equal(world.supplyAssessment.convoys.successfulDeliveries, 1);
  assert.equal(link.active, true);
});

test("formed escorts remain co-located with their convoy transport throughout a cycle", () => {
  const world = createMaritimeWorld(true, 1);
  world.units.push(
    createUnitForType(createUnitId(world.unitIdCounter++), NATION_A, id("island-b"), "Infantry"),
    createUnitForType(createUnitId(world.unitIdCounter++), NATION_A, id("port-a"), "CombatShip"),
  );
  updateSupplyAssessment(world);
  const convoy = world.supplyAssessment.convoys.convoys.find((candidate) => candidate.escortIds.length > 0);
  assert(convoy?.transportId);
  const transport = world.units.find((unit) => unit.id === convoy.transportId);
  const escort = world.units.find((unit) => unit.id === convoy.escortIds[0]);
  assert(transport && escort);
  transport.moveTicksPerRegion = 1;
  escort.moveTicksPerRegion = 1;
  for (let tick = 0; tick < 6; tick += 1) {
    world.time.fastTick += 1;
    updateConvoyMovement(world, FAST_TICK_MS);
    assert.equal(escort.regionId, transport.regionId);
    assert.equal(escort.moveToId, transport.moveToId);
  }
});

test("one threatened convoy supports multiple escorts and preserves identity across replacement", () => {
  const world = createInterdictionWorld(["sea-ab", "sea-ab"]);
  updateSupplyAssessment(world);
  const raidLinkId = world.supplyAssessment.maritimeInterdiction.assignments[0]?.maritimeLinkId;
  assert(raidLinkId);
  const link = world.supplyAssessment.maritimeLinks.find((candidate) => candidate.id === raidLinkId);
  assert(link?.assignedTransportIds[0]);
  const transport = world.units.find((unit) => unit.id === link.assignedTransportIds[0]);
  assert(transport);
  const escortA = createUnitForType(
    createUnitId(world.unitIdCounter++), NATION_A, transport.regionId, "CombatShip",
  );
  const escortB = createUnitForType(
    createUnitId(world.unitIdCounter++), NATION_A, transport.regionId, "CombatShip",
  );
  world.units.push(escortA, escortB);
  updateSupplyAssessment(world);
  const convoy = world.supplyAssessment.convoys.convoyByLinkId.get(raidLinkId);
  assert(convoy);
  assert.equal(convoy.escortIds.length, 2);
  const convoyId = convoy.id;
  world.units = world.units.filter((unit) => unit.id !== escortA.id);
  const replacement = createUnitForType(
    createUnitId(world.unitIdCounter++), NATION_A, transport.regionId, "CombatShip",
  );
  world.units.push(replacement);
  updateSupplyAssessment(world);
  const refreshed = world.supplyAssessment.convoys.convoyByLinkId.get(raidLinkId);
  assert.equal(refreshed?.id, convoyId);
  assert(refreshed?.escortIds.includes(replacement.id));
  assert.equal(world.supplyAssessment.convoys.escortLosses, 1);
  assert.equal(world.supplyAssessment.convoys.replacementEscorts, 1);
});

test("convoy identity survives port capture, reconnection, and transport replacement", () => {
  const world = createMaritimeWorld(true, 1);
  updateSupplyAssessment(world);
  const link = world.supplyAssessment.maritimeLinks.find((candidate) => candidate.active);
  assert(link);
  const convoyId = world.supplyAssessment.convoys.convoyByLinkId.get(link.id)?.id;
  const transportId = link.assignedTransportIds[0];
  assert(convoyId && transportId);
  world.occupation.mesoById.set(link.destinationPortId, NATION_B);
  world.occupation.version += 1;
  updateSupplyAssessment(world);
  assert.equal(world.supplyAssessment.convoys.convoyByLinkId.get(link.id)?.state, "suspended");
  world.occupation.mesoById.delete(link.destinationPortId);
  world.occupation.version += 1;
  world.units = world.units.filter((unit) => unit.id !== transportId);
  world.units.push(createUnitForType(
    createUnitId(world.unitIdCounter++), NATION_A, link.sourcePortId, "TransportShip",
  ));
  updateSupplyAssessment(world);
  const restored = world.supplyAssessment.convoys.convoyByLinkId.get(link.id);
  assert.equal(restored?.id, convoyId);
  assert.notEqual(restored?.transportId, transportId);
  assert.equal(restored?.state === "suspended", false);
  assert.equal(world.supplyAssessment.convoys.replacementTransports, 1);
});

test("land supply remains capital-component based without ports", () => {
  const world = createMaritimeWorld(false);
  updateSupplyAssessment(world);
  assert.equal(isNationRegionSupplied(world, NATION_A, id("capital")), true);
  assert.equal(isNationRegionSupplied(world, NATION_A, id("land")), true);
  assert.equal(world.supplyAssessment.maritimeLinks.length, 0);
  assert.equal(world.supplyAssessment.maritimeEscorts.demands.length, 0);
  assert.equal(world.supplyAssessment.maritimeEscorts.assignments.length, 0);
});

test("naval gameplay does not provide abstract shipping without a physical transport", () => {
  const world = createMaritimeWorld(true, 0);
  assert.equal(world.units.length, 0);
  updateSupplyAssessment(world);
  assert.equal(isNationRegionSupplied(world, NATION_A, id("island-b")), false);
  assert(world.supplyAssessment.maritimeLinks.some((link) =>
    link.sourcePortId === id("port-a") &&
    link.destinationPortId === id("port-b") &&
    !link.active &&
    link.reason === "no-transport"
  ));
});

test("one real TransportShip activates one link and cannot support the second hop", () => {
  const world = createMaritimeWorld(true, 1);
  updateSupplyAssessment(world);
  assert.equal(isNationRegionSupplied(world, NATION_A, id("island-b")), true);
  assert.equal(isNationRegionSupplied(world, NATION_A, id("island-c")), false);
  assert.equal(world.supplyAssessment.maritimeLogistics.assignments.length, 1);
  assert.equal(new Set(
    world.supplyAssessment.maritimeLogistics.assignments.map((assignment) => assignment.transportId),
  ).size, 1);
  const active = world.supplyAssessment.maritimeLinks.filter((link) => link.active);
  assert.equal(active.length, 1);
  assert.equal(active[0]?.requiredTransportCount, 1);
});

test("two real TransportShips support both multi-hop links", () => {
  const world = createMaritimeWorld(true, 2);
  updateSupplyAssessment(world);
  assert.equal(isNationRegionSupplied(world, NATION_A, id("island-b")), true);
  assert.equal(isNationRegionSupplied(world, NATION_A, id("island-c")), true);
  assert.equal(world.supplyAssessment.maritimeLogistics.assignments.length, 2);
  assert.equal(new Set(
    world.supplyAssessment.maritimeLogistics.assignments.map((assignment) => assignment.transportId),
  ).size, 2);
});

test("transport destruction breaks supply and a physical replacement restores it", () => {
  const world = createMaritimeWorld(true, 1);
  updateSupplyAssessment(world);
  const lostId = world.supplyAssessment.maritimeLogistics.assignments[0]?.transportId;
  assert(lostId);
  world.units = world.units.filter((unit) => unit.id !== lostId);
  updateSupplyAssessment(world);
  assert.equal(isNationRegionSupplied(world, NATION_A, id("island-b")), false);
  assert.equal(world.supplyAssessment.maritimeLogistics.transportLosses, 1);
  assert.equal(world.supplyAssessment.maritimeLogistics.linksBrokenByTransportLoss, 1);

  const replacement = createUnitForType(
    createUnitId(world.unitIdCounter++),
    NATION_A,
    id("port-a"),
    "TransportShip",
  );
  world.units.push(replacement);
  updateSupplyAssessment(world);
  assert.equal(isNationRegionSupplied(world, NATION_A, id("island-b")), true);
  assert.equal(world.supplyAssessment.maritimeLogistics.assignments[0]?.transportId, replacement.id);
  assert(world.supplyAssessment.maritimeLogistics.linksRestoredByReplacement > 0);
});

test("scarce transport deterministically prioritizes a remote component with land forces", () => {
  const first = createMaritimeWorld(true, 1);
  const second = createMaritimeWorld(true, 1);
  for (const world of [first, second]) {
    connect(world, "sea-ab", "sea-cd");
    world.mapVersion += 1;
    world.units.push(createUnitForType(
      createUnitId(world.unitIdCounter++), NATION_A, id("island-c"), "Infantry",
    ));
    updateSupplyAssessment(world);
  }
  const summarize = (world: WorldState) => world.supplyAssessment.maritimeLinks
    .filter((link) => link.active)
    .map((link) => link.id);
  assert.deepEqual(summarize(first), summarize(second));
  assert.equal(isNationRegionSupplied(first, NATION_A, id("island-c")), true);
  assert.equal(isNationRegionSupplied(first, NATION_A, id("island-b")), false);
});

test("CombatShips never satisfy maritime transport demand", () => {
  const world = createMaritimeWorld(true, 0);
  world.units.push(createUnitForType(
    createUnitId(world.unitIdCounter++), NATION_A, id("port-a"), "CombatShip",
  ));
  updateSupplyAssessment(world);
  assert.equal(isNationRegionSupplied(world, NATION_A, id("island-b")), false);
  assert.equal(world.supplyAssessment.maritimeLogistics.assignments.length, 0);
  assert.equal(WORLD_BALANCE.unit.naval?.enabled, true);
});

test("logistics-only movement stations an assigned transport with naval gameplay enabled", () => {
  const world = createMaritimeWorld(true, 0);
  connect(world, "sea-ab", "sea-cd");
  world.mapVersion += 1;
  const transport = createUnitForType(
    createUnitId(world.unitIdCounter++), NATION_A, id("port-d"), "TransportShip",
  );
  transport.moveTicksPerRegion = 1;
  world.units.push(transport);
  updateSupplyAssessment(world);
  assert.equal(isNationRegionSupplied(world, NATION_A, id("island-b")), true);
  assert.equal(
    world.supplyAssessment.maritimeLogistics.assignmentByTransportId.get(transport.id)?.status,
    "moving-to-source",
  );
  for (let tick = 0; tick < 4; tick += 1) {
    world.time.fastTick += 1;
    updateMaritimeLogisticsMovement(world, FAST_TICK_MS);
  }
  updateSupplyAssessment(world);
  assert.equal(isNationRegionSupplied(world, NATION_A, id("island-b")), true);
  assert.equal(
    world.supplyAssessment.maritimeLogistics.assignmentByTransportId.get(transport.id)?.status,
    "stationed",
  );
  assert.equal(WORLD_BALANCE.unit.naval?.enabled, true);
});

test("demand-driven naval production allows only requested logistics transports", () => {
  const world = createMaritimeWorld(true, 0);
  const nation = world.nations[0]!;
  nation.resources.manpower = 100_000;
  nation.resources.weapons = 10_000;
  nation.nextUnitProductionTick = 0;
  updateSupplyAssessment(world);
  updateProduction(world);
  assert(world.units.some((unit) => unit.type === "TransportShip"));
  assert(!world.units.some((unit) => unit.type === "CombatShip"));
});

test("a real CombatShip reaches and protects a physical maritime logistics link", () => {
  const world = createMaritimeWorld(true, 1);
  world.units.push(createUnitForType(
    createUnitId(world.unitIdCounter++), NATION_A, id("island-b"), "Infantry",
  ));
  const escort = createUnitForType(
    createUnitId(world.unitIdCounter++), NATION_A, id("port-a"), "CombatShip",
  );
  escort.moveTicksPerRegion = 1;
  world.units.push(escort);
  updateSupplyAssessment(world);
  const link = world.supplyAssessment.maritimeLinks.find((candidate) => candidate.active);
  assert(link);
  assert.equal(getEscortAssignment(world, escort.id)?.maritimeLinkId, link.id);
  assert.equal(getMaritimeLinkProtection(world, link.id).protectionState, "PROTECTED");
  world.time.fastTick += 1;
  updateMaritimeEscortMovement(world, FAST_TICK_MS);
  assert.equal(getEscortAssignment(world, escort.id)?.status, "escorting");
  assert.equal(getMaritimeLinkProtection(world, link.id).protectionState, "PROTECTED");
  assert.equal(WORLD_BALANCE.unit.naval?.enabled, true);
});

test("TransportShips cannot escort and absent escorts do not disable Supply", () => {
  const world = createMaritimeWorld(true, 1);
  world.units.push(createUnitForType(
    createUnitId(world.unitIdCounter++), NATION_A, id("island-b"), "Infantry",
  ));
  updateSupplyAssessment(world);
  const link = world.supplyAssessment.maritimeLinks.find((candidate) => candidate.active);
  assert(link);
  assert.equal(link.active, true);
  assert.equal(isNationRegionSupplied(world, NATION_A, id("island-b")), true);
  assert.equal(world.supplyAssessment.maritimeEscorts.assignments.length, 0);
  assert.equal(getMaritimeLinkProtection(world, link.id).protectionState, "UNPROTECTED");
});

test("one CombatShip cannot escort two links and scarce escort favors the stronger remote army", () => {
  const first = createMaritimeWorld(true, 2);
  const second = createMaritimeWorld(true, 2);
  for (const world of [first, second]) {
    world.units.push(createUnitForType(
      createUnitId(world.unitIdCounter++), NATION_A, id("island-b"), "Infantry",
    ));
    for (let index = 0; index < 3; index += 1) {
      world.units.push(createUnitForType(
        createUnitId(world.unitIdCounter++), NATION_A, id("island-c"), "Infantry",
      ));
    }
    world.units.push(createUnitForType(
      createUnitId(world.unitIdCounter++), NATION_A, id("sea-cd"), "CombatShip",
    ));
    world.units.at(-1)!.moveTicksPerRegion = 1;
    updateSupplyAssessment(world);
    updateMaritimeEscortMovement(world, FAST_TICK_MS);
  }
  const summarize = (world: WorldState) => world.supplyAssessment.maritimeEscorts.assignments
    .map((assignment) => assignment.maritimeLinkId);
  assert.deepEqual(summarize(first), summarize(second));
  assert.equal(first.supplyAssessment.maritimeEscorts.assignments.length, 1);
  const assignment = first.supplyAssessment.maritimeEscorts.assignments[0];
  const assignedLink = first.supplyAssessment.maritimeLinks.find((link) =>
    link.id === assignment?.maritimeLinkId
  );
  assert.equal(assignedLink?.destinationPortId, id("port-d"));
  assert.equal(new Set(summarize(first)).size, 1);
  const protection = first.supplyAssessment.maritimeLinks
    .filter((link) => link.active)
    .map((link) => getMaritimeLinkProtection(first, link.id).protectionState)
    .sort();
  assert.deepEqual(protection, ["UNPROTECTED", "UNPROTECTED"]);
  for (const demand of first.supplyAssessment.maritimeEscorts.demands) {
    assert(Number.isFinite(demand.remoteStrength));
    assert(demand.priority.every(Number.isFinite));
  }
  const validUnitIds = new Set(first.units.map((unit) => unit.id));
  assert(first.supplyAssessment.maritimeEscorts.assignments.every((item) =>
    validUnitIds.has(item.combatShipId)
  ));
});

test("two CombatShips independently protect two multi-hop maritime links", () => {
  const world = createMaritimeWorld(true, 2);
  world.units.push(
    createUnitForType(createUnitId(world.unitIdCounter++), NATION_A, id("island-b"), "Infantry"),
    createUnitForType(createUnitId(world.unitIdCounter++), NATION_A, id("island-c"), "Infantry"),
    createUnitForType(createUnitId(world.unitIdCounter++), NATION_A, id("port-a"), "CombatShip"),
    createUnitForType(createUnitId(world.unitIdCounter++), NATION_A, id("port-c"), "CombatShip"),
  );
  updateSupplyAssessment(world);
  const activeLinks = world.supplyAssessment.maritimeLinks.filter((link) => link.active);
  assert.equal(activeLinks.length, 2);
  assert.equal(world.supplyAssessment.maritimeEscorts.assignments.length, 2);
  assert.equal(new Set(world.supplyAssessment.maritimeEscorts.assignments
    .map((assignment) => assignment.combatShipId)).size, 2);
  assert(activeLinks.every((link) =>
    getMaritimeLinkProtection(world, link.id).protectionState === "PROTECTED"
  ));
});

test("escort loss leaves Supply active and allows deterministic replacement", () => {
  const world = createMaritimeWorld(true, 1);
  world.units.push(
    createUnitForType(createUnitId(world.unitIdCounter++), NATION_A, id("island-b"), "Infantry"),
    createUnitForType(createUnitId(world.unitIdCounter++), NATION_A, id("sea-ab"), "CombatShip"),
  );
  updateSupplyAssessment(world);
  const link = world.supplyAssessment.maritimeLinks.find((candidate) => candidate.active);
  assert(link);
  const lostEscortId = world.supplyAssessment.maritimeEscorts.assignments[0]?.combatShipId;
  assert(lostEscortId);
  world.units = world.units.filter((unit) => unit.id !== lostEscortId);
  updateSupplyAssessment(world);
  assert.equal(link.destinationLandComponentId
    ? world.supplyAssessment.componentById.get(link.destinationLandComponentId)?.supplied
    : false, true);
  assert.equal(getMaritimeLinkProtection(world, link.id).protectionState, "UNPROTECTED");
  assert.equal(world.supplyAssessment.maritimeEscorts.escortLosses, 1);

  const replacement = createUnitForType(
    createUnitId(world.unitIdCounter++), NATION_A, id("port-a"), "CombatShip",
  );
  world.units.push(replacement);
  updateSupplyAssessment(world);
  assert.equal(getEscortAssignment(world, replacement.id)?.maritimeLinkId, link.id);
  assert.equal(getMaritimeLinkProtection(world, link.id).protectionState, "PROTECTED");
});

test("transport loss still disables Supply without being masked by escort state", () => {
  const world = createMaritimeWorld(true, 1);
  world.units.push(
    createUnitForType(createUnitId(world.unitIdCounter++), NATION_A, id("island-b"), "Infantry"),
    createUnitForType(createUnitId(world.unitIdCounter++), NATION_A, id("sea-ab"), "CombatShip"),
  );
  updateSupplyAssessment(world);
  const transportId = world.supplyAssessment.maritimeLogistics.assignments[0]?.transportId;
  assert(transportId);
  world.units = world.units.filter((unit) => unit.id !== transportId);
  updateSupplyAssessment(world);
  assert.equal(isNationRegionSupplied(world, NATION_A, id("island-b")), false);
  assert.equal(world.supplyAssessment.maritimeEscorts.assignments.length, 1);
});

test("escort assignment persists without churn across unchanged evaluations", () => {
  const world = createMaritimeWorld(true, 1);
  world.units.push(
    createUnitForType(createUnitId(world.unitIdCounter++), NATION_A, id("island-b"), "Infantry"),
    createUnitForType(createUnitId(world.unitIdCounter++), NATION_A, id("sea-ab"), "CombatShip"),
  );
  updateSupplyAssessment(world);
  const first = world.supplyAssessment.maritimeEscorts.assignments[0];
  const changes = world.supplyAssessment.maritimeEscorts.assignmentChanges;
  updateSupplyAssessment(world);
  const second = world.supplyAssessment.maritimeEscorts.assignments[0];
  assert.equal(second?.combatShipId, first?.combatShipId);
  assert.equal(second?.maritimeLinkId, first?.maritimeLinkId);
  assert.equal(second?.assignedTick, first?.assignedTick);
  assert.equal(world.supplyAssessment.maritimeEscorts.assignmentChanges, changes);
});

test("port capture releases an escort and route restoration permits reassignment", () => {
  const world = createMaritimeWorld(true, 1);
  const escort = createUnitForType(
    createUnitId(world.unitIdCounter++), NATION_A, id("sea-ab"), "CombatShip",
  );
  world.units.push(
    createUnitForType(createUnitId(world.unitIdCounter++), NATION_A, id("island-b"), "Infantry"),
    escort,
  );
  updateSupplyAssessment(world);
  assert(getEscortAssignment(world, escort.id));
  world.occupation.mesoById.set(id("port-b"), NATION_B);
  world.occupation.version += 1;
  updateSupplyAssessment(world);
  assert.equal(getEscortAssignment(world, escort.id), undefined);
  world.occupation.mesoById.delete(id("port-b"));
  world.occupation.version += 1;
  updateSupplyAssessment(world);
  assert(getEscortAssignment(world, escort.id));
});

test("escort-demand production creates only the required CombatShip while general naval gameplay is enabled", () => {
  const world = createMaritimeWorld(true, 1);
  world.units.push(createUnitForType(
    createUnitId(world.unitIdCounter++), NATION_A, id("island-b"), "Infantry",
  ));
  const nation = world.nations[0]!;
  nation.resources.manpower = 100_000;
  nation.resources.weapons = 10_000;
  nation.nextUnitProductionTick = 0;
  updateSupplyAssessment(world);
  updateProduction(world);
  assert(world.units.some((unit) => unit.type === "CombatShip"));
  const combatShip = world.units.find((unit) => unit.type === "CombatShip");
  assert(combatShip && getNavalUnitOwnership(world, combatShip.id));
  assert.equal(world.supplyAssessment.maritimeEscorts.combatShipsProducedForEscortDemand, 1);
  assert.equal(WORLD_BALANCE.unit.naval?.enabled, true);
});

test("enabling general naval gameplay does not trigger demand-free naval production", () => {
  assert.equal(WORLD_BALANCE.unit.naval?.enabled, true);
  const world = createMaritimeWorld(true, 2);
  const nation = world.nations[0]!;
  nation.resources.manpower = 100_000;
  nation.resources.weapons = 10_000;
  nation.nextUnitProductionTick = 0;
  updateSupplyAssessment(world);
  const before = world.units.filter((unit) => unit.domain === "naval").length;
  updateProduction(world);
  assert.equal(world.units.filter((unit) => unit.domain === "naval").length, before);
  assert.equal(world.productionDiagnostics.navalTransportRequests, 0);
  assert.equal(world.productionDiagnostics.navalEscortRequests, 0);
  assert.equal(world.productionDiagnostics.navalReserveRequests, 0);
});

test("zero fleet deliberately bootstraps from a reachable enemy maritime opportunity", () => {
  const world = createMaritimeCutoffWorld(false);
  addEnemyPort(world);
  const nation = world.nations.find((item) => item.id === NATION_B)!;
  nation.resources.manpower = 100_000;
  nation.resources.weapons = 10_000;
  nation.nextUnitProductionTick = 0;
  updateSupplyAssessment(world);
  const force = world.supplyAssessment.navalStrategy.assessments
    .find((assessment) => assessment.nationId === NATION_B)?.desiredForce;
  assert(force);
  assert.equal(force.currentCombatShips, 0);
  assert.equal(force.offensiveOpportunityDemand, 1);
  assert.equal(force.desiredCombatShips, 2);
  updateProduction(world);
  const ship = world.units.find((unit) => unit.nationId === NATION_B && unit.type === "CombatShip");
  assert(ship);
  assert.equal(getNavalUnitOwnership(world, ship.id)?.missionType, "RESERVE");
  assert.equal(world.productionDiagnostics.navalCombatFulfilledByReason["offensive-bootstrap"], 1);
  updateSupplyAssessment(world);
  assert(["RAID", "BLOCKADE"].includes(getNavalUnitOwnership(world, ship.id)?.missionType ?? ""));
});

test("landlocked zero-fleet nation cannot request CombatShip production", () => {
  const world = createMaritimeCutoffWorld(false);
  const nation = world.nations.find((item) => item.id === NATION_B)!;
  nation.resources.manpower = 100_000;
  nation.resources.weapons = 10_000;
  nation.nextUnitProductionTick = 0;
  updateSupplyAssessment(world);
  updateProduction(world);
  assert(!world.units.some((unit) => unit.nationId === NATION_B && unit.type === "CombatShip"));
  assert.equal(world.productionDiagnostics.navalCombatRequestsByReason["offensive-bootstrap"], 0);
});

test("multiple enemy maritime links create one bounded offensive force target", () => {
  const world = createMaritimeCutoffWorld(false);
  addEnemyPort(world);
  connect(world, "sea-ab", "sea-cd");
  world.mapVersion += 1;
  updateSupplyAssessment(world);
  const assessment = world.supplyAssessment.navalStrategy.assessments
    .find((item) => item.nationId === NATION_B);
  assert(assessment);
  assert(assessment.raidOpportunities >= 2);
  assert.equal(assessment.desiredForce.offensiveOpportunityDemand, 1);
  assert(assessment.desiredForce.desiredCombatShips <= 4);
});

test("offensive bootstrap obeys scarce-economy production failure", () => {
  const world = createMaritimeCutoffWorld(false);
  addEnemyPort(world);
  const nation = world.nations.find((item) => item.id === NATION_B)!;
  nation.resources.manpower = 0;
  nation.resources.weapons = 0;
  nation.nextUnitProductionTick = 0;
  updateSupplyAssessment(world);
  updateProduction(world);
  assert(!world.units.some((unit) => unit.nationId === NATION_B && unit.type === "CombatShip"));
  assert(world.productionDiagnostics.blockedProductions > 0);
});

test("lost final port suppresses otherwise valid offensive production", () => {
  const world = createMaritimeCutoffWorld(false);
  addEnemyPort(world);
  const nation = world.nations.find((item) => item.id === NATION_B)!;
  nation.resources.manpower = 100_000;
  nation.resources.weapons = 10_000;
  nation.nextUnitProductionTick = 0;
  world.occupation.mesoById.set(id("enemy-port"), NATION_A);
  world.occupation.version += 1;
  updateSupplyAssessment(world);
  updateProduction(world);
  assert(!world.units.some((unit) => unit.nationId === NATION_B && unit.type === "CombatShip"));
});

test("an opportunity disappearing before production leaves no stale request", () => {
  const world = createMaritimeCutoffWorld(false);
  addEnemyPort(world);
  const nation = world.nations.find((item) => item.id === NATION_B)!;
  nation.resources.manpower = 100_000;
  nation.resources.weapons = 10_000;
  nation.nextUnitProductionTick = 0;
  updateSupplyAssessment(world);
  assert(world.supplyAssessment.navalStrategy.assessments
    .find((assessment) => assessment.nationId === NATION_B)?.desiredForce.deficit);
  world.wars = [];
  updateSupplyAssessment(world);
  updateProduction(world);
  assert(!world.units.some((unit) => unit.nationId === NATION_B && unit.type === "CombatShip"));
});

test("a destroyed navy rebuilds toward its persistent strategic target", () => {
  const world = createMaritimeCutoffWorld(false);
  addEnemyPort(world);
  const nation = world.nations.find((item) => item.id === NATION_B)!;
  nation.resources.manpower = 100_000;
  nation.resources.weapons = 10_000;
  nation.nextUnitProductionTick = 0;
  updateSupplyAssessment(world);
  updateProduction(world);
  const first = world.units.find((unit) => unit.nationId === NATION_B && unit.type === "CombatShip");
  assert(first);
  updateSupplyAssessment(world);
  world.units = world.units.filter((unit) => unit.id !== first.id);
  updateSupplyAssessment(world);
  const force = world.supplyAssessment.navalStrategy.assessments
    .find((assessment) => assessment.nationId === NATION_B)?.desiredForce;
  assert(force && force.deficit > 0);
  nation.nextUnitProductionTick = 0;
  updateProduction(world);
  assert(world.units.some((unit) => unit.nationId === NATION_B && unit.type === "CombatShip"));
});

test("Reorganization reads maritime loss and reconnection only through Supply Assessment", () => {
  const world = createMaritimeWorld(true, 1);
  const unit = createUnitForType(
    createUnitId(world.unitIdCounter++), NATION_A, id("island-b"), "Infantry",
  );
  unit.org = 0.2;
  unit.manpower *= 0.5;
  for (const slot of unit.equipment) slot.fill = 0.5;
  world.units.push(unit);
  world.nations[0]!.resources.manpower = 10_000;
  world.nations[0]!.resources.weapons = 1_000;
  updateSupplyAssessment(world);
  updateReorganization(world);
  const plan = getReorganizationPlanForUnit(world, unit.id);
  assert(plan);
  plan.phase = "reorganizing";
  plan.locationRegionId = unit.regionId;

  updateReorganization(world);
  const suppliedOrg = unit.org;
  assert(suppliedOrg > 0.2);
  const transportId = world.supplyAssessment.maritimeLogistics.assignments[0]?.transportId;
  assert(transportId);
  world.units = world.units.filter((candidate) => candidate.id !== transportId);
  updateSupplyAssessment(world);
  updateReorganization(world);
  assert.equal(unit.org, suppliedOrg);
  assert.equal(plan.supplyStatus, "isolated");

  world.units.push(createUnitForType(
    createUnitId(world.unitIdCounter++), NATION_A, id("port-a"), "TransportShip",
  ));
  updateSupplyAssessment(world);
  updateReorganization(world);
  assert(unit.org > suppliedOrg);
  assert.equal(plan.supplyStatus, "supplied");
});

test("a port without a sea route cannot extend supply", () => {
  const world = createMaritimeWorld();
  disconnect(world, "port-a", "sea-ab");
  world.mapVersion += 1;
  updateSupplyAssessment(world);
  assert.equal(isNationRegionSupplied(world, NATION_A, id("island-b")), false);
  assert.equal(isNationRegionSupplied(world, NATION_A, id("island-c")), false);
  assert(world.supplyAssessment.maritimeLinks.some((link) =>
    link.sourcePortId === id("port-a") &&
    link.destinationPortId === id("port-b") &&
    link.reason === "route-invalid"
  ));
  assert(world.supplyAssessment.maritimeLinks.some((link) =>
    link.sourcePortId === id("port-c") && link.reason === "source-unsupplied"
  ));
});

test("capturing and retaking either endpoint cuts and restores maritime supply", () => {
  for (const capturedPort of ["port-a", "port-b"] as const) {
    const world = createMaritimeWorld();
    updateSupplyAssessment(world);
    assert.equal(isNationRegionSupplied(world, NATION_A, id("island-b")), true);

    world.occupation.mesoById.set(id(capturedPort), NATION_B);
    world.occupation.version += 1;
    updateSupplyAssessment(world);
    assert.equal(isNationRegionSupplied(world, NATION_A, id("island-b")), false);
    assert(world.supplyAssessment.maritimeLinks.some((link) => link.reason === "port-lost"));
    assert(world.supplyAssessment.maritimeSupplyLossesDueToPortCapture > 0);

    world.occupation.mesoById.delete(id(capturedPort));
    world.occupation.version += 1;
    updateSupplyAssessment(world);
    assert.equal(isNationRegionSupplied(world, NATION_A, id("island-b")), true);
    assert(world.supplyAssessment.maritimeReconnections > 0);
  }
});

test("multi-hop port graph supplies downstream components and a broken middle link isolates them", () => {
  const world = createMaritimeWorld();
  updateSupplyAssessment(world);
  assert.equal(isNationRegionSupplied(world, NATION_A, id("island-b")), true);
  assert.equal(isNationRegionSupplied(world, NATION_A, id("island-c")), true);
  assert(world.supplyAssessment.multiHopSupplyPropagations > 0);

  world.occupation.mesoById.set(id("port-c"), NATION_B);
  world.occupation.version += 1;
  updateSupplyAssessment(world);
  assert.equal(isNationRegionSupplied(world, NATION_A, id("island-b")), true);
  assert.equal(isNationRegionSupplied(world, NATION_A, id("island-c")), false);
});

test("cyclic directed maritime links terminate deterministically", () => {
  const first = createMaritimeWorld();
  const second = createMaritimeWorld();
  updateSupplyAssessment(first);
  updateSupplyAssessment(second);
  const summarize = (world: WorldState) => ({
    components: getNationSupplyAssessment(world, NATION_A)?.components.map((component) => ({
      regions: component.regionIds,
      supplied: component.supplied,
      reason: component.reason,
    })),
    links: world.supplyAssessment.maritimeLinks.map((link) => ({
      id: link.id,
      active: link.active,
      reason: link.reason,
      route: link.routeRegionIds,
    })),
  });
  assert.deepEqual(summarize(first), summarize(second));
  assert(first.supplyAssessment.maritimeLinks.some((link) => link.active));
  assert(first.supplyAssessment.maritimeLinks.every((link) =>
    Number.isFinite(link.routeRegionIds.length) &&
    link.routeRegionIds.every((regionId) =>
      first.mesoRegions.some((region) => region.id === regionId)
    )
  ));
});

test("maritime supply prevents decay, link loss starts grace and decay, and restoration stops it", () => {
  const world = createMaritimeWorld();
  const unit = createUnitForType(
    createUnitId(world.unitIdCounter++),
    NATION_A,
    id("island-b"),
    "Infantry",
  );
  world.units.push(unit);
  const initialOrganization = unit.org;

  updateSupplyAssessment(world);
  updateIsolationEffects(world);
  assert.equal(unit.org, initialOrganization);

  world.occupation.mesoById.set(id("port-b"), NATION_B);
  world.occupation.version += 1;
  updateSupplyAssessment(world);
  updateIsolationEffects(world);
  world.time.fastTick = WORLD_BALANCE.war.landFront.isolation.graceTicks;
  updateSupplyAssessment(world);
  updateIsolationEffects(world);
  assert.equal(unit.org, initialOrganization);

  world.time.fastTick += 1;
  updateSupplyAssessment(world);
  updateIsolationEffects(world);
  assert.equal(
    unit.org,
    initialOrganization -
      WORLD_BALANCE.war.landFront.isolation.organizationDecayPerSlowTick,
  );

  const decayedOrganization = unit.org;
  world.occupation.mesoById.delete(id("port-b"));
  world.occupation.version += 1;
  world.time.fastTick += 10;
  updateSupplyAssessment(world);
  updateIsolationEffects(world);
  assert.equal(unit.org, decayedOrganization);
  assert.equal(world.isolationEffects.maritimeReconnections, 1);
  assert.equal(world.isolationEffects.decayStoppedByReconnection, 1);
});

test("maritime-supplied island production succeeds and stops when its route is destroyed", () => {
  const world = createMaritimeWorld();
  const island = world.mesoRegions.find((region) => region.id === id("island-b"));
  assert(island);
  island.building = "city";
  world.buildingVersion += 1;
  const nation = world.nations[0]!;
  nation.resources.manpower = 100_000;
  nation.resources.weapons = 1_000;
  nation.resources.steel = 100;
  nation.nextUnitProductionTick = 0;

  updateSupplyAssessment(world);
  updateProduction(world);
  assert.equal(
    world.units.filter((unit) => unit.regionId === id("island-b")).length,
    1,
  );

  disconnect(world, "port-a", "sea-ab");
  world.mapVersion += 1;
  world.time.slowTick += 1;
  world.time.fastTick += 10;
  nation.nextUnitProductionTick = world.time.slowTick;
  updateSupplyAssessment(world);
  updateProduction(world);

  assert.equal(
    world.units.filter((unit) => unit.regionId === id("island-b")).length,
    1,
  );
  assert.equal(world.productionDiagnostics.blockedByIsolation, 1);
});

test("Supply Cutoff recognizes a maritime destination port as the remote component source", () => {
  const world = createMaritimeCutoffWorld(false);
  updateSupplyAssessment(world);
  updateLandFronts(world);
  updateBattlefieldTopology(world);
  updateSupplyCutoffAnalysis(world);
  const candidate = world.supplyCutoffs.candidates.find((item) =>
    item.attackerNationId === NATION_B && item.targetRegionId === id("port-b")
  );
  assert(candidate);
  assert.equal(candidate.sourceKind, "maritime");
  assert(candidate.reasonFlags.includes("port-supply-cutoff"));
  assert.equal(candidate.affectedUnitCount, 1);
  assert(candidate.affectedRegionIds.includes(id("island-b")));
});

test("Supply defense consumes the shared corridor prediction with force and port metadata", () => {
  const world = createMaritimeCutoffWorld(false);
  updateSupplyAssessment(world);
  updateLandFronts(world);
  updateBattlefieldTopology(world);
  updateSupplyCutoffAnalysis(world);
  updateSupplyDefense(world);
  const risk = world.supplyDefense.risks.find((item) =>
    item.nationId === NATION_A && item.regionId === id("port-b"),
  );
  const cutoff = world.supplyCutoffs.candidates.find((item) =>
    item.attackerNationId === NATION_B && item.targetRegionId === id("port-b"),
  );
  assert(risk);
  assert(cutoff);
  assert.equal(risk.supplySourceType, "maritime");
  assert.equal(risk.threatenedUnits, cutoff.affectedUnitCount);
  assert.equal(risk.threatenedPorts, cutoff.affectedPorts);
  assert.equal(risk.threatenedStrength, cutoff.affectedStrength);
  assert(Number.isFinite(risk.requiredDefenseStrength));
  assert(risk.reasonFlags.includes("maritime-supply-entry-risk"));
});

test("a redundant maritime entry does not consume another transport assignment", () => {
  const world = createMaritimeCutoffWorld(true);
  updateSupplyAssessment(world);
  assert(world.supplyAssessment.maritimeLinks.some((link) =>
    link.active && link.destinationPortId === id("port-b")
  ));
  assert.equal(
    world.supplyAssessment.maritimeLinks.filter((link) => link.active).length,
    2,
  );
  assert.equal(world.supplyAssessment.maritimeLogistics.assignments.length, 2);
  updateLandFronts(world);
  updateBattlefieldTopology(world);
  updateSupplyCutoffAnalysis(world);
  assert(world.supplyCutoffs.candidates.some((item) =>
    item.attackerNationId === NATION_B && item.targetRegionId === id("port-b")
  ));
  updateSupplyDefense(world);
  assert(world.supplyDefense.risks.some((item) => item.regionId === id("port-b")));
});

function createMaritimeCutoffWorld(alternateEntry: boolean): WorldState {
  const world = createMaritimeWorld();
  const attackerRegion: MesoRegion = {
    id: id("attacker-front"),
    type: "land",
    centerId: "micro-attacker" as MicroRegionId,
    center: { x: 45, y: 10 },
    microRegionIds: [],
    neighbors: [{ id: id("port-b"), hasRiver: false }],
    building: "capital",
    resource: null,
  };
  world.mesoRegions.push(attackerRegion);
  const portB = world.mesoRegions.find((region) => region.id === id("port-b"));
  assert(portB);
  portB.neighbors.push({ id: attackerRegion.id, hasRiver: false });
  const macro: MacroRegion = {
    id: createMacroRegionId(world.macroRegions.length),
    nationId: NATION_B,
    mesoRegionIds: [attackerRegion.id],
    isCore: true,
  };
  world.macroRegions.push(macro);
  world.nations.push(createNation(NATION_B, attackerRegion.id, [macro.id]));
  if (alternateEntry) {
    const seaAB = world.mesoRegions.find((region) => region.id === id("sea-ab"));
    const seaCD = world.mesoRegions.find((region) => region.id === id("sea-cd"));
    assert(seaAB && seaCD);
    seaAB.neighbors.push({ id: seaCD.id, hasRiver: false });
    seaCD.neighbors.push({ id: seaAB.id, hasRiver: false });
  }
  world.cache.mesoById.clear();
  world.cache.neighborsById.clear();
  world.mapVersion += 1;
  declareWar(world.wars, NATION_B, NATION_A, 0, true);
  for (let index = 0; index < 4; index += 1) {
    world.units.push(createUnitForType(
      createUnitId(world.unitIdCounter++), NATION_B, attackerRegion.id, "Infantry",
    ));
  }
  world.units.push(createUnitForType(
    createUnitId(world.unitIdCounter++), NATION_A, id("island-b"), "Infantry",
  ));
  return world;
}

function createInterdictionWorld(raiderRegions: string[]): WorldState {
  const world = createMaritimeCutoffWorld(false);
  for (const region of raiderRegions) {
    const raider = createUnitForType(
      createUnitId(world.unitIdCounter++), NATION_B, id(region), "CombatShip",
    );
    raider.moveTicksPerRegion = 1;
    world.units.push(raider);
  }
  return world;
}

function addEnemyPort(world: WorldState): void {
  const portId = id("enemy-port");
  const seaId = id("sea-ab");
  world.mesoRegions.push({
    id: portId, type: "land", centerId: "micro-enemy-port" as MicroRegionId,
    center: { x: 35, y: 15 }, microRegionIds: [],
    neighbors: [{ id: seaId, hasRiver: false }], building: "port", resource: null,
  });
  world.mesoRegions.find((region) => region.id === seaId)?.neighbors.push({ id: portId, hasRiver: false });
  const macro: MacroRegion = {
    id: createMacroRegionId(world.macroRegions.length), nationId: NATION_B,
    mesoRegionIds: [portId], isCore: true,
  };
  world.macroRegions.push(macro);
  world.nations.find((nation) => nation.id === NATION_B)?.macroRegionIds.push(macro.id);
  world.cache.mesoById.clear();
  world.cache.neighborsById.clear();
  world.mapVersion += 1;
  world.territoryVersion += 1;
  world.buildingVersion += 1;
}

function createStrategicAllocationWorld(combatShipCount: number): WorldState {
  const world = createMaritimeWorld(true, 1);
  updateSupplyAssessment(world);
  const link = world.supplyAssessment.maritimeLinks.find((candidate) => candidate.active);
  assert(link);
  for (let index = 0; index < combatShipCount; index += 1) {
    world.units.push(createUnitForType(
      createUnitId(world.unitIdCounter++), NATION_A, id("port-a"), "CombatShip",
    ));
  }
  world.supplyAssessment.maritimeEscorts.demands = [{
    maritimeLinkId: link.id, nationId: NATION_A, requiredEscortCount: 1,
    remoteUnitCount: 1, remoteStrength: 1_000,
    priority: [1, 1_000, 0, 0, 0, 0, 0], reasons: ["critical-maritime-supply"],
  }];
  world.supplyAssessment.maritimeInterdiction.assessments = [{
    attackerNationId: NATION_A, maritimeLinkId: link.id, defenderNationId: NATION_B,
    targetPriority: { remoteSuppliedStrength: 0, frontlineUnits: 0, cities: 0,
      capitalRelevance: 0, activeOperations: 0, reorganization: 0,
      supplyCutoffImportance: 1, routeLength: 2, protectionState: 2,
      total: 40, reasons: ["weak-enemy-convoy"] },
    routeRegionIds: [...link.routeRegionIds], interdicted: false,
    evaluatedAtTick: world.time.fastTick,
  }];
  return world;
}

function createMaritimeWorld(withPorts = true, transportCount = 2): WorldState {
  const specs: Array<{
    name: string;
    type?: MesoRegion["type"];
    building?: MesoRegion["building"];
    owner?: NationId;
  }> = [
    { name: "capital", building: "capital", owner: NATION_A },
    { name: "land", owner: NATION_A },
    { name: "port-a", building: withPorts ? "port" : null, owner: NATION_A },
    { name: "sea-ab", type: "sea" },
    { name: "port-b", building: withPorts ? "port" : null, owner: NATION_A },
    { name: "island-b", owner: NATION_A },
    { name: "port-c", building: withPorts ? "port" : null, owner: NATION_A },
    { name: "sea-cd", type: "sea" },
    { name: "port-d", building: withPorts ? "port" : null, owner: NATION_A },
    { name: "island-c", owner: NATION_A },
  ];
  const edges: Array<[string, string]> = [
    ["capital", "land"],
    ["land", "port-a"],
    ["port-a", "sea-ab"],
    ["sea-ab", "port-b"],
    ["port-b", "island-b"],
    ["island-b", "port-c"],
    ["port-c", "sea-cd"],
    ["sea-cd", "port-d"],
    ["port-d", "island-c"],
  ];
  const neighbors = new Map<string, string[]>();
  for (const [a, b] of edges) {
    (neighbors.get(a) ?? neighbors.set(a, []).get(a)!).push(b);
    (neighbors.get(b) ?? neighbors.set(b, []).get(b)!).push(a);
  }
  const mesoRegions: MesoRegion[] = specs.map((spec, index) => ({
    id: id(spec.name),
    type: spec.type ?? "land",
    centerId: `micro-${index}` as MicroRegionId,
    center: { x: index * 10, y: 0 },
    microRegionIds: [],
    neighbors: (neighbors.get(spec.name) ?? []).map((name) => ({ id: id(name), hasRiver: false })),
    building: spec.building ?? null,
    resource: null,
  }));
  const owned = specs.filter((spec) => spec.owner === NATION_A);
  const macroRegions: MacroRegion[] = owned.map((spec, index) => ({
    id: createMacroRegionId(index),
    nationId: NATION_A,
    mesoRegionIds: [id(spec.name)],
    isCore: true,
  }));
  const nation = createNation(NATION_A, id("capital"), macroRegions.map((macro) => macro.id));
  const world: WorldState = {
    width: 100,
    height: 100,
    microRegions: [],
    microRegionEdges: [],
    mesoRegions,
    macroRegions,
    nations: [nation],
    wars: [],
    battles: [],
    occupation: createOccupationState(),
    landFronts: createLandFrontState(),
    frontPlans: createNationFrontPlanState(),
    frontAllocations: createNationFrontAllocationState(),
    frontlineCoverage: createFrontlineCoverageState(),
    offensiveOperations: createOffensiveOperationState(),
    retreatPlans: createRetreatPlanState(),
    capitalDefense: createCapitalDefenseState(),
    strategicReserves: createStrategicReserveState(),
    reorganization: createReorganizationState(),
    strategicProgress: createStrategicProgressState(),
    strategicThreatObservation: createStrategicThreatObservationState(),
    warIntent: createWarIntentState(),
    commonThreatCoalitions: createCommonThreatCoalitionState(),
    battlefieldTopology: createBattlefieldTopologyState(),
    supplyAssessment: createSupplyAssessmentState(),
    isolationEffects: createIsolationEffectsState(),
    productionDiagnostics: createProductionDiagnosticsState(),
    supplyCutoffs: createSupplyCutoffAnalysisState(),
    supplyDefense: createSupplyDefenseState(),
    supplyRelief: createSupplyReliefState(),
    amphibiousOperations: createAmphibiousOperationState(),
    stalematePressure: createStalematePressureState(),
    collapseAdvances: createCollapseAdvanceState(),
    mapVersion: 0,
    territoryVersion: 0,
    buildingVersion: 0,
    units: [],
    unitIdCounter: 0,
    simRng: new SeededRng(12345),
    cache: createWorldCache(),
    time: createSimTime(),
  };
  if (withPorts) {
    const spawnPorts = [id("port-a"), id("port-c")];
    for (let index = 0; index < transportCount; index += 1) {
      world.units.push(createUnitForType(
        createUnitId(world.unitIdCounter++),
        NATION_A,
        spawnPorts[index % spawnPorts.length],
        "TransportShip",
      ));
    }
  }
  return world;
}

function createNation(
  nationId: NationId,
  capitalMesoId: MesoRegionId,
  macroRegionIds: MacroRegion["id"][],
): NationRuntime {
  return {
    id: nationId,
    capitalMesoId,
    macroRegionIds,
    unitRoles: { defenseUnitIds: [], occupationUnitIds: [] },
    capitalFallCount: 0,
    surrenderScore: 0,
    initialUnitCount: 0,
    initialCityCount: 0,
    warCooperation: 1,
    warCooperationBoost: 0,
    nextUnitProductionTick: Number.POSITIVE_INFINITY,
    nextWarDeclarationTick: Number.POSITIVE_INFINITY,
    resources: createNationResources(),
    resourceFlow: createNationResourceFlow(),
  };
}

function disconnect(world: WorldState, a: string, b: string): void {
  const regionA = world.mesoRegions.find((region) => region.id === id(a));
  const regionB = world.mesoRegions.find((region) => region.id === id(b));
  assert(regionA && regionB);
  regionA.neighbors = regionA.neighbors.filter((neighbor) => neighbor.id !== id(b));
  regionB.neighbors = regionB.neighbors.filter((neighbor) => neighbor.id !== id(a));
  world.cache.mesoById.clear();
  world.cache.neighborsById.clear();
}

function connect(world: WorldState, a: string, b: string): void {
  const regionA = world.mesoRegions.find((region) => region.id === id(a));
  const regionB = world.mesoRegions.find((region) => region.id === id(b));
  assert(regionA && regionB);
  if (!regionA.neighbors.some((neighbor) => neighbor.id === regionB.id)) {
    regionA.neighbors.push({ id: regionB.id, hasRiver: false });
  }
  if (!regionB.neighbors.some((neighbor) => neighbor.id === regionA.id)) {
    regionB.neighbors.push({ id: regionA.id, hasRiver: false });
  }
  world.cache.mesoById.clear();
  world.cache.neighborsById.clear();
}

function id(name: string): MesoRegionId {
  return name as MesoRegionId;
}
