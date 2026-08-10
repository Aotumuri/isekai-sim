import assert from "node:assert/strict";
import test from "node:test";
import { SeededRng } from "../../src/utils/seeded-rng";
import { createMacroRegionId, type MacroRegion } from "../../src/worldgen/macro-region";
import type { MesoRegion, MesoRegionId } from "../../src/worldgen/meso-region";
import type { MicroRegionId } from "../../src/worldgen/micro-region";
import type { NationId } from "../../src/worldgen/nation";
import { createBattlefieldTopologyState } from "../../src/sim/battlefield-topology";
import { createCapitalDefenseState } from "../../src/sim/capital-defense";
import { createCollapseAdvanceState } from "../../src/sim/collapse-advance";
import { createFrontlineCoverageState } from "../../src/sim/frontline-coverage";
import { createIsolationEffectsState } from "../../src/sim/isolation-effects";
import { createLandFrontState } from "../../src/sim/land-fronts";
import { createNationFrontAllocationState } from "../../src/sim/nation-front-allocations";
import { createNationFrontPlanState } from "../../src/sim/nation-front-plans";
import {
  createNationResourceFlow,
  createNationResources,
  type NationRuntime,
} from "../../src/sim/nation-runtime";
import { createOccupationState } from "../../src/sim/occupation";
import { createOffensiveOperationState } from "../../src/sim/offensive-operations";
import {
  createProductionDiagnosticsState,
  updateProduction,
} from "../../src/sim/production";
import { createReorganizationState } from "../../src/sim/reorganization";
import { createRetreatPlanState } from "../../src/sim/retreat-plans";
import { createStalematePressureState } from "../../src/sim/stalemate-pressure";
import { createStrategicProgressState } from "../../src/sim/strategic-progress";
import { createStrategicReserveState } from "../../src/sim/strategic-reserves";
import {
  createSupplyAssessmentState,
  updateSupplyAssessment,
} from "../../src/sim/supply-assessment";
import { createSimTime } from "../../src/sim/time";
import type { WorldState } from "../../src/sim/world-state";
import { createWorldCache } from "../../src/sim/world-cache";

const NATION = "nation-a" as NationId;

test("a supplied city produces normally", () => {
  const world = createProductionWorld({ cityA: true, connectedA: true });

  runProductionEvaluation(world);

  assert.equal(unitsAt(world, "city-a"), 1);
  assert.equal(world.productionDiagnostics.successfulProductions, 1);
  assert.equal(world.productionDiagnostics.supplyLookups, 1);
});

test("an isolated city produces nothing", () => {
  const world = createProductionWorld({ cityA: true });

  runProductionEvaluation(world);

  assert.equal(world.units.length, 0);
  assert.equal(world.productionDiagnostics.blockedByIsolation, 1);
  assert.equal(world.productionDiagnostics.blockedByComponentId.size, 1);
});

test("an isolated capital receives no production exception", () => {
  const world = createProductionWorld({ macroCount: 5 });
  updateSupplyAssessment(world);
  const componentId = world.supplyAssessment.assessmentByNationId
    .get(NATION)?.componentIdByRegionId.get(id("capital"));
  assert(componentId);
  const component = world.supplyAssessment.componentById.get(componentId);
  assert(component);
  component.supplied = false;
  component.isolated = true;

  updateProduction(world);

  assert.equal(world.units.length, 0);
  assert.equal(world.productionDiagnostics.attemptedProductions, 1);
  assert.equal(world.productionDiagnostics.blockedByIsolation, 1);
});

test("production resumes automatically after reconnection", () => {
  const world = createProductionWorld({ cityA: true });
  runProductionEvaluation(world);
  assert.equal(world.units.length, 0);

  setConnection(world, "city-a", true);
  runProductionEvaluation(world);

  assert.equal(unitsAt(world, "city-a"), 1);
  assert.equal(world.productionDiagnostics.blockedByIsolation, 1);
  assert.equal(world.productionDiagnostics.successfulProductions, 1);
});

test("with multiple cities only supplied locations produce", () => {
  const world = createProductionWorld({
    cityA: true,
    cityB: true,
    connectedA: true,
  });

  runProductionEvaluation(world);

  assert.equal(unitsAt(world, "city-a"), 1);
  assert.equal(unitsAt(world, "city-b"), 0);
  assert.equal(world.productionDiagnostics.attemptedProductions, 2);
  assert.equal(world.productionDiagnostics.blockedByIsolation, 1);
});

