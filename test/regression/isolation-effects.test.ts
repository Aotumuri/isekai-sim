import assert from "node:assert/strict";
import test from "node:test";
import { WORLD_BALANCE } from "../../src/data/balance";
import { SeededRng } from "../../src/utils/seeded-rng";
import { createMacroRegionId, type MacroRegion } from "../../src/worldgen/macro-region";
import type { MesoRegion, MesoRegionId } from "../../src/worldgen/meso-region";
import type { MicroRegionId } from "../../src/worldgen/micro-region";
import type { NationId } from "../../src/worldgen/nation";
import { createBattlefieldTopologyState } from "../../src/sim/battlefield-topology";
import { createCapitalDefenseState } from "../../src/sim/capital-defense";
import { createCollapseAdvanceState } from "../../src/sim/collapse-advance";
import { createUnitForType } from "../../src/sim/create-units";
import { createFrontlineCoverageState } from "../../src/sim/frontline-coverage";
import {
  createIsolationEffectsState,
  getUnitIsolationEffect,
  updateIsolationEffects,
} from "../../src/sim/isolation-effects";
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
import { createReorganizationState } from "../../src/sim/reorganization";
import { createRetreatPlanState } from "../../src/sim/retreat-plans";
import { createStalematePressureState } from "../../src/sim/stalemate-pressure";
import { createStrategicProgressState } from "../../src/sim/strategic-progress";
import { createStrategicThreatObservationState } from "../../src/sim/strategic-threat-observation";
import { createStrategicReserveState } from "../../src/sim/strategic-reserves";
import {
  createSupplyAssessmentState,
  updateSupplyAssessment,
} from "../../src/sim/supply-assessment";
import { createSimTime } from "../../src/sim/time";
import { createUnitId, type UnitState } from "../../src/sim/unit";
import type { WorldState } from "../../src/sim/world-state";
import { createWorldCache } from "../../src/sim/world-cache";
import { createProductionDiagnosticsState } from "../../src/sim/production";
import { createSupplyCutoffAnalysisState } from "../../src/sim/supply-cutoff";
import { createSupplyDefenseState } from "../../src/sim/supply-defense";
import { createSupplyReliefState } from "../../src/sim/supply-relief";
import { createAmphibiousOperationState } from "../../src/sim/amphibious";

const NATION = "nation-a" as NationId;

test("fresh isolation has a 100-fast-tick grace period before slow-tick decay", () => {
  const { world, unit } = createIsolationWorld();
  const initialOrganization = unit.org;

  evaluateAt(world, 0);
  evaluateAt(world, WORLD_BALANCE.war.landFront.isolation.graceTicks);
  assert.equal(unit.org, initialOrganization);
  assert.equal(getUnitIsolationEffect(world, unit).stage, "isolated");

  evaluateAt(world, WORLD_BALANCE.war.landFront.isolation.graceTicks + 1);
  assert.equal(
    unit.org,
    initialOrganization -
      WORLD_BALANCE.war.landFront.isolation.organizationDecayPerSlowTick,
  );
  assert.equal(getUnitIsolationEffect(world, unit).stage, "strained");
});

test("reconnection before grace prevents decay and reconnection after strain stops it", () => {
  const beforeGrace = createIsolationWorld();
  evaluateAt(beforeGrace.world, 50);
  connectIsland(beforeGrace.world);
  evaluateAt(beforeGrace.world, 60);
  assert.equal(beforeGrace.unit.org, 0.75);
  assert.equal(getUnitIsolationEffect(beforeGrace.world, beforeGrace.unit).stage, "supplied");

  const afterStrain = createIsolationWorld();
  evaluateAt(afterStrain.world, 101);
  const decayedOrganization = afterStrain.unit.org;
  connectIsland(afterStrain.world);
  evaluateAt(afterStrain.world, 110);
  assert.equal(afterStrain.unit.org, decayedOrganization);
  assert.equal(afterStrain.world.isolationEffects.reconnections, 1);
  assert.equal(afterStrain.world.isolationEffects.decayStoppedByReconnection, 1);
});

