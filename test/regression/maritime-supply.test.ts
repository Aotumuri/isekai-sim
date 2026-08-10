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
import { createReorganizationState } from "../../src/sim/reorganization";
import { createRetreatPlanState } from "../../src/sim/retreat-plans";
import { createStalematePressureState } from "../../src/sim/stalemate-pressure";
import { createStrategicProgressState } from "../../src/sim/strategic-progress";
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
import { createSimTime } from "../../src/sim/time";
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
import { declareWar } from "../../src/sim/war-state";

const NATION_A = "nation-a" as NationId;
const NATION_B = "nation-b" as NationId;

test("land supply remains capital-component based without ports", () => {
  const world = createMaritimeWorld(false);
  updateSupplyAssessment(world);
  assert.equal(isNationRegionSupplied(world, NATION_A, id("capital")), true);
  assert.equal(isNationRegionSupplied(world, NATION_A, id("land")), true);
  assert.equal(world.supplyAssessment.maritimeLinks.length, 0);
});

test("disabled naval gameplay supplies a remote island without ships", () => {
  const world = createMaritimeWorld();
  assert.equal(world.units.length, 0);
  updateSupplyAssessment(world);
  assert.equal(isNationRegionSupplied(world, NATION_A, id("island-b")), true);
  assert(world.supplyAssessment.maritimeLinks.some((link) =>
    link.sourcePortId === id("port-a") &&
    link.destinationPortId === id("port-b") &&
    link.active &&
    link.transportSupport.includes("abstract-shipping")
  ));
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

test("a second active maritime entry prevents a false port cutoff prediction", () => {
  const world = createMaritimeCutoffWorld(true);
  updateSupplyAssessment(world);
  assert(world.supplyAssessment.maritimeLinks.some((link) =>
    link.active && link.destinationPortId === id("port-b")
  ));
  assert(world.supplyAssessment.maritimeLinks.some((link) =>
    link.active && link.destinationPortId === id("port-c")
  ));
  updateLandFronts(world);
  updateBattlefieldTopology(world);
  updateSupplyCutoffAnalysis(world);
  assert(!world.supplyCutoffs.candidates.some((item) =>
    item.attackerNationId === NATION_B && item.targetRegionId === id("port-b")
  ));
  updateSupplyDefense(world);
  assert(!world.supplyDefense.risks.some((item) => item.regionId === id("port-b")));
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

function createMaritimeWorld(withPorts = true): WorldState {
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
  return {
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
    supplyCutoffs: createSupplyCutoffAnalysisState(),
    supplyDefense: createSupplyDefenseState(),
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

function id(name: string): MesoRegionId {
  return name as MesoRegionId;
}