test("supply oscillation produces a deterministic sequence", () => {
  const first = createProductionWorld({ cityA: true });
  const second = createProductionWorld({ cityA: true });
  const sequence = [false, true, false, true];

  for (const connected of sequence) {
    setConnection(first, "city-a", connected);
    setConnection(second, "city-a", connected);
    runProductionEvaluation(first);
    runProductionEvaluation(second);
  }

  const summarize = (world: WorldState) => ({
    units: world.units.map((unit) => [unit.id, unit.regionId, unit.type]),
    attempted: world.productionDiagnostics.attemptedProductions,
    blocked: world.productionDiagnostics.blockedByIsolation,
    successful: world.productionDiagnostics.successfulProductions,
    nextTick: world.nations[0]?.nextUnitProductionTick,
  });
  assert.deepEqual(summarize(first), summarize(second));
  assert.equal(first.units.length, 2);
});

test("resource failure diagnostics distinguish manpower and economy", () => {
  const noManpower = createProductionWorld({ cityA: true, connectedA: true });
  noManpower.nations[0]!.resources = createNationResources();
  runProductionEvaluation(noManpower);
  assert.equal(noManpower.productionDiagnostics.blockedByNoManpower, 1);

  const noWeapons = createProductionWorld({ cityA: true, connectedA: true });
  noWeapons.nations[0]!.resources.manpower = 10_000;
  noWeapons.nations[0]!.resources.weapons = 0;
  noWeapons.nations[0]!.resources.steel = 0;
  runProductionEvaluation(noWeapons);
  assert.equal(noWeapons.productionDiagnostics.blockedByEconomy, 1);
});

interface ProductionWorldOptions {
  cityA?: boolean;
  cityB?: boolean;
  connectedA?: boolean;
  connectedB?: boolean;
  macroCount?: number;
}

function createProductionWorld(options: ProductionWorldOptions): WorldState {
  const names = ["capital", "city-a", "city-b"];
  const mesoRegions: MesoRegion[] = names.map((name, index) => ({
    id: id(name),
    type: "land",
    centerId: `micro-${index}` as MicroRegionId,
    center: { x: index * 10, y: 0 },
    microRegionIds: [],
    neighbors: [],
    building: name === "capital"
      ? "capital"
      : name === "city-a" && options.cityA
        ? "city"
        : name === "city-b" && options.cityB ? "city" : null,
    resource: null,
  }));
  const macroCount = options.macroCount ?? 1;
  const macroRegions: MacroRegion[] = [];
  for (let index = 0; index < macroCount; index += 1) {
    macroRegions.push({
      id: createMacroRegionId(index),
      nationId: NATION,
      mesoRegionIds: index === 0
        ? mesoRegions.map((region) => region.id)
        : [id("capital")],
      isCore: true,
    });
  }
  const nation: NationRuntime = {
    id: NATION,
    capitalMesoId: id("capital"),
    macroRegionIds: macroRegions.map((macro) => macro.id),
    unitRoles: { defenseUnitIds: [], occupationUnitIds: [] },
    capitalFallCount: 0,
    surrenderScore: 0,
    initialUnitCount: 0,
    initialCityCount: 0,
    warCooperation: 1,
    warCooperationBoost: 0,
    nextUnitProductionTick: 0,
    nextWarDeclarationTick: Number.POSITIVE_INFINITY,
    resources: { steel: 100, fuel: 100, manpower: 100_000, weapons: 1_000 },
    resourceFlow: createNationResourceFlow(),
  };
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
    battlefieldTopology: createBattlefieldTopologyState(),
    supplyAssessment: createSupplyAssessmentState(),
    isolationEffects: createIsolationEffectsState(),
    productionDiagnostics: createProductionDiagnosticsState(),
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
  if (options.connectedA) setConnection(world, "city-a", true);
  if (options.connectedB) setConnection(world, "city-b", true);
  return world;
}

function runProductionEvaluation(world: WorldState): void {
  world.nations[0]!.nextUnitProductionTick = world.time.slowTick;
  updateSupplyAssessment(world);
  updateProduction(world);
  world.time.slowTick += 1;
  world.time.fastTick += 10;
}

function setConnection(
  world: WorldState,
  regionName: "city-a" | "city-b",
  connected: boolean,
): void {
  const capital = world.mesoRegions.find((region) => region.id === id("capital"));
  const region = world.mesoRegions.find((candidate) => candidate.id === id(regionName));
  assert(capital && region);
  capital.neighbors = capital.neighbors.filter((neighbor) => neighbor.id !== region.id);
  region.neighbors = region.neighbors.filter((neighbor) => neighbor.id !== capital.id);
  if (connected) {
    capital.neighbors.push({ id: region.id, hasRiver: false });
    region.neighbors.push({ id: capital.id, hasRiver: false });
  }
  world.territoryVersion += 1;
  world.mapVersion += 1;
  world.cache.neighborsById.clear();
}

function unitsAt(world: WorldState, regionName: string): number {
  return world.units.filter((unit) => unit.regionId === id(regionName)).length;
}

function id(name: string): MesoRegionId {
  return name as MesoRegionId;
}