test("a no-combat high-organization unit gradually loses readiness", () => {
  const { world, unit } = createIsolationWorld();
  unit.org = 0.85;
  evaluateAt(world, 101);
  for (let tick = 111; tick <= 311; tick += 10) evaluateAt(world, tick);

  assert(unit.org < WORLD_BALANCE.war.landFront.reorganization.readyOrganizationRatio);
  assert.equal(world.isolationEffects.organizationDecayApplications, 22);
  assert.equal(world.battles.length, 0);
});

test("a fresh unit entering an old isolated component uses component age", () => {
  const { world } = createIsolationWorld(false);
  evaluateAt(world, 500);
  const unit = addUnit(world, "island");
  const initialOrganization = unit.org;

  updateIsolationEffects(world);

  assert.equal(getUnitIsolationEffect(world, unit).age, 500);
  assert.equal(getUnitIsolationEffect(world, unit).stage, "strained");
  assert.equal(
    unit.org,
    initialOrganization -
      WORLD_BALANCE.war.landFront.isolation.organizationDecayPerSlowTick,
  );
});

test("passive isolation decay stops at the configured organization floor", () => {
  const { world, unit } = createIsolationWorld();
  unit.org = WORLD_BALANCE.war.landFront.isolation.organizationFloor + 0.001;
  evaluateAt(world, 101);
  evaluateAt(world, 111);

  assert.equal(unit.org, WORLD_BALANCE.war.landFront.isolation.organizationFloor);
  assert.equal(world.isolationEffects.unitsHittingFloor, 1);
});

function createIsolationWorld(withUnit = true): { world: WorldState; unit: UnitState } {
  const mesoRegions: MesoRegion[] = ["capital", "island"].map((name, index) => ({
    id: id(name),
    type: "land",
    centerId: `micro-${index}` as MicroRegionId,
    center: { x: index * 10, y: 0 },
    microRegionIds: [],
    neighbors: [],
    building: name === "capital" ? "capital" : null,
    resource: null,
  }));
  const macroRegions: MacroRegion[] = mesoRegions.map((region, index) => ({
    id: createMacroRegionId(index),
    nationId: NATION,
    mesoRegionIds: [region.id],
    isCore: true,
  }));
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
    nextUnitProductionTick: Number.POSITIVE_INFINITY,
    nextWarDeclarationTick: Number.POSITIVE_INFINITY,
    resources: createNationResources(),
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
    strategicThreatObservation: createStrategicThreatObservationState(),
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
  const unit = withUnit ? addUnit(world, "island") : addUnitPlaceholder();
  updateSupplyAssessment(world);
  return { world, unit };
}

function addUnit(world: WorldState, regionName: string): UnitState {
  const unit = createUnitForType(
    createUnitId(world.unitIdCounter++),
    NATION,
    id(regionName),
    "Infantry",
  );
  world.units.push(unit);
  return unit;
}

function addUnitPlaceholder(): UnitState {
  return createUnitForType(createUnitId(-1), NATION, id("island"), "Infantry");
}

function evaluateAt(world: WorldState, fastTick: number): void {
  world.time.fastTick = fastTick;
  updateSupplyAssessment(world);
  updateIsolationEffects(world);
}

function connectIsland(world: WorldState): void {
  const capital = world.mesoRegions.find((region) => region.id === id("capital"));
  const island = world.mesoRegions.find((region) => region.id === id("island"));
  assert(capital && island);
  capital.neighbors = [{ id: island.id, hasRiver: false }];
  island.neighbors = [{ id: capital.id, hasRiver: false }];
  world.territoryVersion += 1;
  world.mapVersion += 1;
  world.cache.neighborsById.clear();
}

function id(name: string): MesoRegionId {
  return name as MesoRegionId;
}
