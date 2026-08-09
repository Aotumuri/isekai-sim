import assert from "node:assert/strict";
import test from "node:test";
import { WORLD_BALANCE } from "../../src/data/balance";
import type { MicroRegionId } from "../../src/worldgen/micro-region";
import type { MesoRegion, MesoRegionId } from "../../src/worldgen/meso-region";
import { createMacroRegionId, type MacroRegion } from "../../src/worldgen/macro-region";
import { createNationId, type NationId } from "../../src/worldgen/nation";
import { SeededRng } from "../../src/utils/seeded-rng";
import { createUnitForType } from "../../src/sim/create-units";
import {
  createCapitalDefenseState,
  getCapitalDefenseAssessment,
  updateCapitalDefense,
} from "../../src/sim/capital-defense";
import {
  createLandFrontState,
  getFrontSide,
  getPhysicalFrontsForNation,
  updateLandFronts,
} from "../../src/sim/land-fronts";
import {
  createNationFrontPlanState,
  formatNationFrontPlanSummary,
  getFrontPlan,
  getNationFrontPlans,
  updateNationFrontPlans,
} from "../../src/sim/nation-front-plans";
import {
  createNationFrontAllocationState,
  formatNationFrontAllocationSummary,
  getFrontAllocation,
  getAllocatedFrontId,
  getNationFrontAllocations,
  updateNationFrontAllocations,
} from "../../src/sim/nation-front-allocations";
import { repositionUnits } from "../../src/sim/nation/reposition-units";
import {
  createOffensiveOperationState,
  cancelOffensiveOperationsForCapitalEmergency,
  formatOffensiveOperationSummary,
  getOffensiveOperationForFront,
  getOffensiveOperationForUnit,
  getOffensiveOperations,
  getOperationCandidateForFront,
  updateOffensiveOperations,
  type OffensiveOperation,
} from "../../src/sim/offensive-operations";
import { createCollapseAdvanceState, updateCollapseAdvances } from "../../src/sim/collapse-advance";
import {
  createRetreatPlanState,
  formatRetreatPlanSummary,
  getRetreatPlanForUnit,
  getRetreatPlans,
  updateRetreatPlans,
  type RetreatPlan,
} from "../../src/sim/retreat-plans";
import {
  createNationResourceFlow,
  createNationResources,
  type NationRuntime,
} from "../../src/sim/nation-runtime";
import { createOccupationState } from "../../src/sim/occupation";
import { createSimTime } from "../../src/sim/time";
import { createUnitId, type LandUnitType, type UnitType } from "../../src/sim/unit";
import { getUnitCombatStrength } from "../../src/sim/unit-strength";
import { declareWar } from "../../src/sim/war-state";
import { createWorldCache } from "../../src/sim/world-cache";
import type { WorldState } from "../../src/sim/world-state";
import {
  createStrategicReserveState,
  formatStrategicReserveSummary,
  getNationReserveState,
  getReserveTargetForUnit,
  updateStrategicReserves,
} from "../../src/sim/strategic-reserves";
import { createReorganizationState } from "../../src/sim/reorganization";
import {
  createStrategicProgressState,
  getStrategicProgressAssessment,
  updateStrategicProgress,
} from "../../src/sim/strategic-progress";
import { updateBattles } from "../../src/sim/battles";
import {
  createFrontlineCoverageState,
  getFrontlineCoverage,
  updateFrontlineCoverage,
} from "../../src/sim/frontline-coverage";
import {
  createStalematePressureState,
  getNationSchwerpunkt,
  getSchwerpunktForEnemy,
  getStalemateAssessment,
  updateStalematePressure,
} from "../../src/sim/stalemate-pressure";
import { BenchmarkMetrics } from "../benchmark/metrics";
import { beginAiGeographyEvaluation } from "../../src/sim/ai-geography";
import { createTestScenario } from "../helpers/test-scenario";

const NATION_A = createNationId(0);
const NATION_B = createNationId(1);
const NATION_C = createNationId(2);
const ALL_NATIONS = [NATION_A, NATION_B, NATION_C];

interface RegionSpec {
  id: string;
  owner: NationId;
  occupier?: NationId;
  building?: MesoRegion["building"];
}

type Edge = [string, string];

test("a continuous border between the same enemies creates one front", () => {
  const world = createFrontWorld(
    [
      { id: "a1", owner: NATION_A },
      { id: "a2", owner: NATION_A },
      { id: "b1", owner: NATION_B },
      { id: "b2", owner: NATION_B },
    ],
    [
      ["a1", "a2"],
      ["b1", "b2"],
      ["a1", "b1"],
      ["a2", "b2"],
    ],
  );
  startWar(world, NATION_A, NATION_B);

  updateLandFronts(world);

  const fronts = frontsBetween(world, NATION_A, NATION_B);
  assert.equal(fronts.length, 1);
  assert.deepEqual(getFrontSide(fronts[0], NATION_A)?.borderRegionIds, ids("a1", "a2"));
  assert.deepEqual(getFrontSide(fronts[0], NATION_B)?.borderRegionIds, ids("b1", "b2"));
  assert.equal(fronts[0].borderLength, 2);
  assert.equal(fronts[0].borderEdges.length, 2);
});

test("a static balanced war accumulates pressure and selects one Schwerpunkt", () => {
  const world = createBalancedStalemateWorld();
  for (let tick = 0; tick < 20; tick += 1) {
    world.time.fastTick += 10;
    updateStalematePressure(world);
  }
  const assessment = getStalemateAssessment(world, NATION_A, NATION_B);
  assert(assessment);
  assert(assessment.pressure >= WORLD_BALANCE.war.landFront.stalemate.selectionThreshold);
  assert(assessment.reasonFlags.includes("balanced-strength"));
  assert(assessment.reasonFlags.includes("no-strategic-progress"));
  assert(assessment.schwerpunktSectorId);
  assert.equal(getNationSchwerpunkt(world, NATION_A)?.schwerpunktSectorId, assessment.schwerpunktSectorId);
  assert.equal([...world.stalematePressure.schwerpunktByNationId.keys()].filter((id) => id === NATION_A).length, 1);
});

test("a single occupation change does not reset strategic pressure", () => {
  const world = createBalancedStalemateWorld();
  updateStrategicProgress(world);
  for (let tick = 0; tick < 12; tick += 1) updateStalematePressure(world);
  const before = getStalemateAssessment(world, NATION_A, NATION_B)?.pressure ?? 0;
  world.occupation.mesoById.set(id("b-front"), NATION_A);
  world.occupation.version += 1;
  updateStrategicProgress(world);
  assert.equal(
    getStrategicProgressAssessment(world, NATION_A, NATION_B)?.resetsPressure,
    false,
  );
  updateStalematePressure(world);
  assert((getStalemateAssessment(world, NATION_A, NATION_B)?.pressure ?? 0) > before);
});

test("frontline oscillation does not produce Strategic Progress", () => {
  const world = createBalancedStalemateWorld();
  updateStrategicProgress(world);
  for (let cycle = 0; cycle < 4; cycle += 1) {
    world.occupation.mesoById.set(id("b-front"), NATION_A);
    world.occupation.version += 1;
    updateStrategicProgress(world);
    world.occupation.mesoById.delete(id("b-front"));
    world.occupation.version += 1;
    updateStrategicProgress(world);
  }
  assert.equal(world.strategicProgress.progressEventCount, 0);
  assert.equal(
    getStrategicProgressAssessment(world, NATION_A, NATION_B)?.lastProgressTick,
    null,
  );
});

test("a sustained multi-region advance resets strategic pressure after accumulated evidence", () => {
  const world = createBalancedStalemateWorld();
  updateStrategicProgress(world);
  for (let tick = 0; tick < 12; tick += 1) updateStalematePressure(world);
  const before = getStalemateAssessment(world, NATION_A, NATION_B)?.pressure ?? 0;
  world.occupation.mesoById.set(id("b-front"), NATION_A);
  world.occupation.mesoById.set(id("b-rear"), NATION_A);
  world.occupation.version += 1;
  for (let evaluation = 0; evaluation < 3; evaluation += 1) {
    world.time.fastTick += 10;
    updateStrategicProgress(world);
  }
  const progress = getStrategicProgressAssessment(world, NATION_A, NATION_B);
  assert(progress?.resetsPressure);
  assert(progress.reasonFlags.includes("net-territorial-gain"));
  updateStalematePressure(world);
  assert((getStalemateAssessment(world, NATION_A, NATION_B)?.pressure ?? 0) < before);
});

test("capturing an important city is immediately meaningful Strategic Progress", () => {
  const world = createBalancedStalemateWorld();
  const city = world.mesoRegions.find((region) => region.id === id("b-front"));
  assert(city);
  city.building = "city";
  world.buildingVersion += 1;
  updateStrategicProgress(world);
  world.occupation.mesoById.set(city.id, NATION_A);
  world.occupation.version += 1;
  updateStrategicProgress(world);
  const progress = getStrategicProgressAssessment(world, NATION_A, NATION_B);
  assert(progress?.resetsPressure);
  assert(progress.reasonFlags.includes("important-capture"));
});

test("one nation may retain exactly one Schwerpunkt per enemy", () => {
  const world = createFrontWorld(
    [
      { id: "a-b", owner: NATION_A }, { id: "b-a", owner: NATION_B },
      { id: "a-c", owner: NATION_A }, { id: "c-a", owner: NATION_C },
    ],
    [["a-b", "b-a"], ["a-c", "c-a"]],
  );
  startWar(world, NATION_A, NATION_B);
  startWar(world, NATION_A, NATION_C);
  for (const [nationId, regionId] of [
    [NATION_A, "a-b"], [NATION_B, "b-a"],
    [NATION_A, "a-c"], [NATION_C, "c-a"],
  ] as const) {
    for (let index = 0; index < 4; index += 1) {
      setUnitStrength(addLandUnit(world, nationId, regionId, "Infantry"), 1_000);
    }
  }
  updateAllocationSystem(world);
  updateFrontlineCoverage(world);
  for (let tick = 0; tick < 20; tick += 1) {
    world.time.fastTick += 10;
    updateStalematePressure(world);
  }
  assert(getSchwerpunktForEnemy(world, NATION_A, NATION_B)?.schwerpunktSectorId);
  assert(getSchwerpunktForEnemy(world, NATION_A, NATION_C)?.schwerpunktSectorId);
  assert.equal(
    world.stalematePressure.assessments.filter((assessment) =>
      assessment.nationId === NATION_A && assessment.schwerpunktSectorId
    ).length,
    2,
  );
});

test("Schwerpunkt concentration preserves defense and exposes a larger offensive surplus", () => {
  const world = createBalancedStalemateWorld();
  for (let tick = 0; tick < 20; tick += 1) updateStalematePressure(world);
  updateNationFrontAllocations(world);
  updateFrontlineCoverage(world);
  const focus = getNationSchwerpunkt(world, NATION_A);
  assert(focus?.schwerpunktSectorId);
  const allocation = getFrontAllocation(world, focus.schwerpunktSectorId, NATION_A);
  const coverage = getFrontlineCoverage(world, focus.schwerpunktSectorId, NATION_A);
  assert(allocation && coverage);
  assert(coverage.minimumRequiredStrength > 0);
  assert(coverage.defenderStrength > 0);
  assert(coverage.offensiveSurplusStrength > 0);
  assert(allocation.allocatedStrength >= coverage.minimumRequiredStrength);
});

test("frontline coverage creates topology-ordered positions and spreads defenders", () => {
  const specs: RegionSpec[] = [];
  const edges: Edge[] = [];
  for (let index = 0; index < 6; index += 1) {
    specs.push({ id: `la${index}`, owner: NATION_A }, { id: `lb${index}`, owner: NATION_B });
    edges.push([`la${index}`, `lb${index}`]);
    if (index > 0) edges.push([`la${index - 1}`, `la${index}`], [`lb${index - 1}`, `lb${index}`]);
  }
  const world = createFrontWorld(specs, edges);
  startWar(world, NATION_A, NATION_B);
  for (const region of ["la0", "la2", "la5"]) addLandUnit(world, NATION_A, region, "Infantry");
  for (const region of ["lb0", "lb3", "lb5"]) addLandUnit(world, NATION_B, region, "Infantry");
  updateAllocationSystem(world);
  const plan = world.frontPlans.plans.find((candidate) => candidate.nationId === NATION_A);
  assert(plan);
  plan.posture = "hold";
  const allocation = getFrontAllocation(world, plan.frontId, NATION_A);
  assert(allocation);
  allocation.posture = "hold";
  updateFrontlineCoverage(world);
  const coverage = getFrontlineCoverage(world, plan.frontId, NATION_A);
  assert(coverage);
  assert.equal(coverage.positions.length, 6);
  assert.equal(coverage.defenderCount, 3);
  const assignedIndices = coverage.positions.filter((position) => position.defenderUnitIds.length > 0).map((position) => position.segmentIndex);
  assert.deepEqual(assignedIndices, [0, 3, 5]);
  assert.equal(new Set(coverage.positions.flatMap((position) => position.defenderUnitIds)).size, 3);
  assert(coverage.maxGapLength <= 1, "adjacent defenders should provide sparse continuous coverage");

  const stableAssignments = new Map(world.frontlineCoverage.assignmentByUnitId);
  const stableAssignmentObjects = new Map(stableAssignments);
  world.frontAllocations.version += 1;
  updateFrontlineCoverage(world);
  assert.deepEqual(world.frontlineCoverage.assignmentByUnitId, stableAssignments);
  for (const [unitId, assignment] of world.frontlineCoverage.assignmentByUnitId) {
    assert.equal(assignment, stableAssignmentObjects.get(unitId));
  }

  for (const region of ["la1", "la3", "la4"]) addLandUnit(world, NATION_A, region, "Infantry");
  updateAllocationSystem(world);
  const nextPlan = world.frontPlans.plans.find((candidate) => candidate.nationId === NATION_A);
  assert(nextPlan);
  nextPlan.posture = "hold";
  const nextAllocation = getFrontAllocation(world, nextPlan.frontId, NATION_A);
  assert(nextAllocation);
  nextAllocation.posture = "hold";
  updateFrontlineCoverage(world);
  const fullCoverage = getFrontlineCoverage(world, nextPlan.frontId, NATION_A);
  assert(fullCoverage);
  assert(fullCoverage.positions.every((position) => position.defenderUnitIds.length > 0));
  assert.equal(fullCoverage.gapSegments, 0);
});

test("unchanged coverage and allocation inputs skip full rebuilds", () => {
  const world = createTestScenario("active-war");
  const metrics = new BenchmarkMetrics();
  world.instrumentation = metrics;
  updateLandFronts(world);
  updateCapitalDefense(world);
  updateNationFrontPlans(world);
  updateNationFrontAllocations(world);
  updateFrontlineCoverage(world);

  updateNationFrontAllocations(world);
  updateFrontlineCoverage(world);

  assert.equal(metrics.getCounter("landFront.allocationRebuilds"), 1);
  assert.equal(metrics.getCounter("landFront.allocationSkippedRebuilds"), 1);
  assert.equal(metrics.getCounter("frontlineCoverage.dirtyRebuilds"), 1);
  assert.equal(metrics.getCounter("frontlineCoverage.skippedRebuilds"), 1);
});

test("battle indexing is reused while membership and movement are unchanged", () => {
  const world = createTestScenario("active-war");
  const metrics = new BenchmarkMetrics();
  world.instrumentation = metrics;

  updateBattles(world);
  updateBattles(world);

  assert.equal(metrics.getCounter("battle.index.rebuilds"), 1);
  assert.equal(metrics.getCounter("battle.index.reuses"), 1);
});

test("offensive operations use only strength surplus to minimum frontline coverage", () => {
  const world = createOperationWorld();
  const plan = planFor(world, NATION_A);
  updateFrontlineCoverage(world);
  const coverage = getFrontlineCoverage(world, plan.frontId, NATION_A);
  assert(coverage);
  const defenderIds = new Set(coverage.positions.flatMap((position) => position.defenderUnitIds));
  assert(defenderIds.size > 0);
  updateOffensiveOperations(world);
  const operation = getOffensiveOperationForFront(world, plan.frontId, NATION_A);
  assert(operation);
  assert(operation.assignedUnitIds.every((unitId) => !defenderIds.has(unitId)));
  assert(operation.assignedStrength <= coverage.offensiveSurplusStrength);
});

test("an offensive operation targets a reachable gap in the enemy coverage", () => {
  const world = createGapExploitationWorld();
  const plan = planFor(world, NATION_A);
  updateFrontlineCoverage(world);
  const enemyCoverage = getFrontlineCoverage(world, plan.frontId, NATION_B);
  assert(enemyCoverage);
  const gapRegionIds = enemyCoverage.positions
    .filter((position) => position.state === "gap")
    .map((position) => position.friendlyRegionId);
  assert(gapRegionIds.length > 0);

  updateOffensiveOperations(world);

  const operation = onlyOperation(world, NATION_A);
  assert(gapRegionIds.includes(operation.primaryTargetRegionId));
  assert.equal(operation.targetCoverageState, "gap");
  assert(operation.targetTacticalScore > 0);
  assert(operation.reasonFlags.includes("enemy-frontline-gap"));
  assert(operation.reasonFlags.includes("local-strength-superiority"));
});

test("a weak target with local strength superiority beats an overmatched weak target", () => {
  const world = createGapExploitationWorld();
  const plan = planFor(world, NATION_A);
  updateFrontlineCoverage(world);
  const enemyCoverage = getFrontlineCoverage(world, plan.frontId, NATION_B);
  assert(enemyCoverage);
  for (const position of enemyCoverage.positions) {
    position.state = "covered";
    position.defenderStrength = 500;
  }
  const overmatched = enemyCoverage.positions.find(
    (position) => position.friendlyRegionId === id("b1"),
  );
  const exploitable = enemyCoverage.positions.find(
    (position) => position.friendlyRegionId === id("b3"),
  );
  assert(overmatched && exploitable);
  overmatched.state = "weak";
  overmatched.defenderStrength = 10_000;
  exploitable.state = "weak";
  exploitable.defenderStrength = 50;

  updateOffensiveOperations(world);

  const operation = onlyOperation(world, NATION_A);
  assert.equal(operation.primaryTargetRegionId, id("b3"));
  assert.equal(operation.targetCoverageState, "weak");
  assert.equal(operation.targetLocalDefenderStrength, 50);
  assert(operation.reasonFlags.includes("enemy-frontline-weak"));
  assert(operation.reasonFlags.includes("local-strength-superiority"));
});

test("coverage detects loss of meaningful strength and war end cleans ownership", () => {
  const world = createOperationWorld();
  const plan = planFor(world, NATION_A);
  updateFrontlineCoverage(world);
  const initial = getFrontlineCoverage(world, plan.frontId, NATION_A);
  assert(initial && initial.defenderCount > 0);
  for (const unit of world.units) {
    if (unit.nationId === NATION_A && unit.domain === "land") unit.manpower = 0;
  }
  world.frontAllocations.version += 1;
  updateFrontlineCoverage(world);
  const depleted = getFrontlineCoverage(world, plan.frontId, NATION_A);
  assert(depleted);
  assert(depleted.gapSegments > 0);

  world.wars = [];
  updateAllocationSystem(world);
  updateFrontlineCoverage(world);
  assert.equal(world.frontlineCoverage.coverages.length, 0);
  assert.equal(world.frontlineCoverage.assignmentByUnitId.size, 0);
});

test("a long physical front is partitioned into deterministic operational sectors", () => {
  const specs: RegionSpec[] = [];
  const edges: Edge[] = [];
  for (let index = 0; index < 16; index += 1) {
    specs.push(
      { id: `a${index}`, owner: NATION_A },
      { id: `b${index}`, owner: NATION_B },
    );
    edges.push([`a${index}`, `b${index}`]);
    if (index > 0) {
      edges.push(
        [`a${index - 1}`, `a${index}`],
        [`b${index - 1}`, `b${index}`],
      );
    }
  }
  const build = (): WorldState => {
    const world = createFrontWorld(specs, edges);
    startWar(world, NATION_A, NATION_B);
    updateLandFronts(world);
    return world;
  };
  const world = build();
  const repeated = build();
  const front = world.landFronts.physicalFronts[0];
  const sectors = world.landFronts.operationalSectors;

  assert.equal(world.landFronts.physicalFronts.length, 1);
  assert(sectors.length > 1);
  assert.equal(
    sectors.reduce((total, sector) => total + sector.borderLength, 0),
    front.borderLength,
  );
  assert(sectors.every((sector) => sector.physicalFrontId === front.id));
  assert(sectors.every((sector) => sector.frontline.borderEdges === sector.borderEdges));
  assert.deepEqual(
    sectors.map((sector) => sector.id),
    repeated.landFronts.operationalSectors.map((sector) => sector.id),
  );

  updateNationFrontPlans(world);
  assert.equal(world.frontPlans.plans.length, sectors.length * 2);
});

test("small border movement preserves overlapping operational sector IDs", () => {
  const specs: RegionSpec[] = [];
  const edges: Edge[] = [];
  for (let index = 0; index < 16; index += 1) {
    specs.push(
      { id: `a${index}`, owner: NATION_A },
      { id: `b${index}`, owner: NATION_B },
    );
    edges.push([`a${index}`, `b${index}`]);
    if (index > 0) {
      edges.push(
        [`a${index - 1}`, `a${index}`],
        [`b${index - 1}`, `b${index}`],
      );
    }
  }
  const world = createFrontWorld(specs, edges);
  startWar(world, NATION_A, NATION_B);
  updateLandFronts(world);
  const before = new Set(world.landFronts.operationalSectors.map((sector) => sector.id));

  setRegionOwner(world, "a0", NATION_B);
  world.territoryVersion += 1;
  updateLandFronts(world);

  const retained = world.landFronts.operationalSectors.filter((sector) => before.has(sector.id));
  assert(retained.length >= Math.max(1, before.size - 1));
});

test("two geographically separated contacts create two fronts", () => {
  const world = createFrontWorld(
    [
      { id: "a1", owner: NATION_A },
      { id: "b1", owner: NATION_B },
      { id: "a2", owner: NATION_A },
      { id: "b2", owner: NATION_B },
    ],
    [
      ["a1", "b1"],
      ["a2", "b2"],
    ],
  );
  startWar(world, NATION_A, NATION_B);

  updateLandFronts(world);

  assert.equal(frontsBetween(world, NATION_A, NATION_B).length, 2);
});

test("a peaceful border creates no front", () => {
  const world = createSimpleBorderWorld();

  updateLandFronts(world);

  assert.equal(world.landFronts.physicalFronts.length, 0);
});

test("starting a war creates a front on the next front update", () => {
  const world = createSimpleBorderWorld();
  updateLandFronts(world);
  assert.equal(world.landFronts.physicalFronts.length, 0);

  startWar(world, NATION_A, NATION_B);
  updateLandFronts(world);

  const fromA = frontsBetween(world, NATION_A, NATION_B);
  const fromB = frontsBetween(world, NATION_B, NATION_A);
  assert.equal(world.landFronts.physicalFronts.length, 1);
  assert.equal(fromA.length, 1);
  assert.equal(fromB.length, 1);
  assert.strictEqual(fromA[0], fromB[0]);
  assert.equal(fromA[0].id, fromB[0].id);
});

test("ending a war removes its fronts", () => {
  const world = createSimpleBorderWorld();
  startWar(world, NATION_A, NATION_B);
  updateLandFronts(world);
  assert.equal(world.landFronts.physicalFronts.length, 1);

  world.wars = [];
  updateLandFronts(world);

  assert.equal(world.landFronts.physicalFronts.length, 0);
});

test("territory changes can split one front into two", () => {
  const world = createThreeSegmentWorld(false);
  startWar(world, NATION_A, NATION_B);
  updateLandFronts(world);
  assert.equal(frontsBetween(world, NATION_A, NATION_B).length, 1);

  setRegionOwner(world, "a2", NATION_C);
  setRegionOwner(world, "b2", NATION_C);
  world.territoryVersion += 1;
  updateLandFronts(world);

  assert.equal(frontsBetween(world, NATION_A, NATION_B).length, 2);
});

test("territory changes can merge two fronts into one", () => {
  const world = createThreeSegmentWorld(true);
  startWar(world, NATION_A, NATION_B);
  updateLandFronts(world);
  assert.equal(frontsBetween(world, NATION_A, NATION_B).length, 2);

  setRegionOwner(world, "a2", NATION_A);
  setRegionOwner(world, "b2", NATION_B);
  world.territoryVersion += 1;
  updateLandFronts(world);

  assert.equal(frontsBetween(world, NATION_A, NATION_B).length, 1);
});

test("occupation changes the effective controller at a contact", () => {
  const world = createFrontWorld(
    [
      { id: "a1", owner: NATION_A },
      { id: "c1", owner: NATION_C, occupier: NATION_B },
      { id: "b-home", owner: NATION_B },
    ],
    [["a1", "c1"]],
  );
  startWar(world, NATION_A, NATION_B);

  updateLandFronts(world);
  const occupiedFront = frontsBetween(world, NATION_A, NATION_B);
  assert.equal(occupiedFront.length, 1);
  assert.deepEqual(getFrontSide(occupiedFront[0], NATION_B)?.borderRegionIds, ids("c1"));

  world.occupation.mesoById.delete(id("c1"));
  world.occupation.version += 1;
  updateLandFronts(world);

  assert.equal(frontsBetween(world, NATION_A, NATION_B).length, 0);
});

test("inactive nations do not receive or create fronts", () => {
  const world = createSimpleBorderWorld(new Set([NATION_B]));
  startWar(world, NATION_A, NATION_B);

  updateLandFronts(world);

  assert.equal(world.landFronts.physicalFronts.length, 0);
  assert.equal(getPhysicalFrontsForNation(world, NATION_B).length, 0);
});

test("front border lists contain unique valid region IDs", () => {
  const world = createThreeSegmentWorld(false);
  startWar(world, NATION_A, NATION_B);
  updateLandFronts(world);
  const validIds = new Set(world.mesoRegions.map((meso) => meso.id));

  for (const front of world.landFronts.physicalFronts) {
    const friendly = new Set(front.sideA.borderRegionIds);
    const enemy = new Set(front.sideB.borderRegionIds);
    assert.equal(friendly.size, front.sideA.borderRegionIds.length);
    assert.equal(enemy.size, front.sideB.borderRegionIds.length);
    for (const regionId of [...friendly, ...enemy]) {
      assert(validIds.has(regionId), `${front.id} contains invalid ${regionId}`);
    }
    for (const regionId of friendly) {
      assert(!enemy.has(regionId), `${front.id} repeats ${regionId} on both sides`);
    }
  }
});

test("strength uses battle strength within a one-region influence depth", () => {
  const world = createFrontWorld(
    [
      { id: "a-border", owner: NATION_A, building: "capital" },
      { id: "a-rear", owner: NATION_A, building: "city" },
      { id: "a-deep", owner: NATION_A },
      { id: "b-border", owner: NATION_B, building: "capital" },
      { id: "b-rear", owner: NATION_B },
    ],
    [
      ["a-border", "b-border"],
      ["a-border", "a-rear"],
      ["a-rear", "a-deep"],
      ["b-border", "b-rear"],
    ],
  );
  startWar(world, NATION_A, NATION_B);
  const borderUnit = addLandUnit(world, NATION_A, "a-border", "Infantry");
  const rearUnit = addLandUnit(world, NATION_A, "a-rear", "Tank");
  const deepUnit = addLandUnit(world, NATION_A, "a-deep", "Infantry");
  const enemyUnit = addLandUnit(world, NATION_B, "b-border", "Infantry");

  updateLandFronts(world);

  const front = frontsBetween(world, NATION_A, NATION_B)[0];
  assert(front);
  const friendly = getFrontSide(front, NATION_A);
  const enemy = getFrontSide(front, NATION_B);
  assert(friendly && enemy);
  assert.deepEqual(friendly.unitIds, [borderUnit.id, rearUnit.id].sort());
  assert(!friendly.unitIds.includes(deepUnit.id));
  assert.deepEqual(enemy.unitIds, [enemyUnit.id]);
  assert.equal(
    friendly.strength,
    getUnitCombatStrength(borderUnit) + getUnitCombatStrength(rearUnit),
  );
  assert.equal(friendly.nearbyCityCount, 1);
  assert.equal(friendly.hasNearbyCapital, true);
  assert.equal(enemy.hasNearbyCapital, true);
  for (const value of [friendly.strength, enemy.strength]) {
    assert(Number.isFinite(value));
  }
});

test("overwhelming superiority produces an attack plan", () => {
  const world = createStrengthPlanWorld(200, 100);

  const plan = planFor(world, NATION_A);

  assert.equal(plan.posture, "attack");
  assert.equal(plan.desiredStrength, 160);
  assert(plan.reasonFlags.includes("strength-superiority"));
  assert.match(formatNationFrontPlanSummary(world), /posture: attack/);
});

test("balanced strength produces a hold plan", () => {
  const world = createStrengthPlanWorld(100, 100);

  const plan = planFor(world, NATION_A);

  assert.equal(plan.posture, "hold");
  assert.equal(plan.desiredStrength, 110);
  assert(plan.reasonFlags.includes("forces-balanced"));
});

test("a moderate disadvantage produces a reinforce plan", () => {
  const world = createStrengthPlanWorld(60, 100);

  const plan = planFor(world, NATION_A);

  assert.equal(plan.posture, "reinforce");
  assert.equal(plan.desiredStrength, 130);
  assert(plan.reasonFlags.includes("strength-disadvantage"));
});

test("an extreme disadvantage produces a retreat plan", () => {
  const world = createStrengthPlanWorld(20, 100);

  const plan = planFor(world, NATION_A);

  assert.equal(plan.posture, "retreat");
  assert.equal(plan.desiredStrength, 50);
  assert(plan.reasonFlags.includes("strength-disadvantage"));
});

test("a nearby friendly capital raises front priority", () => {
  const world = createStrengthPlanWorld(100, 100);
  const baselinePlan = planFor(world, NATION_A);
  const geometryVersion = world.landFronts.version;
  const friendlyRegion = world.mesoRegions.find((region) => region.id === id("a"));
  assert(friendlyRegion);
  friendlyRegion.building = "capital";
  world.buildingVersion += 1;
  updateFrontSystem(world);
  const capitalPlan = planFor(world, NATION_A);

  assert(capitalPlan.priority > baselinePlan.priority);
  assert(capitalPlan.reasonFlags.includes("capital-threatened"));
  assert.equal(world.landFronts.version, geometryVersion);
});

test("a nearby enemy capital raises attack priority", () => {
  const baseline = createStrengthPlanWorld(200, 100);
  const capital = createStrengthPlanWorld(200, 100, null, "capital");

  const baselinePlan = planFor(baseline, NATION_A);
  const capitalPlan = planFor(capital, NATION_A);

  assert.equal(capitalPlan.posture, "attack");
  assert(capitalPlan.priority > baselinePlan.priority);
  assert(capitalPlan.reasonFlags.includes("enemy-capital-nearby"));
});

test("a peaceful border has no nation front plans", () => {
  const world = createSimpleBorderWorld();

  updateLandFronts(world);
  updateNationFrontPlans(world);

  assert.equal(getNationFrontPlans(world).length, 0);
});

test("ending a war removes all plans for its physical front", () => {
  const world = createStrengthPlanWorld(100, 100);
  assert.equal(getNationFrontPlans(world).length, 2);

  world.wars = [];
  updateFrontSystem(world);

  assert.equal(world.landFronts.physicalFronts.length, 0);
  assert.equal(getNationFrontPlans(world).length, 0);
});

test("front split and merge replace plans without leaving invalid references", () => {
  const world = createThreeSegmentWorld(false);
  startWar(world, NATION_A, NATION_B);
  updateFrontSystem(world);
  assertPlanReferencesAreValid(world, 1);

  setRegionOwner(world, "a2", NATION_C);
  setRegionOwner(world, "b2", NATION_C);
  world.territoryVersion += 1;
  updateFrontSystem(world);
  assertPlanReferencesAreValid(world, 2);

  setRegionOwner(world, "a2", NATION_A);
  setRegionOwner(world, "b2", NATION_B);
  world.territoryVersion += 1;
  updateFrontSystem(world);
  assertPlanReferencesAreValid(world, 1);
});

test("priority and desired strength are finite for zero-strength fronts", () => {
  const world = createStrengthPlanWorld(0, 0);

  for (const plan of getNationFrontPlans(world)) {
    assert(Number.isFinite(plan.priority));
    assert(Number.isFinite(plan.desiredStrength));
    assert(plan.priority >= 0 && plan.priority <= 100);
    assert(plan.desiredStrength >= 0);
  }
});

test("attack posture uses hysteresis near its exit threshold", () => {
  const world = createStrengthPlanWorld(170, 100);
  const friendlyUnit = world.units.find((unit) => unit.nationId === NATION_A);
  assert(friendlyUnit);
  assert.equal(planFor(world, NATION_A).posture, "attack");

  setUnitStrength(friendlyUnit, 150);
  world.time.fastTick += 10;
  updateFrontSystem(world);
  const maintained = planFor(world, NATION_A);
  assert.equal(maintained.posture, "attack");
  assert(maintained.reasonFlags.includes("posture-maintained"));

  setUnitStrength(friendlyUnit, 130);
  world.time.fastTick += 10;
  updateFrontSystem(world);
  assert.equal(planFor(world, NATION_A).posture, "hold");
});

test("two nation plans reference one physical front without duplicating geometry", () => {
  const world = createStrengthPlanWorld(200, 100);
  const [front] = world.landFronts.physicalFronts;
  assert(front);
  const plans = getNationFrontPlans(world);

  assert.equal(world.landFronts.physicalFronts.length, 1);
  assert.equal(plans.length, 2);
  assert(plans.every((plan) => plan.frontId === front.id));
  assert.equal(getFrontPlan(world, front.id, NATION_A)?.frontId, front.id);
  assert.equal(getFrontPlan(world, front.id, NATION_B)?.frontId, front.id);
  assert(!("sideA" in plans[0]));
  assert(!("borderEdges" in plans[0]));
  assert.notEqual(front.sideA.strength, front.sideB.strength);
});

test("evaluating plans does not mutate units, targets, wars, or world versions", () => {
  const world = createSimpleBorderWorld();
  startWar(world, NATION_A, NATION_B);
  addLandUnit(world, NATION_A, "a", "Infantry");
  addLandUnit(world, NATION_B, "b", "Infantry");
  updateLandFronts(world);
  const before = {
    units: structuredClone(world.units),
    wars: structuredClone(world.wars),
    occupation: [...world.occupation.mesoById],
    occupationVersion: world.occupation.version,
    territoryVersion: world.territoryVersion,
  };

  updateNationFrontPlans(world);

  assert.deepEqual(world.units, before.units);
  assert.deepEqual(world.wars, before.wars);
  assert.deepEqual([...world.occupation.mesoById], before.occupation);
  assert.equal(world.occupation.version, before.occupationVersion);
  assert.equal(world.territoryVersion, before.territoryVersion);
});

test("a land unit belongs to at most one physical front", () => {
  const world = createAllocatedTwoFrontWorld();
  const allocatedIds = getNationFrontAllocations(world).flatMap(
    (allocation) => allocation.unitIds,
  );

  assert.equal(new Set(allocatedIds).size, allocatedIds.length);
  for (const unitId of allocatedIds) {
    assert(getAllocatedFrontId(world, unitId));
  }
});

test("every allocated unit ID resolves to a valid land unit of the same nation", () => {
  const world = createAllocatedTwoFrontWorld();
  const unitById = new Map(world.units.map((unit) => [unit.id, unit]));

  for (const allocation of getNationFrontAllocations(world)) {
    for (const unitId of allocation.unitIds) {
      const unit = unitById.get(unitId);
      assert(unit);
      assert.equal(unit.domain, "land");
      assert.equal(unit.nationId, allocation.nationId);
    }
  }
});

test("an extinct nation receives no front allocation", () => {
  const world = createAllocatedTwoFrontWorld();
  const extinctUnit = addLandUnit(world, NATION_C, "a1", "Infantry");
  world.time.fastTick += 10;
  updateAllocationSystem(world);

  assert.equal(getNationFrontAllocations(world, NATION_C).length, 0);
  assert.equal(getAllocatedFrontId(world, extinctUnit.id), undefined);
});

test("a peaceful nation does not use front allocation", () => {
  const world = createSimpleBorderWorld();
  const unit = addLandUnit(world, NATION_A, "a", "Infantry");

  updateAllocationSystem(world);

  assert.equal(getNationFrontAllocations(world, NATION_A).length, 0);
  assert.equal(getAllocatedFrontId(world, unit.id), undefined);
});

test("a disappearing physical front releases its allocation", () => {
  const world = createSimpleBorderWorld();
  startWar(world, NATION_A, NATION_B);
  const unit = addLandUnit(world, NATION_A, "a", "Infantry");
  addLandUnit(world, NATION_B, "b", "Infantry");
  updateAllocationSystem(world);
  assert(getAllocatedFrontId(world, unit.id));

  world.occupation.mesoById.set(id("b"), NATION_A);
  world.occupation.version += 1;
  updateAllocationSystem(world);

  assert.equal(world.landFronts.physicalFronts.length, 0);
  assert.equal(getAllocatedFrontId(world, unit.id), undefined);
});

test("ending a war releases every unit from its front", () => {
  const world = createAllocatedTwoFrontWorld();
  assert(world.frontAllocations.frontIdByUnitId.size > 0);

  world.wars = [];
  updateAllocationSystem(world);

  assert.equal(getNationFrontAllocations(world).length, 0);
  assert.equal(world.frontAllocations.frontIdByUnitId.size, 0);
});

test("front splitting never duplicates allocated units", () => {
  const world = createAllocatedThreeSegmentWorld(false);
  assertUniqueAllocatedUnits(world);

  setRegionOwner(world, "a2", NATION_C);
  setRegionOwner(world, "b2", NATION_C);
  world.territoryVersion += 1;
  updateAllocationSystem(world);

  assert.equal(frontsBetween(world, NATION_A, NATION_B).length, 2);
  assertUniqueAllocatedUnits(world);
});

test("front merging never duplicates allocated units", () => {
  const world = createAllocatedThreeSegmentWorld(true);
  assert.equal(frontsBetween(world, NATION_A, NATION_B).length, 2);
  assertUniqueAllocatedUnits(world);

  setRegionOwner(world, "a2", NATION_A);
  setRegionOwner(world, "b2", NATION_B);
  world.territoryVersion += 1;
  updateAllocationSystem(world);

  assert.equal(frontsBetween(world, NATION_A, NATION_B).length, 1);
  assertUniqueAllocatedUnits(world);
});

test("allocated strength is finite and equals its units' combat strength", () => {
  const world = createAllocatedTwoFrontWorld();
  const unitById = new Map(world.units.map((unit) => [unit.id, unit]));

  for (const allocation of getNationFrontAllocations(world)) {
    const expected = allocation.unitIds.reduce(
      (total, unitId) => total + getUnitCombatStrength(unitById.get(unitId)!),
      0,
    );
    assert(Number.isFinite(allocation.allocatedStrength));
    assert.equal(allocation.allocatedStrength, expected);
  }
});

test("allocation deficit and surplus match desired minus allocated strength", () => {
  const world = createAllocatedTwoFrontWorld();

  for (const allocation of getNationFrontAllocations(world)) {
    assert.equal(
      allocation.deficit,
      Math.max(0, allocation.desiredStrength - allocation.allocatedStrength),
    );
    assert.equal(
      allocation.surplus,
      Math.max(0, allocation.allocatedStrength - allocation.desiredStrength),
    );
  }
  assert.match(formatNationFrontAllocationSummary(world), /allocated|strength:/);
  assert.match(formatNationFrontPlanSummary(world), /allocation:\n  units:/);
});

test("an allocated unit only receives a target inside its assigned front", () => {
  const world = createAllocatedTwoFrontWorld();

  repositionUnits(world, 100);

  const unitById = new Map(world.units.map((unit) => [unit.id, unit]));
  let targetedUnitCount = 0;
  for (const allocation of getNationFrontAllocations(world, NATION_A)) {
    const front = world.landFronts.physicalFrontsById.get(allocation.frontId);
    assert(front);
    const friendly = getFrontSide(front, NATION_A);
    const enemy = getFrontSide(front, NATION_B);
    assert(friendly && enemy);
    const allowedTargets = new Set([
      ...friendly.influenceRegionIds,
      ...enemy.influenceRegionIds,
    ]);
    for (const unitId of allocation.unitIds) {
      const targetId = unitById.get(unitId)?.moveTargetId;
      if (!targetId) {
        continue;
      }
      targetedUnitCount += 1;
      assert(
        allowedTargets.has(targetId),
        `${unitId} targeted ${targetId} outside ${allocation.frontId}`,
      );
    }
  }
  assert(targetedUnitCount > 0);
});

test("a wartime nation without a physical front keeps the legacy fallback", () => {
  const world = createFrontWorld(
    [
      { id: "a", owner: NATION_A },
      { id: "c", owner: NATION_C },
      { id: "b", owner: NATION_B },
    ],
    [
      ["a", "c"],
      ["c", "b"],
    ],
  );
  startWar(world, NATION_A, NATION_B);
  const unit = addLandUnit(world, NATION_A, "a", "Infantry");
  updateAllocationSystem(world);
  assert.equal(getNationFrontAllocations(world, NATION_A).length, 0);

  repositionUnits(world, 100);

  assert(unit.moveTargetId, "legacy defense fallback should keep the unit active");
});

test("an unchanged allocation rebuild does not switch units between fronts", () => {
  const world = createAllocatedTwoFrontWorld();
  const before = new Map(world.frontAllocations.frontIdByUnitId);

  world.time.fastTick += 10;
  updateAllocationSystem(world);

  assert.deepEqual(world.frontAllocations.frontIdByUnitId, before);
  assert.equal(world.frontAllocations.lastUnitSwitchCount, 0);
  assert.equal(world.frontAllocations.lastFrontTransferCount, 0);
});

test("naval units never enter land front allocation", () => {
  const world = createAllocatedTwoFrontWorld();
  const navalUnit = createUnitForType(
    createUnitId(world.unitIdCounter),
    NATION_A,
    id("a1"),
    "CombatShip",
  );
  world.unitIdCounter += 1;
  world.units.push(navalUnit);
  world.time.fastTick += 10;
  updateAllocationSystem(world);

  assert.equal(getAllocatedFrontId(world, navalUnit.id), undefined);
  assert(
    getNationFrontAllocations(world).every(
      (allocation) => !allocation.unitIds.includes(navalUnit.id),
    ),
  );
});

test("a retreat front receives only a small covering allocation", () => {
  const world = createSimpleBorderWorld();
  startWar(world, NATION_A, NATION_B);
  for (let index = 0; index < 5; index += 1) {
    setUnitStrength(addLandUnit(world, NATION_A, "a", "Infantry"), 20);
  }
  setUnitStrength(addLandUnit(world, NATION_B, "b", "Infantry"), 500);

  updateAllocationSystem(world);

  const [allocation] = getNationFrontAllocations(world, NATION_A);
  assert(allocation);
  assert.equal(allocation.posture, "retreat");
  assert.equal(allocation.unitIds.length, 1);
  assert.equal(world.frontAllocations.lastUnassignedUnitCount, 4);
});

test("a moving border keeps allocation continuity when its deterministic ID changes", () => {
  const world = createFrontWorld(
    [
      { id: "a1", owner: NATION_A },
      { id: "a2", owner: NATION_A },
      { id: "b1", owner: NATION_B },
      { id: "b2", owner: NATION_B },
    ],
    [
      ["a1", "a2"],
      ["b1", "b2"],
      ["a1", "b1"],
      ["a2", "b2"],
    ],
  );
  startWar(world, NATION_A, NATION_B);
  addLandUnit(world, NATION_A, "a1", "Infantry");
  addLandUnit(world, NATION_A, "a2", "Infantry");
  addLandUnit(world, NATION_B, "b2", "Infantry");
  updateAllocationSystem(world);
  const previousFrontId = world.landFronts.physicalFronts[0]?.id;
  assert(previousFrontId);

  world.occupation.mesoById.set(id("b1"), NATION_A);
  world.occupation.version += 1;
  updateAllocationSystem(world);
  const nextFrontId = world.landFronts.physicalFronts[0]?.id;
  assert(nextFrontId);

  assert.notEqual(nextFrontId, previousFrontId);
  assert.equal(world.frontAllocations.lastFrontTransferCount, 0);
  assert.equal(world.frontAllocations.lastUnitSwitchCount, 0);
});

test("only an attack front creates an offensive operation", () => {
  const world = createOperationWorld();

  updateOffensiveOperations(world);

  const [operation] = getOffensiveOperations(world, NATION_A);
  assert(operation);
  assert.equal(planFor(world, NATION_A).posture, "attack");
  assert.equal(operation.frontId, planFor(world, NATION_A).frontId);
});

test("inactivity diagnostics separate scheduled work and Operation lifecycle waiting", () => {
  const world = createOperationWorld();
  updateFrontlineCoverage(world);
  const sector = world.landFronts.operationalSectors[0];
  assert(sector);
  const friendly = getFrontSide(sector, NATION_A);
  const enemy = getFrontSide(sector, NATION_B);
  assert(friendly && enemy);
  friendly.strength = WORLD_BALANCE.war.landFront.stalemate.minimumMeaningfulStrength * 2;
  enemy.strength = 1;

  updateStalematePressure(world);
  const scheduled = getStalemateAssessment(world, NATION_A, NATION_B);
  assert(scheduled);
  assert.equal(scheduled.inactivityCategory, "expected-waiting");
  assert.equal(scheduled.inactivityReason, "scheduled-operation");
  assert.equal(scheduled.artificialInactivity, false);

  updateOffensiveOperations(world);
  updateStalematePressure(world);
  const preparing = getStalemateAssessment(world, NATION_A, NATION_B);
  assert(preparing);
  assert.equal(preparing.inactivityCategory, "healthy-waiting");
  assert.equal(preparing.inactivityReason, "preparing");

  const operation = getOffensiveOperations(world, NATION_A)[0];
  assert(operation);
  operation.phase = "recovering";
  operation.expiresAtTick = world.time.fastTick + 60;
  updateStalematePressure(world);
  const recovering = getStalemateAssessment(world, NATION_A, NATION_B);
  assert(recovering);
  assert.equal(recovering.inactivityCategory, "healthy-waiting");
  assert.equal(recovering.inactivityReason, "recovering");
  assert.equal(recovering.nextEvaluationTick, operation.expiresAtTick);
  assert.deepEqual(
    world.stalematePressure.inactivityTimeline.filter((event) => event.nationId === NATION_A).slice(-3).map((event) => event.reason),
    ["scheduled-operation", "preparing", "recovering"],
  );
});

test("hold, reinforce, and retreat fronts do not start operations", () => {
  for (const posture of ["hold", "reinforce", "retreat"] as const) {
    const world = createOperationWorld();
    planFor(world, NATION_A).posture = posture;

    updateOffensiveOperations(world);

    assert.equal(getOffensiveOperations(world, NATION_A).length, 0, posture);
  }
});

test("a nation respects the active offensive operation limit", () => {
  const world = createAllocatedTwoFrontWorld();

  updateOffensiveOperations(world);

  assert.equal(
    getOffensiveOperations(world, NATION_A).length,
    WORLD_BALANCE.war.landFront.offensiveOperation.maxActivePerNation,
  );
});

test("open reachable enemy territory starts a concentrated Collapse Advance", () => {
  const world = createCollapseAdvanceWorld();
  updateCollapseAdvances(world);
  const advance = world.collapseAdvances.advanceByNationId.get(NATION_A);
  assert(advance);
  assert.equal(advance.enemyNationId, NATION_B);
  assert(advance.unitIds.length >= 1 && advance.unitIds.length <= WORLD_BALANCE.war.landFront.collapseAdvance.maximumUnits);
  assert.equal(new Set(advance.unitIds).size, advance.unitIds.length);
  assert.equal(world.mesoRegions.find((region) => region.id === advance.currentTargetRegionId)?.type === "sea", false);
  assert.equal(world.occupation.mesoById.get(advance.currentTargetRegionId) ?? NATION_B, NATION_B);
  assert.equal(advance.currentTargetRegionId, id("b1"), "nearby capital is preferred along the open axis");
  const diagnostic = world.stalematePressure.assessments[0];
  assert.equal(diagnostic.inactivityCategory, "healthy-waiting");
  assert.equal(diagnostic.inactivityReason, "collapse-opportunity");
  assert.equal(diagnostic.artificialInactivity, false);
});

test("a valid normal Operation suppresses Collapse Advance and prevents duplicate units", () => {
  const world = createCollapseAdvanceWorld();
  updateOffensiveOperations(world);
  assert(getOffensiveOperations(world, NATION_A).length > 0);
  updateCollapseAdvances(world);
  assert.equal(world.collapseAdvances.advanceByNationId.has(NATION_A), false);
  for (const id of world.collapseAdvances.advanceNationByUnitId.keys()) assert.equal(world.offensiveOperations.operationIdByUnitId.has(id), false);
});

test("Collapse Advance excludes Frontline Coverage, Reserve, and Reorganization units", () => {
  const world = createCollapseAdvanceWorld();
  const allocation = getNationFrontAllocations(world, NATION_A)[0];
  assert(allocation && allocation.unitIds.length >= 3);
  const [reserveId, reorganizingId] = allocation.unitIds;
  world.strategicReserves.reserveNationByUnitId.set(reserveId, NATION_A);
  world.reorganization.planIdByUnitId.set(reorganizingId, "reorg-test" as never);
  updateFrontlineCoverage(world);
  const defenders = new Set(getFrontlineCoverage(world, allocation.frontId, NATION_A)?.positions.flatMap((position) => position.defenderUnitIds) ?? []);
  updateCollapseAdvances(world);
  const advance = world.collapseAdvances.advanceByNationId.get(NATION_A);
  assert(advance);
  assert(!advance.unitIds.includes(reserveId));
  assert(!advance.unitIds.includes(reorganizingId));
  assert(advance.unitIds.every((id) => !defenders.has(id)));
});

test("a reformed meaningful enemy Front stops Collapse Advance", () => {
  const world = createCollapseAdvanceWorld();
  updateCollapseAdvances(world);
  assert(world.collapseAdvances.advanceByNationId.has(NATION_A));
  setUnitStrength(addLandUnit(world, NATION_B, "b0", "Infantry"), WORLD_BALANCE.war.landFront.collapseAdvance.reformedDefenseStrength * 2);
  beginAiGeographyEvaluation(world);
  updateFrontlineCoverage(world);
  updateCollapseAdvances(world);
  assert.equal(world.collapseAdvances.advanceByNationId.has(NATION_A), false);
  assert.equal(world.collapseAdvances.history.at(-1)?.stopReason, "front-reformed");
});

test("a land unit never belongs to multiple offensive operations", () => {
  const world = createOperationWorld();
  updateOffensiveOperations(world);
  const unitIds = getOffensiveOperations(world).flatMap(
    (operation) => operation.assignedUnitIds,
  );

  assert.equal(new Set(unitIds).size, unitIds.length);
  assert.equal(world.offensiveOperations.operationIdByUnitId.size, unitIds.length);
  for (const unitId of unitIds) {
    assert(getOffensiveOperationForUnit(world, unitId));
  }
});

test("operation units come only from the same Front allocation", () => {
  const world = createOperationWorld();
  updateOffensiveOperations(world);

  for (const operation of getOffensiveOperations(world)) {
    const allocation = world.frontAllocations.allocationsByFrontNation.get(
      `${operation.frontId}::${operation.nationId}`,
    );
    assert(allocation);
    const allocatedIds = new Set(allocation.unitIds);
    assert(operation.assignedUnitIds.every((unitId) => allocatedIds.has(unitId)));
  }
});

test("the primary operation target is on the enemy side of its Front", () => {
  const world = createOperationClusterWorld();
  updateOffensiveOperations(world);
  const operation = onlyOperation(world, NATION_A);
  const front = world.landFronts.physicalFrontsById.get(operation.frontId);
  assert(front);
  const enemy = getFrontSide(front, NATION_B);
  assert(enemy);

  assert(enemy.influenceRegionIds.includes(operation.primaryTargetRegionId));
});

test("supporting operation targets stay within two meso regions of primary", () => {
  const world = createOperationClusterWorld();
  updateOffensiveOperations(world);
  const operation = onlyOperation(world, NATION_A);

  assert(operation.supportingTargetRegionIds.length > 0);
  for (const targetId of operation.supportingTargetRegionIds) {
    assert(
      isWithinTestDistance(
        world,
        operation.primaryTargetRegionId,
        targetId,
        WORLD_BALANCE.war.landFront.offensiveOperation.supportingTargetRadius,
      ),
    );
  }
});

test("preparing operation units stage instead of immediately attacking", () => {
  const world = createOperationWorld();
  updateOffensiveOperations(world);
  const operation = onlyOperation(world, NATION_A);

  repositionUnits(world, 100);

  const unitById = new Map(world.units.map((unit) => [unit.id, unit]));
  assert.equal(operation.phase, "preparing");
  for (const unitId of operation.assignedUnitIds) {
    assert.equal(unitById.get(unitId)?.moveTargetId, operation.stagingRegionId);
    assert.notEqual(unitById.get(unitId)?.moveTargetId, operation.primaryTargetRegionId);
  }
});

test("preflight commits one deterministic on-time manifest and starts its lease", () => {
  const world = createOperationWorld();

  updateOffensiveOperations(world);

  const operation = onlyOperation(world, NATION_A);
  assert.equal(world.offensiveOperations.candidatesCreatedCount, 1);
  assert.equal(world.offensiveOperations.candidatesAcceptedCount, 1);
  assert.equal(operation.preparationLeaseEndedAtTick, null);
  assert.equal(operation.preparationFeasible, true);
  assert.deepEqual(
    operation.committedManifest.map((assignment) => assignment.unitId).sort(),
    [...operation.assignedUnitIds].sort(),
  );
  assert(operation.committedManifest.every((assignment) => assignment.arrivalSlack >= 0));
  assert(operation.approachGroups.every((group) =>
    group.feasibleStrength >= group.requiredStrength *
      WORLD_BALANCE.war.landFront.offensiveOperation.stagedFraction
  ));
});

test("preflight retains an impossible candidate without creating an operation", () => {
  const world = createFrontWorld(
    [
      { id: "rear2", owner: NATION_A },
      { id: "rear1", owner: NATION_A },
      { id: "a", owner: NATION_A },
      { id: "b", owner: NATION_B },
    ],
    [["rear2", "rear1"], ["rear1", "a"], ["a", "b"]],
  );
  startWar(world, NATION_A, NATION_B);
  for (let index = 0; index < 6; index += 1) {
    const unit = addLandUnit(world, NATION_A, "a", "Infantry");
    setUnitStrength(unit, 100);
  }
  for (let index = 0; index < 2; index += 1) {
    setUnitStrength(addLandUnit(world, NATION_B, "b", "Infantry"), 50);
  }
  updateAllocationSystem(world);
  const plan = planFor(world, NATION_A);
  plan.posture = "attack";
  for (const unit of world.units) {
    if (unit.nationId !== NATION_A) continue;
    unit.regionId = id("rear2");
    unit.moveTicksPerRegion = 200;
  }

  updateOffensiveOperations(world);

  const candidate = getOperationCandidateForFront(world, plan.frontId, NATION_A);
  assert(candidate);
  assert.equal(candidate.feasible, false);
  assert(candidate.rejectionReasons.includes("insufficient-on-time-strength"));
  assert.equal(getOffensiveOperations(world, NATION_A).length, 0);
  assert.equal(world.offensiveOperations.impossibleAtCreationCount, 1);

  world.time.fastTick += 10;
  updateOffensiveOperations(world);
  const reevaluated = getOperationCandidateForFront(world, plan.frontId, NATION_A);
  assert(reevaluated);
  assert.equal(reevaluated.createdAtTick, candidate.createdAtTick);
  assert.equal(reevaluated.evaluationCount, 2);
});

test("staged operation force transitions from preparing to attacking", () => {
  const world = createOperationWorld();
  updateOffensiveOperations(world);
  const operation = onlyOperation(world, NATION_A);

  advanceOperationEvaluation(
    world,
    WORLD_BALANCE.war.landFront.offensiveOperation.minimumPreparationTicks,
  );

  assert.equal(operation.phase, "attacking");
  assert(
    world.offensiveOperations.timeline.some(
      (event) =>
        event.operationId === operation.id &&
        event.type === "phase-transition",
    ),
  );
  assert.notEqual(operation.preparationLeaseEndedAtTick, null);
  assert.equal(world.offensiveOperations.preparationLeaseLifetimeCount, 1);
});

test("a preparing Approach replaces lost strength instead of preserving unit identity", () => {
  const world = createOperationWorld();
  updateOffensiveOperations(world);
  const operation = onlyOperation(world, NATION_A);
  const lostId = operation.assignedUnitIds[0];
  assert(lostId);
  for (const group of operation.approachGroups) {
    group.requiredStrength = group.currentAssignedStrength;
    operation.plannedStrengthByApproach.set(group.regionId, group.requiredStrength);
  }
  world.units = world.units.filter((unit) => unit.id !== lostId);
  const replacement = addLandUnit(world, NATION_A, "a", "Infantry");
  replacement.id = "replacement-unit" as typeof replacement.id;
  setUnitStrength(replacement, 100);
  const allocation = world.frontAllocations.allocationsByFrontNation.get(
    `${operation.frontId}::${operation.nationId}`,
  );
  assert(allocation);
  allocation.unitIds = [...allocation.unitIds.filter((unitId) => unitId !== lostId), replacement.id];
  allocation.allocatedStrength += 100;
  world.frontAllocations.frontIdByUnitId.delete(lostId);
  world.frontAllocations.frontIdByUnitId.set(replacement.id, operation.frontId);

  updateOffensiveOperations(world);

  assert(!operation.assignedUnitIds.includes(lostId));
  assert(operation.assignedUnitIds.includes(replacement.id));
  assert.equal(operation.replacementRecruitCount, 1);
  assert(operation.approachGroups.some((group) => group.assignedUnitIds.includes(replacement.id)));
});

test("occupying the primary target completes an attacking operation", () => {
  const world = createOperationWorld();
  updateOffensiveOperations(world);
  const operation = onlyOperation(world, NATION_A);
  advanceOperationEvaluation(
    world,
    WORLD_BALANCE.war.landFront.offensiveOperation.minimumPreparationTicks,
  );
  world.occupation.mesoById.set(operation.primaryTargetRegionId, NATION_A);
  world.occupation.version += 1;

  updateOffensiveOperations(world);

  assert.equal(operation.phase, "recovering");
  assert.equal(operation.outcome, "success");
  assert.equal(operation.completionReason, "primary-target-occupied");
});

test("successful attack exploits an adjacent gap with a bounded force split", () => {
  const world = createExploitationPursuitWorld();
  updateOffensiveOperations(world);
  const operation = onlyOperation(world, NATION_A);
  advanceOperationEvaluation(
    world,
    WORLD_BALANCE.war.landFront.offensiveOperation.minimumPreparationTicks,
  );
  world.occupation.mesoById.set(operation.primaryTargetRegionId, NATION_A);
  world.occupation.version += 1;
  updateAllocationSystem(world);
  updateFrontlineCoverage(world);

  updateOffensiveOperations(world);

  assert.equal(
    operation.phase,
    "exploiting",
    `${formatOffensiveOperationSummary(world)}\n${JSON.stringify(world.frontlineCoverage.coverages)}`,
  );
  assert.equal(operation.exploitationTargetRegionId, id("b2"));
  assert.equal(operation.exploitationDepth, 1);
  assert.equal(
    operation.exploitationUnitIds.length,
    Math.ceil(operation.assignedUnitIds.length * 0.7),
  );
  assert(operation.exploitationHoldUnitIds.length > 0);
  assert(
    operation.exploitationHoldUnitIds.every(
      (unitId) => operation.unitTargetRegionIds.get(unitId) === operation.primaryTargetRegionId,
    ),
  );

  const stableTarget = operation.exploitationTargetRegionId;
  updateOffensiveOperations(world);
  assert.equal(operation.exploitationTargetRegionId, stableTarget);

  world.occupation.mesoById.set(id("b2"), NATION_A);
  world.occupation.version += 1;
  updateOffensiveOperations(world);
  assert.equal(operation.phase, "recovering");
  assert.equal(operation.exploitationStopReason, "target-occupied");
  assert.equal(world.offensiveOperations.exploitationSuccessCount, 1);
  assert.deepEqual(operation.capturedRegionIds, [id("b1"), id("b2")]);
});

test("exploitation rejects a weak route without local force superiority", () => {
  const world = createExploitationPursuitWorld();
  updateOffensiveOperations(world);
  const operation = onlyOperation(world, NATION_A);
  advanceOperationEvaluation(
    world,
    WORLD_BALANCE.war.landFront.offensiveOperation.minimumPreparationTicks,
  );
  world.occupation.mesoById.set(operation.primaryTargetRegionId, NATION_A);
  world.occupation.version += 1;
  updateAllocationSystem(world);
  updateFrontlineCoverage(world);
  const enemyUnit = world.units.find((unit) => unit.nationId === NATION_B);
  assert(enemyUnit);
  setUnitStrength(enemyUnit, 1_000);

  updateOffensiveOperations(world);

  assert.equal(operation.phase, "recovering");
  assert.equal(operation.exploitationStartedAtTick, null);
  assert(world.offensiveOperations.exploitationRejectionCounts.insufficientLocalStrength > 0);
});

test("an exploitation target persists until coverage closes, then stops", () => {
  const world = createExploitationPursuitWorld();
  updateOffensiveOperations(world);
  const operation = onlyOperation(world, NATION_A);
  advanceOperationEvaluation(
    world,
    WORLD_BALANCE.war.landFront.offensiveOperation.minimumPreparationTicks,
  );
  world.occupation.mesoById.set(operation.primaryTargetRegionId, NATION_A);
  world.occupation.version += 1;
  updateAllocationSystem(world);
  updateFrontlineCoverage(world);
  updateOffensiveOperations(world);
  assert.equal(operation.phase, "exploiting");
  const targetId = operation.exploitationTargetRegionId;
  const targetPosition = world.frontlineCoverage.coverages
    .find((coverage) => coverage.nationId === NATION_B)
    ?.positions.find((position) => position.friendlyRegionId === targetId);
  assert(targetPosition);
  targetPosition.state = "covered";

  updateOffensiveOperations(world);

  assert.equal(operation.exploitationTargetRegionId, targetId);
  assert.equal(operation.phase, "recovering");
  assert.equal(operation.exploitationStopReason, "covered-frontline");
});

test("a city behind a gap beats a stronger weak capital route", () => {
  const { world, operation } = prepareStrategicExploitationWorld();
  const enemyCoverage = world.frontlineCoverage.coverages.find(
    (coverage) => coverage.nationId === NATION_B,
  );
  assert(enemyCoverage);
  const city = enemyCoverage.positions.find((position) => position.friendlyRegionId === id("city"));
  const capital = enemyCoverage.positions.find((position) => position.friendlyRegionId === id("capital"));
  assert(city && capital);
  city.state = "gap";
  city.defenderStrength = 0;
  capital.state = "weak";
  capital.defenderStrength = 300;

  updateOffensiveOperations(world);

  assert.equal(operation.phase, "exploiting");
  assert.equal(operation.exploitationTargetRegionId, id("city"));
  assert.equal(operation.exploitationTargetCoverageState, "gap");
  assert.equal(operation.exploitationTargetLocalEnemyStrength, 0);
  assert.equal(operation.exploitationForceStrength, 200);
  assert.equal(operation.exploitationTargetScore, 144.55);
});

test("a gap toward the capital beats a weaker city route", () => {
  const { world, operation } = prepareStrategicExploitationWorld();
  const enemyCoverage = world.frontlineCoverage.coverages.find(
    (coverage) => coverage.nationId === NATION_B,
  );
  assert(enemyCoverage);
  const city = enemyCoverage.positions.find((position) => position.friendlyRegionId === id("city"));
  const capital = enemyCoverage.positions.find((position) => position.friendlyRegionId === id("capital"));
  assert(city && capital);
  city.state = "weak";
  city.defenderStrength = 100;
  capital.state = "gap";
  capital.defenderStrength = 0;

  updateOffensiveOperations(world);

  assert.equal(operation.phase, "exploiting");
  assert.equal(operation.exploitationTargetRegionId, id("capital"));
  assert.equal(operation.exploitationTargetCoverageState, "gap");
  assert.equal(operation.exploitationForceStrength, 200);
  assert(Math.abs(operation.exploitationTargetScore - 174.525) < 0.001);
});

test("a disappearing Front cancels its offensive operation", () => {
  const world = createOperationWorld();
  updateOffensiveOperations(world);
  const operation = onlyOperation(world, NATION_A);
  world.landFronts.physicalFronts = [];
  world.landFronts.physicalFrontsById.clear();

  updateOffensiveOperations(world);

  assert.equal(operation.outcome, "cancelled");
  assert.equal(operation.completionReason, "front-disappeared");
});

test("ending the war cancels its offensive operation", () => {
  const world = createOperationWorld();
  updateOffensiveOperations(world);
  const operation = onlyOperation(world, NATION_A);
  world.wars = [];

  updateOffensiveOperations(world);

  assert.equal(operation.outcome, "cancelled");
  assert.equal(operation.completionReason, "war-ended");
});

test("leaving attack posture cancels an offensive operation", () => {
  const world = createOperationWorld();
  updateOffensiveOperations(world);
  const operation = onlyOperation(world, NATION_A);
  planFor(world, NATION_A).posture = "reinforce";

  updateOffensiveOperations(world);

  assert.equal(operation.outcome, "cancelled");
  assert.equal(operation.completionReason, "posture-changed");
});

test("operation completion keeps the nation in recovery cooldown", () => {
  const world = createOperationWorld();
  updateOffensiveOperations(world);
  const operation = onlyOperation(world, NATION_A);
  advanceOperationEvaluation(
    world,
    WORLD_BALANCE.war.landFront.offensiveOperation.minimumPreparationTicks,
  );
  world.occupation.mesoById.set(operation.primaryTargetRegionId, NATION_A);
  world.occupation.version += 1;
  updateOffensiveOperations(world);
  const createdCount = world.offensiveOperations.createdCount;

  advanceOperationEvaluation(
    world,
    WORLD_BALANCE.war.landFront.offensiveOperation.recoveryTicks - 1,
  );

  assert.equal(operation.phase, "recovering");
  assert.equal(world.offensiveOperations.createdCount, createdCount);
});

test("operation target remains stable during minimum commitment", () => {
  const world = createOperationClusterWorld();
  updateOffensiveOperations(world);
  const operation = onlyOperation(world, NATION_A);
  const primary = operation.primaryTargetRegionId;
  const supporting = [...operation.supportingTargetRegionIds];
  advanceOperationEvaluation(
    world,
    WORLD_BALANCE.war.landFront.offensiveOperation.minimumPreparationTicks,
  );

  advanceOperationEvaluation(
    world,
    WORLD_BALANCE.war.landFront.offensiveOperation.minimumCommitTicks - 1,
  );

  assert.equal(operation.primaryTargetRegionId, primary);
  assert.deepEqual(operation.supportingTargetRegionIds, supporting);
  assert.equal(world.offensiveOperations.targetChangeCount, 0);
});

test("every operation region reference resolves to a valid meso region", () => {
  const world = createOperationClusterWorld();
  updateOffensiveOperations(world);
  const validIds = new Set(world.mesoRegions.map((region) => region.id));

  for (const operation of getOffensiveOperations(world)) {
    assert(validIds.has(operation.primaryTargetRegionId));
    assert(validIds.has(operation.stagingRegionId));
    assert(
      operation.supportingTargetRegionIds.every((regionId) => validIds.has(regionId)),
    );
  }
});

test("normal Front units retain Front behavior during an operation", () => {
  const world = createOperationWorld();
  updateOffensiveOperations(world);
  const operation = onlyOperation(world, NATION_A);
  const operationUnitIds = new Set(operation.assignedUnitIds);
  const allocation = world.frontAllocations.allocationsByNationId.get(NATION_A)?.[0];
  assert(allocation);

  repositionUnits(world, 100);

  const unitById = new Map(world.units.map((unit) => [unit.id, unit]));
  const normalUnits = allocation.unitIds
    .filter((unitId) => !operationUnitIds.has(unitId))
    .map((unitId) => unitById.get(unitId));
  assert(normalUnits.length > 0);
  assert(normalUnits.every((unit) => unit?.moveTargetId));
  assert(
    normalUnits.every(
      (unit) => unit?.moveTargetId !== operation.primaryTargetRegionId,
    ),
  );
});

test("naval units never enter an offensive operation", () => {
  const world = createOperationWorld();
  const navalUnit = createUnitForType(
    createUnitId(world.unitIdCounter),
    NATION_A,
    id("a"),
    "CombatShip",
  );
  world.unitIdCounter += 1;
  world.units.push(navalUnit);
  updateAllocationSystem(world);
  updateOffensiveOperations(world);

  assert.equal(getOffensiveOperationForUnit(world, navalUnit.id), undefined);
  assert(
    getOffensiveOperations(world).every(
      (operation) => !operation.assignedUnitIds.includes(navalUnit.id),
    ),
  );
});

test("operation movement creates no pathfinding loop", () => {
  const world = createOperationWorld();
  updateOffensiveOperations(world);
  advanceOperationEvaluation(
    world,
    WORLD_BALANCE.war.landFront.offensiveOperation.minimumPreparationTicks,
  );

  for (let tick = 0; tick < 40; tick += 1) {
    world.time.fastTick += 1;
    repositionUnits(world, 100);
  }

  for (const unit of world.units.filter((candidate) => candidate.domain === "land")) {
    assert(Number.isFinite(unit.moveProgressMs));
    assert(unit.moveFromId === null || unit.moveFromId !== unit.moveToId);
  }
});

test("offensive operation numeric state never contains NaN or Infinity", () => {
  const world = createOperationClusterWorld();
  updateOffensiveOperations(world);

  for (const operation of getOffensiveOperations(world)) {
    for (const value of [
      operation.assignedStrength,
      operation.initialAssignedStrength,
      operation.initialFriendlyStrength,
      operation.initialEnemyStrength,
      operation.initialStrengthRatio,
      operation.targetLocalDefenderStrength,
      operation.targetTacticalScore,
      operation.startedAtTick,
      operation.phaseStartedAtTick,
      operation.minimumCommitUntilTick,
      operation.expiresAtTick,
    ]) {
      assert(Number.isFinite(value));
    }
  }
  assert.match(formatOffensiveOperationSummary(world), /primary:/);
});

test("an expired attack records failure and enters recovery", () => {
  const world = createOperationWorld();
  updateOffensiveOperations(world);
  const operation = onlyOperation(world, NATION_A);
  advanceOperationEvaluation(
    world,
    WORLD_BALANCE.war.landFront.offensiveOperation.minimumPreparationTicks,
  );

  world.time.fastTick = operation.expiresAtTick;
  updateOffensiveOperations(world);

  assert.equal(operation.phase, "recovering");
  assert.equal(operation.outcome, "failure");
  assert.equal(operation.completionReason, "attack-expired");
});

test("attacking operation units deliberately share one to three targets", () => {
  const world = createOperationClusterWorld();
  updateOffensiveOperations(world);
  const operation = onlyOperation(world, NATION_A);
  advanceOperationEvaluation(
    world,
    WORLD_BALANCE.war.landFront.offensiveOperation.minimumPreparationTicks,
  );
  repositionUnits(world, 100);
  const unitById = new Map(world.units.map((unit) => [unit.id, unit]));
  const counts = new Map<MesoRegionId, number>();
  for (const unitId of operation.assignedUnitIds) {
    const targetId = unitById.get(unitId)?.moveTargetId;
    assert(targetId);
    counts.set(targetId, (counts.get(targetId) ?? 0) + 1);
  }

  assert(counts.size >= 1 && counts.size <= 3);
  assert(Math.max(...counts.values()) >= 2);
});

test("only a retreat posture creates a RetreatPlan", () => {
  const world = createRetreatCandidateWorld();
  assert.equal(planFor(world, NATION_A).posture, "retreat");

  updateRetreatPlans(world);

  assert.equal(getRetreatPlans(world, NATION_A).length, 1);
});

test("attack, hold, and reinforce postures do not create RetreatPlans", () => {
  for (const posture of ["attack", "hold", "reinforce"] as const) {
    const world = createRetreatCandidateWorld();
    planFor(world, NATION_A).posture = posture;
    updateRetreatPlans(world);
    assert.equal(getRetreatPlans(world, NATION_A).length, 0, posture);
  }
});

test("non-extreme retreat posture must persist before starting withdrawal", () => {
  const world = createRetreatCandidateWorld();
  const front = getPhysicalFrontsForNation(world, NATION_A)[0];
  assert(front);
  const friendly = getFrontSide(front, NATION_A);
  const enemy = getFrontSide(front, NATION_B);
  assert(friendly && enemy);
  friendly.strength = 30;
  enemy.strength = 100;

  updateRetreatPlans(world);
  assert.equal(getRetreatPlans(world, NATION_A).length, 0);
  world.time.fastTick += WORLD_BALANCE.war.landFront.retreat.persistenceTicks - 1;
  updateRetreatPlans(world);
  assert.equal(getRetreatPlans(world, NATION_A).length, 0);
  world.time.fastTick += 1;
  updateRetreatPlans(world);
  assert.equal(getRetreatPlans(world, NATION_A).length, 1);
});

test("fallback selection strongly prefers the friendly capital cluster", () => {
  const world = createRetreatWorld();
  assert(onlyRetreat(world).fallbackRegionIds.includes(id("a-cap")));
});

test("rearguard and withdrawing forces never overlap", () => {
  const world = createRetreatWorld();
  const retreat = onlyRetreat(world);
  const rearguard = new Set(retreat.rearguardUnitIds);

  assert(retreat.rearguardUnitIds.length > 0);
  assert(retreat.retreatingUnitIds.length > 0);
  assert(retreat.retreatingUnitIds.every((unitId) => !rearguard.has(unitId)));
});

test("rearguard retains a bounded covering share of initial strength", () => {
  const retreat = onlyRetreat(createRetreatWorld());
  const share =
    retreat.initialRearguardStrength /
    (retreat.initialRearguardStrength + retreat.initialRetreatingStrength);

  assert(share >= 0.2 && share <= 0.4);
});

test("a unit never belongs to multiple RetreatPlans", () => {
  const world = createRetreatWorld();
  updateRetreatPlans(world);
  const unitIds = getRetreatPlans(world).flatMap((retreat) => [
    ...retreat.rearguardUnitIds,
    ...retreat.retreatingUnitIds,
  ]);

  assert.equal(new Set(unitIds).size, unitIds.length);
  assert.equal(world.retreatPlans.retreatIdByUnitId.size, unitIds.length);
});

test("OffensiveOperation membership is released before retreat membership", () => {
  const world = createOperationWorld();
  updateOffensiveOperations(world);
  const operation = onlyOperation(world, NATION_A);
  planFor(world, NATION_A).posture = "retreat";
  updateRetreatPlans(world);
  world.time.fastTick += WORLD_BALANCE.war.landFront.retreat.persistenceTicks;
  updateRetreatPlans(world);
  const retreat = onlyRetreat(world);

  assert.equal(operation.outcome, "cancelled");
  for (const unitId of [
    ...retreat.rearguardUnitIds,
    ...retreat.retreatingUnitIds,
  ]) {
    assert.equal(getOffensiveOperationForUnit(world, unitId), undefined);
  }
});

test("fallback regions remain under friendly effective control", () => {
  const world = createRetreatWorld();
  const retreat = onlyRetreat(world);
  const ownerByRegion = new Map<MesoRegionId, NationId>();
  for (const macro of world.macroRegions) {
    for (const regionId of macro.mesoRegionIds) ownerByRegion.set(regionId, macro.nationId);
  }

  assert(
    retreat.fallbackRegionIds.every(
      (regionId) =>
        (world.occupation.mesoById.get(regionId) ?? ownerByRegion.get(regionId)) ===
        NATION_A,
    ),
  );
});

test("fallback selection excludes sea regions", () => {
  const world = createRetreatCandidateWorld();
  const capital = world.mesoRegions.find((region) => region.id === id("a-cap"));
  assert(capital);
  capital.type = "sea";

  updateRetreatPlans(world);

  assert(
    onlyRetreat(world).fallbackRegionIds.every(
      (regionId) => world.mesoRegions.find((region) => region.id === regionId)?.type !== "sea",
    ),
  );
});

test("fallback selection excludes regions occupied by enemy units", () => {
  const world = createRetreatCandidateWorld();
  addLandUnit(world, NATION_B, "a-cap", "Infantry");

  updateRetreatPlans(world);

  assert(!onlyRetreat(world).fallbackRegionIds.includes(id("a-cap")));
});

test("fallback regions form a compact cluster", () => {
  const world = createRetreatWorld();
  const fallback = onlyRetreat(world).fallbackRegionIds;

  assert(fallback.length >= 1 && fallback.length <= 3);
  for (const regionId of fallback) {
    assert(isWithinTestDistance(world, fallback[0], regionId, 2));
  }
});

test("withdrawing units do not pursue enemy Front targets", () => {
  const world = createRetreatWorld();
  const retreat = onlyRetreat(world);
  repositionUnits(world, 100);
  const unitById = new Map(world.units.map((unit) => [unit.id, unit]));

  for (const unitId of retreat.retreatingUnitIds) {
    assert(retreat.fallbackRegionIds.includes(unitById.get(unitId)?.moveTargetId ?? id("")));
    assert.notEqual(unitById.get(unitId)?.moveTargetId, id("b-front"));
  }
});

test("withdrawing units prioritize their assigned fallback targets", () => {
  const world = createRetreatWorld();
  const retreat = onlyRetreat(world);
  repositionUnits(world, 100);
  const unitById = new Map(world.units.map((unit) => [unit.id, unit]));

  for (const [unitId, targetId] of retreat.unitTargetRegionIds) {
    assert.equal(unitById.get(unitId)?.moveTargetId, targetId);
  }
});

test("an active retreat safely survives disappearance of its original Front", () => {
  const world = createRetreatWorld();
  const retreatId = onlyRetreat(world).id;
  world.landFronts.physicalFronts = [];
  world.landFronts.physicalFrontsById.clear();

  updateRetreatPlans(world);

  assert.equal(getRetreatPlans(world)[0]?.id, retreatId);
});

test("war end cancels and archives an active retreat", () => {
  const world = createRetreatWorld();
  world.wars = [];

  updateRetreatPlans(world);

  assert.equal(getRetreatPlans(world).length, 0);
  assert.equal(world.retreatPlans.history.at(-1)?.completionReason, "war-ended");
});

test("nation elimination cleans up an active retreat", () => {
  const world = createRetreatWorld();
  const nation = world.nations.find((candidate) => candidate.id === NATION_A);
  assert(nation);
  nation.macroRegionIds = [];

  updateRetreatPlans(world);

  assert.equal(getRetreatPlans(world).length, 0);
  assert.equal(
    world.retreatPlans.history.at(-1)?.completionReason,
    "nation-eliminated",
  );
});

test("regrouping units do not immediately enter a new offensive operation", () => {
  const world = createRetreatWorld();
  const retreat = onlyRetreat(world);
  moveRetreatingForceToFallback(world, retreat);
  updateRetreatPlans(world);
  assert.equal(retreat.phase, "regrouping");
  planFor(world, NATION_A).posture = "attack";

  updateNationFrontAllocations(world);
  updateOffensiveOperations(world);

  assert.equal(getOffensiveOperations(world, NATION_A).length, 0);
});

test("completed retreat units return to normal Front allocation", () => {
  const world = createRetreatWorld();
  const retreat = onlyRetreat(world);
  const retreatingIds = [...retreat.retreatingUnitIds];
  moveRetreatingForceToFallback(world, retreat);
  updateRetreatPlans(world);
  world.time.fastTick += WORLD_BALANCE.war.landFront.retreat.regroupTicks;
  updateRetreatPlans(world);
  planFor(world, NATION_A).posture = "hold";
  updateNationFrontAllocations(world);

  assert.equal(getRetreatPlans(world).length, 0);
  assert(retreatingIds.some((unitId) => getAllocatedFrontId(world, unitId)));
});

test("all RetreatPlan region references are valid", () => {
  const world = createRetreatWorld();
  const validRegionIds = new Set(world.mesoRegions.map((region) => region.id));

  for (const retreat of getRetreatPlans(world)) {
    assert(retreat.fallbackRegionIds.every((regionId) => validRegionIds.has(regionId)));
    assert(
      [...retreat.unitTargetRegionIds.values()].every((regionId) =>
        validRegionIds.has(regionId),
      ),
    );
  }
});

test("RetreatPlan numeric state contains no NaN or Infinity", () => {
  const world = createRetreatWorld();
  const retreat = onlyRetreat(world);
  for (const value of [
    retreat.createdAtTick,
    retreat.startedAtTick,
    retreat.phaseStartedAtTick,
    retreat.initialUnitCount,
    retreat.initialRearguardUnitCount,
    retreat.initialRetreatingUnitCount,
    retreat.initialFriendlyStrength,
    retreat.initialEnemyStrength,
    retreat.initialRearguardStrength,
    retreat.initialRetreatingStrength,
    retreat.currentRetreatingStrength,
    retreat.arrivedUnitCount,
    retreat.arrivedStrength,
  ]) {
    assert(Number.isFinite(value));
  }
  assert.match(formatRetreatPlanSummary(world), /fallback:/);
});

test("naval units never enter RetreatPlans", () => {
  const world = createRetreatCandidateWorld();
  const naval = createUnitForType(
    createUnitId(world.unitIdCounter),
    NATION_A,
    id("a-cap"),
    "CombatShip",
  );
  world.unitIdCounter += 1;
  world.units.push(naval);
  updateNationFrontAllocations(world);
  updateRetreatPlans(world);

  assert.equal(getRetreatPlanForUnit(world, naval.id), undefined);
});

test("retreat movement creates no path loop", () => {
  const world = createRetreatWorld();
  for (let tick = 0; tick < 40; tick += 1) {
    world.time.fastTick += 1;
    repositionUnits(world, 100);
  }

  for (const unit of world.units.filter((candidate) => candidate.domain === "land")) {
    assert(Number.isFinite(unit.moveProgressMs));
    assert(unit.moveFromId === null || unit.moveFromId !== unit.moveToId);
  }
});

test("active retreat units are temporarily unavailable to Front allocation", () => {
  const world = createRetreatWorld();
  const retreat = onlyRetreat(world);
  const committed = [
    ...retreat.rearguardUnitIds,
    ...retreat.retreatingUnitIds,
  ];

  updateNationFrontAllocations(world);

  assert(committed.every((unitId) => !world.frontAllocations.frontIdByUnitId.has(unitId)));
});

test("RetreatPlan creation and fallback assignment are fixed-seed deterministic", () => {
  const worldA = createRetreatWorld();
  const worldB = createRetreatWorld();
  const retreatA = onlyRetreat(worldA);
  const retreatB = onlyRetreat(worldB);

  assert.deepEqual(
    {
      rearguard: retreatA.rearguardUnitIds,
      withdrawing: retreatA.retreatingUnitIds,
      fallback: retreatA.fallbackRegionIds,
      targets: [...retreatA.unitTargetRegionIds],
    },
    {
      rearguard: retreatB.rearguardUnitIds,
      withdrawing: retreatB.retreatingUnitIds,
      fallback: retreatB.fallbackRegionIds,
      targets: [...retreatB.unitTargetRegionIds],
    },
  );
});

test("a capital-threatened Front suppresses non-catastrophic retreat", () => {
  const world = createCapitalDefenseWorld(20, 200);
  const plan = planFor(world, NATION_A);

  assert.equal(getCapitalDefenseAssessment(world, NATION_A)?.threatLevel, "critical");
  assert.equal(plan.posture, "reinforce");
});

test("a capital emergency raises the threatened Front priority", () => {
  const world = createCapitalDefenseWorld(20, 200);
  assert(planFor(world, NATION_A).priority >= 95);
});

test("a capital emergency raises desired strength to the defense minimum", () => {
  const world = createCapitalDefenseWorld(20, 200);
  const front = getPhysicalFrontsForNation(world, NATION_A)[0];
  const enemy = front ? getFrontSide(front, NATION_B) : undefined;
  const plan = planFor(world, NATION_A);

  assert(enemy);
  assert(
    plan.desiredStrength >=
      enemy.strength *
        WORLD_BALANCE.war.landFront.capitalDefense.enemyStrengthMultiplier,
  );
});

test("capital defense zone contains only valid friendly land regions", () => {
  const world = createCapitalDefenseWorld(20, 200);
  world.occupation.mesoById.set(id("a-zone"), NATION_B);
  world.occupation.version += 1;
  updateFrontSystem(world);
  const assessment = getCapitalDefenseAssessment(world, NATION_A);
  const mesoById = new Map(world.mesoRegions.map((region) => [region.id, region]));
  const ownerByMesoId = new Map(
    world.macroRegions.flatMap((macro) =>
      macro.mesoRegionIds.map((regionId) => [regionId, macro.nationId] as const),
    ),
  );

  assert(assessment);
  assert(!assessment.defenseRegionIds.includes(id("a-zone")));
  for (const regionId of assessment.defenseRegionIds) {
    assert.notEqual(mesoById.get(regionId)?.type, "sea");
    assert.equal(
      world.occupation.mesoById.get(regionId) ?? ownerByMesoId.get(regionId),
      NATION_A,
    );
  }
});

test("catastrophic capital retreat falls back into the capital defense zone", () => {
  const world = createCapitalDefenseWorld(4, 200);
  updateRetreatPlans(world);
  const retreat = onlyRetreat(world);
  const assessment = getCapitalDefenseAssessment(world, NATION_A);

  assert(assessment);
  assert(retreat.capitalDefenseFallback);
  assert(retreat.fallbackRegionIds.includes(id("a-cap")));
  assert(
    retreat.fallbackRegionIds.every((regionId) =>
      assessment.defenseRegionIds.includes(regionId),
    ),
  );
});

test("an enemy on the capital forces fallback to a safe defense-zone neighbor", () => {
  const world = createCapitalDefenseWorld(4, 200);
  setUnitStrength(addLandUnit(world, NATION_B, "a-cap", "Infantry"), 50);
  updateFrontSystem(world);
  updateNationFrontAllocations(world);
  updateRetreatPlans(world);
  const retreat = onlyRetreat(world);
  const assessment = getCapitalDefenseAssessment(world, NATION_A);

  assert(assessment);
  assert(!retreat.fallbackRegionIds.includes(id("a-cap")));
  assert(
    retreat.fallbackRegionIds.some((regionId) =>
      assessment.defenseRegionIds.includes(regionId),
    ),
  );
});

test("capital retreat keeps a larger rearguard share", () => {
  const world = createCapitalDefenseWorld(4, 200);
  updateRetreatPlans(world);
  const retreat = onlyRetreat(world);
  const share =
    retreat.initialRearguardStrength /
    (retreat.initialRearguardStrength + retreat.initialRetreatingStrength);

  assert(
    share >=
      WORLD_BALANCE.war.landFront.capitalDefense
        .criticalMinimumRearguardStrengthFraction,
    `expected capital rearguard share >= minimum; received ${share}`,
  );
  assert(
    share <=
      WORLD_BALANCE.war.landFront.capitalDefense
        .criticalMaximumRearguardStrengthFraction +
        0.01,
    `expected capital rearguard share <= maximum; received ${share}`,
  );
});

test("critical capital allocation can drain a low-priority distant Front", () => {
  const world = createCapitalReallocationWorld();
  const farFront = getPhysicalFrontsForNation(world, NATION_A).find((front) =>
    getFrontSide(front, NATION_C),
  );

  assert(farFront);
  assert.equal(
    getNationFrontAllocations(world, NATION_A).find(
      (allocation) => allocation.frontId === farFront.id,
    )?.unitIds.length,
    0,
  );
  assert(world.capitalDefense.reallocatedUnitCount > 0);
});

test("normal minimum Front coverage returns after capital emergency ends", () => {
  const world = createCapitalReallocationWorld();
  const capital = world.mesoRegions.find((region) => region.id === id("a-cap"));
  assert(capital);
  capital.building = null;
  world.buildingVersion += 1;
  updateCapitalDefense(world);
  updateNationFrontPlans(world);
  updateNationFrontAllocations(world);
  const farFront = getPhysicalFrontsForNation(world, NATION_A).find((front) =>
    getFrontSide(front, NATION_C),
  );

  assert(farFront);
  assert(
    (getNationFrontAllocations(world, NATION_A).find(
      (allocation) => allocation.frontId === farFront.id,
    )?.unitIds.length ?? 0) >= 1,
  );
});

test("an existing RetreatPlan retargets once when capital emergency begins", () => {
  const world = createCapitalRetargetWorld();
  const retreat = onlyRetreat(world);
  const previousFallback = [...retreat.fallbackRegionIds];
  const capital = world.mesoRegions.find((region) => region.id === id("a-front"));
  const nation = world.nations.find((candidate) => candidate.id === NATION_A);
  assert(capital && nation);
  capital.building = "capital";
  nation.capitalMesoId = capital.id;
  world.buildingVersion += 1;
  updateFrontSystem(world);
  updateRetreatPlans(world);
  const updated = onlyRetreat(world);
  const timelineLength = world.retreatPlans.timeline.length;

  assert(updated.capitalDefenseFallback);
  assert.notDeepEqual(updated.fallbackRegionIds, previousFallback);
  assert(updated.fallbackRegionIds.includes(id("a-front")));
  updateRetreatPlans(world);
  assert.equal(world.retreatPlans.timeline.length, timelineLength);
});

test("critical capital emergency cancels an offensive operation", () => {
  const world = createOperationWorld();
  updateOffensiveOperations(world);
  const capital = world.mesoRegions.find((region) => region.id === id("a"));
  const nation = world.nations.find((candidate) => candidate.id === NATION_A);
  assert(capital && nation);
  capital.building = "capital";
  nation.capitalMesoId = capital.id;
  world.buildingVersion += 1;
  updateCapitalDefense(world);

  assert.equal(cancelOffensiveOperationsForCapitalEmergency(world), 1);
  const operation = onlyOperation(world, NATION_A);
  assert.equal(operation.phase, "recovering");
  assert.equal(operation.completionReason, "capital-emergency");
});

test("a minor capital threat does not cancel an offensive operation", () => {
  const world = createMinorCapitalThreatOperationWorld();
  updateOffensiveOperations(world);
  const operation = onlyOperation(world, NATION_A);

  assert.equal(getCapitalDefenseAssessment(world, NATION_A)?.threatLevel, "threatened");
  assert.equal(cancelOffensiveOperationsForCapitalEmergency(world), 0);
  assert.notEqual(operation.phase, "recovering");
});

test("capital retreat units never overlap offensive operation membership", () => {
  const world = createCapitalDefenseWorld(4, 200);
  updateRetreatPlans(world);
  updateOffensiveOperations(world);
  for (const unitId of [
    ...onlyRetreat(world).rearguardUnitIds,
    ...onlyRetreat(world).retreatingUnitIds,
  ]) {
    assert.equal(getOffensiveOperationForUnit(world, unitId), undefined);
  }
});

test("capital fallback and unit targets always reference valid regions", () => {
  const world = createCapitalDefenseWorld(4, 200);
  updateRetreatPlans(world);
  const retreat = onlyRetreat(world);
  const validIds = new Set(world.mesoRegions.map((region) => region.id));

  assert(retreat.fallbackRegionIds.every((regionId) => validIds.has(regionId)));
  assert(
    [...retreat.unitTargetRegionIds.values()].every((regionId) =>
      validIds.has(regionId),
    ),
  );
});

test("naval units never enter capital defense allocation or retreat", () => {
  const world = createCapitalDefenseWorld(4, 200);
  const naval = createUnitForType(
    createUnitId(world.unitIdCounter),
    NATION_A,
    id("a-cap"),
    "CombatShip",
  );
  world.unitIdCounter += 1;
  world.units.push(naval);
  updateFrontSystem(world);
  updateNationFrontAllocations(world);
  updateRetreatPlans(world);

  assert(
    !getCapitalDefenseAssessment(world, NATION_A)?.friendlyUnitIds.includes(
      naval.id,
    ),
  );
  assert.equal(getRetreatPlanForUnit(world, naval.id), undefined);
  assert.equal(getAllocatedFrontId(world, naval.id), undefined);
});

test("capital defense decisions are fixed-seed deterministic", () => {
  const worldA = createCapitalDefenseWorld(4, 200);
  const worldB = createCapitalDefenseWorld(4, 200);
  updateRetreatPlans(worldA);
  updateRetreatPlans(worldB);

  assert.deepEqual(
    {
      assessment: getCapitalDefenseAssessment(worldA, NATION_A),
      plan: planFor(worldA, NATION_A),
      allocation: getNationFrontAllocations(worldA, NATION_A),
      retreat: onlyRetreat(worldA),
    },
    {
      assessment: getCapitalDefenseAssessment(worldB, NATION_A),
      plan: planFor(worldB, NATION_A),
      allocation: getNationFrontAllocations(worldB, NATION_A),
      retreat: onlyRetreat(worldB),
    },
  );
});

test("a small nation does not form a Strategic Reserve", () => {
  const world = createReserveWorld(3, 2, 3);
  updateStrategicReserves(world);
  assert.equal(getNationReserveState(world, NATION_A), undefined);
});

test("a normal nation deliberately forms a Strategic Reserve", () => {
  const world = createFormedReserveWorld();
  const reserve = getNationReserveState(world, NATION_A);
  assert(reserve);
  assert(reserve.unitIds.length > 0);
  assert(reserve.totalStrength > 0);
  assert(reserve.desiredReserveStrength > 0);
  assert.match(formatStrategicReserveSummary(world), /Strategic Reserve/);
});

test("an idle Strategic Reserve concentrates on the selected Schwerpunkt", () => {
  const world = createFormedReserveWorld();
  for (let tick = 0; tick < 20; tick += 1) {
    world.time.fastTick += 10;
    updateStalematePressure(world);
  }
  const focus = getNationSchwerpunkt(world, NATION_A);
  assert(focus?.schwerpunktSectorId);
  updateStrategicReserves(world);
  const deployment = getNationReserveState(world, NATION_A)?.deployment;
  assert(deployment);
  assert.equal(deployment.targetFrontId, focus.schwerpunktSectorId);
  assert(deployment.reasonFlags.includes("schwerpunkt-concentration"));
});

test("Reserve membership never overlaps Front Allocation", () => {
  const world = createFormedReserveWorld();
  const reserve = getNationReserveState(world, NATION_A);
  assert(reserve);
  for (const unitId of reserve.unitIds) {
    assert.equal(getAllocatedFrontId(world, unitId), undefined);
  }
});

test("Reserve membership never overlaps OffensiveOperation", () => {
  const world = createFormedReserveWorld();
  updateOffensiveOperations(world);
  const reserveIds = new Set(
    getNationReserveState(world, NATION_A)?.unitIds ?? [],
  );
  for (const unitId of world.offensiveOperations.operationIdByUnitId.keys()) {
    assert(!reserveIds.has(unitId));
  }
});

test("Reserve membership never overlaps RetreatPlan", () => {
  const world = createRetreatSupportedReserveWorld();
  const reserveIds = new Set(
    getNationReserveState(world, NATION_A)?.unitIds ?? [],
  );
  for (const unitId of world.retreatPlans.retreatIdByUnitId.keys()) {
    assert(!reserveIds.has(unitId));
  }
});

test("Reserve staging regions are safe friendly land away from the Front", () => {
  const world = createFormedReserveWorld();
  const reserve = getNationReserveState(world, NATION_A);
  assert(reserve);
  const frontRegions = new Set(
    getPhysicalFrontsForNation(world, NATION_A).flatMap(
      (front) => getFrontSide(front, NATION_A)?.borderRegionIds ?? [],
    ),
  );
  for (const regionId of reserve.stagingRegionIds) {
    const region = world.mesoRegions.find((candidate) => candidate.id === regionId);
    const macro = world.macroRegions.find((candidate) =>
      candidate.mesoRegionIds.includes(regionId),
    );
    assert(region && region.type !== "sea");
    assert.equal(world.occupation.mesoById.get(regionId) ?? macro?.nationId, NATION_A);
    assert(!frontRegions.has(regionId));
    assert(!world.units.some((unit) => unit.nationId === NATION_B && unit.regionId === regionId));
  }
});

test("critical Capital Emergency deploys the entire Reserve", () => {
  const world = createCriticalReserveWorld();
  const reserve = getNationReserveState(world, NATION_A);
  assert(reserve?.deployment);
  assert.equal(reserve.deployment.targetType, "capital-defense");
  assert.deepEqual(reserve.deployment.unitIds, reserve.unitIds);
  assert(reserve.deployment.reasonFlags.includes("capital-critical"));
});

test("a merely threatened capital does not deploy the entire Reserve", () => {
  const world = createFormedReserveWorld();
  setTestCapital(world, NATION_A, "a-fallback");
  updateCapitalDefense(world);
  assert.equal(getCapitalDefenseAssessment(world, NATION_A)?.threatLevel, "threatened");
  updateNationFrontPlans(world);
  updateNationFrontAllocations(world);
  updateStrategicReserves(world);
  const reserve = getNationReserveState(world, NATION_A);
  assert(reserve);
  assert(
    !reserve.deployment || reserve.deployment.unitIds.length < reserve.unitIds.length,
  );
});

test("a severe reinforce deficit receives a bounded Reserve detachment", () => {
  const world = createReinforceReserveWorld();
  const reserve = getNationReserveState(world, NATION_A);
  assert(reserve?.deployment);
  assert.equal(reserve.deployment.targetType, "front-reinforcement");
  const allocation = getNationFrontAllocations(world, NATION_A).find(
    (candidate) => candidate.frontId === reserve.deployment?.targetFrontId,
  );
  assert(allocation);
  const deployedStrength = reserve.deployment.unitIds.reduce((total, unitId) => {
    const unit = world.units.find((candidate) => candidate.id === unitId);
    return total + (unit ? getUnitCombatStrength(unit) : 0);
  }, 0);
  const largestUnit = Math.max(
    ...reserve.deployment.unitIds.map((unitId) => {
      const unit = world.units.find((candidate) => candidate.id === unitId);
      return unit ? getUnitCombatStrength(unit) : 0;
    }),
  );
  assert(deployedStrength <= allocation.deficit * 1.1 + largestUnit);
});

test("Reserve moves ahead to an active Retreat fallback", () => {
  const world = createRetreatSupportedReserveWorld();
  const retreat = getRetreatPlans(world, NATION_A)[0];
  const reserve = getNationReserveState(world, NATION_A);
  assert(retreat && reserve?.deployment);
  assert.equal(reserve.deployment.targetType, "retreat-support");
  repositionUnits(world, 0);
  for (const unitId of reserve.deployment.unitIds) {
    const unit = world.units.find((candidate) => candidate.id === unitId);
    assert(unit?.moveTargetId);
    assert(retreat.fallbackRegionIds.includes(unit.moveTargetId));
  }
});

test("a deployed Reserve never targets an unrelated Front", () => {
  const world = createRetreatSupportedReserveWorld();
  const retreat = getRetreatPlans(world, NATION_A)[0];
  const reserve = getNationReserveState(world, NATION_A);
  assert(retreat && reserve?.deployment);
  for (const unitId of reserve.deployment.unitIds) {
    const target = getReserveTargetForUnit(reserve, unitId);
    assert(target && retreat.fallbackRegionIds.includes(target));
  }
});

test("a collapsed Front deploys Reserve to its replacement line", () => {
  const world = createFormedReserveWorld();
  for (let index = 0; index < 40; index += 1) {
    addLandUnit(world, NATION_B, "b-front", "Infantry");
  }
  updateFrontSystem(world);
  updateNationFrontAllocations(world);
  updateRetreatPlans(world);
  const retreat = getRetreatPlans(world, NATION_A)[0];
  assert(retreat?.reasonFlags.includes("front-collapse"));
  world.occupation.mesoById.set(id("a-front"), NATION_B);
  world.occupation.version += 1;
  updateFrontSystem(world);
  updateNationFrontAllocations(world);
  updateStrategicReserves(world);
  const reserve = getNationReserveState(world, NATION_A);
  assert.equal(reserve?.deployment?.targetType, "front-collapse");
  assert(reserve.deployment.targetFrontId);
  assert(world.landFronts.physicalFrontsById.has(reserve.deployment.targetFrontId));
});

test("resolved deployment returns Reserve units to staging", () => {
  const world = createReinforceReserveWorld();
  const reserve = getNationReserveState(world, NATION_A);
  assert(reserve?.deployment);
  world.wars = [];
  world.time.fastTick += 100;
  updateStrategicReserves(world);
  assert.equal(reserve.status, "returning");
  moveReserveToStaging(world, reserve);
  updateStrategicReserves(world);
  assert.equal(reserve.status, "ready");
  assert.equal(reserve.deployment, undefined);
});

test("returning Reserve units cannot be reclaimed by Front Allocation", () => {
  const world = createReinforceReserveWorld();
  const reserve = getNationReserveState(world, NATION_A);
  assert(reserve?.deployment);
  world.wars = [];
  world.time.fastTick += 100;
  updateStrategicReserves(world);
  updateNationFrontAllocations(world);
  for (const unitId of reserve.unitIds) {
    assert.equal(getAllocatedFrontId(world, unitId), undefined);
  }
});

test("critical emergency does not reform depleted Reserve membership", () => {
  const world = createCriticalReserveWorld();
  const reserve = getNationReserveState(world, NATION_A);
  assert(reserve && reserve.unitIds.length > 0);
  const removedId = reserve.unitIds[0];
  const before = reserve.unitIds.length;
  world.units = world.units.filter((unit) => unit.id !== removedId);
  updateStrategicReserves(world);
  assert.equal(reserve.unitIds.length, before - 1);
});

test("a new land unit can fill a Reserve shortfall", () => {
  const world = createFormedReserveWorld();
  const reserve = getNationReserveState(world, NATION_A);
  assert(reserve && reserve.unitIds.length > 0);
  const removedId = reserve.unitIds[0];
  world.units = world.units.filter((unit) => unit.id !== removedId);
  const replacement = addLandUnit(world, NATION_A, "a-rear", "Infantry");
  updateStrategicReserves(world);
  assert(reserve.unitIds.includes(replacement.id));
});

test("stable Reserve membership does not oscillate every evaluation", () => {
  const world = createFormedReserveWorld();
  const reserve = getNationReserveState(world, NATION_A);
  assert(reserve);
  const initial = [...reserve.unitIds];
  for (let index = 0; index < 5; index += 1) {
    world.time.fastTick += 10;
    updateStrategicReserves(world);
    updateNationFrontAllocations(world);
  }
  assert.deepEqual(reserve.unitIds, initial);
});

test("inactive nation Reserve state is cleaned up", () => {
  const world = createFormedReserveWorld();
  const nation = world.nations.find((candidate) => candidate.id === NATION_A);
  assert(nation);
  nation.macroRegionIds = [];
  updateStrategicReserves(world);
  assert.equal(getNationReserveState(world, NATION_A), undefined);
});

test("war end cleans up active Reserve deployment", () => {
  const world = createReinforceReserveWorld();
  const reserve = getNationReserveState(world, NATION_A);
  assert(reserve?.deployment);
  world.wars = [];
  world.time.fastTick += 100;
  updateStrategicReserves(world);
  assert.equal(reserve.deployment?.status, "returning");
  assert.equal(reserve.status, "returning");
});

test("Reserve staging and deployment references are always valid", () => {
  const world = createCriticalReserveWorld();
  const validIds = new Set(world.mesoRegions.map((region) => region.id));
  const reserve = getNationReserveState(world, NATION_A);
  assert(reserve);
  for (const regionId of [
    ...reserve.stagingRegionIds,
    ...(reserve.deployment?.targetRegionIds ?? []),
  ]) {
    assert(validIds.has(regionId));
  }
});

test("naval units never enter Strategic Reserve", () => {
  const world = createReserveWorld(10, 8, 12);
  const naval = addUnit(world, NATION_A, "a-cap", "CombatShip");
  updateStrategicReserves(world);
  assert(!getNationReserveState(world, NATION_A)?.unitIds.includes(naval.id));
});

test("Strategic Reserve numeric state never contains NaN or Infinity", () => {
  const world = createReinforceReserveWorld();
  const reserve = getNationReserveState(world, NATION_A);
  assert(reserve);
  for (const value of [
    reserve.totalStrength,
    reserve.desiredReserveStrength,
    reserve.cooldownUntilTick,
    reserve.deployment?.startedAtTick ?? 0,
    reserve.deployment?.initialTargetDeficit ?? 0,
    reserve.deployment?.lastEffectiveDeficit ?? 0,
  ]) {
    assert(Number.isFinite(value));
  }
});

test("Strategic Reserve decisions are fixed-seed deterministic", () => {
  const worldA = createReinforceReserveWorld();
  const worldB = createReinforceReserveWorld();
  assert.deepEqual(
    reserveDecisionSnapshot(worldA, NATION_A),
    reserveDecisionSnapshot(worldB, NATION_A),
  );
});

function createReserveWorld(
  friendlyFrontUnits: number,
  enemyFrontUnits: number,
  totalFriendlyUnits: number,
): WorldState {
  const world = createFrontWorld(
    [
      { id: "a-cap", owner: NATION_A, building: "capital" },
      { id: "a-stage", owner: NATION_A, building: "city" },
      { id: "a-rear", owner: NATION_A },
      { id: "a-fallback", owner: NATION_A },
      { id: "a-front", owner: NATION_A },
      { id: "b-front", owner: NATION_B, building: "capital" },
    ],
    [
      ["a-cap", "a-stage"],
      ["a-stage", "a-rear"],
      ["a-stage", "a-fallback"],
      ["a-fallback", "a-front"],
      ["a-front", "b-front"],
    ],
  );
  startWar(world, NATION_A, NATION_B);
  for (let index = 0; index < friendlyFrontUnits; index += 1) {
    addLandUnit(world, NATION_A, "a-front", "Infantry");
  }
  for (
    let index = friendlyFrontUnits;
    index < totalFriendlyUnits;
    index += 1
  ) {
    addLandUnit(world, NATION_A, "a-rear", "Infantry");
  }
  for (let index = 0; index < enemyFrontUnits; index += 1) {
    addLandUnit(world, NATION_B, "b-front", "Infantry");
  }
  updateAllocationSystem(world);
  return world;
}

function createFormedReserveWorld(): WorldState {
  const world = createReserveWorld(10, 8, 12);
  updateStrategicReserves(world);
  updateNationFrontAllocations(world);
  const reserve = getNationReserveState(world, NATION_A);
  assert(reserve && reserve.unitIds.length > 0);
  return world;
}

function createReinforceReserveWorld(): WorldState {
  const world = createFormedReserveWorld();
  for (let index = 0; index < 16; index += 1) {
    addLandUnit(world, NATION_B, "b-front", "Infantry");
  }
  updateFrontSystem(world);
  updateNationFrontAllocations(world);
  assert.equal(planFor(world, NATION_A).posture, "reinforce");
  updateStrategicReserves(world);
  return world;
}

function createCriticalReserveWorld(): WorldState {
  const world = createFormedReserveWorld();
  addLandUnit(world, NATION_B, "a-stage", "Infantry");
  updateCapitalDefense(world);
  assert.equal(getCapitalDefenseAssessment(world, NATION_A)?.threatLevel, "critical");
  updateNationFrontPlans(world);
  updateNationFrontAllocations(world);
  updateStrategicReserves(world);
  return world;
}

function createRetreatSupportedReserveWorld(): WorldState {
  const world = createFormedReserveWorld();
  for (let index = 0; index < 40; index += 1) {
    addLandUnit(world, NATION_B, "b-front", "Infantry");
  }
  updateFrontSystem(world);
  updateNationFrontAllocations(world);
  assert.equal(planFor(world, NATION_A).posture, "retreat");
  updateRetreatPlans(world);
  const retreat = getRetreatPlans(world, NATION_A)[0];
  assert(retreat);
  const pressureRegionId = retreat.fallbackRegionIds[0];
  assert(pressureRegionId);
  const pressureRegion = world.mesoRegions.find(
    (region) => region.id === pressureRegionId,
  );
  assert(pressureRegion);
  addUnitAtRegion(world, NATION_B, pressureRegion.id, "Infantry");
  updateStrategicReserves(world);
  return world;
}

function setTestCapital(
  world: WorldState,
  nationId: NationId,
  regionId: string,
): void {
  const nation = world.nations.find((candidate) => candidate.id === nationId);
  const previous = world.mesoRegions.find(
    (region) => region.id === nation?.capitalMesoId,
  );
  const next = world.mesoRegions.find((region) => region.id === id(regionId));
  assert(nation && next);
  if (previous && previous.id !== next.id) previous.building = "city";
  next.building = "capital";
  nation.capitalMesoId = next.id;
  world.buildingVersion += 1;
}

function moveReserveToStaging(
  world: WorldState,
  reserve: NonNullable<ReturnType<typeof getNationReserveState>>,
): void {
  assert(reserve.stagingRegionIds.length > 0);
  for (let index = 0; index < reserve.unitIds.length; index += 1) {
    const unit = world.units.find(
      (candidate) => candidate.id === reserve.unitIds[index],
    );
    assert(unit);
    unit.regionId = reserve.stagingRegionIds[index % reserve.stagingRegionIds.length];
    unit.moveTargetId = unit.regionId;
    unit.moveFromId = null;
    unit.moveToId = null;
    unit.moveProgressMs = 0;
  }
}

function reserveDecisionSnapshot(world: WorldState, nationId: NationId) {
  const reserve = getNationReserveState(world, nationId);
  assert(reserve);
  return {
    unitIds: [...reserve.unitIds],
    totalStrength: reserve.totalStrength,
    desiredStrength: reserve.desiredReserveStrength,
    stagingRegionIds: [...reserve.stagingRegionIds],
    status: reserve.status,
    deployment: reserve.deployment
      ? {
          targetType: reserve.deployment.targetType,
          targetFrontId: reserve.deployment.targetFrontId,
          targetRegionIds: [...reserve.deployment.targetRegionIds],
          unitIds: [...reserve.deployment.unitIds],
          unitTargets: [...reserve.deployment.unitTargetRegionIds.entries()],
          reasonFlags: [...reserve.deployment.reasonFlags],
        }
      : null,
  };
}

function createCapitalDefenseWorld(
  friendlyFrontStrength: number,
  enemyFrontStrength: number,
): WorldState {
  const world = createFrontWorld(
    [
      { id: "a-cap", owner: NATION_A, building: "capital" },
      { id: "a-zone", owner: NATION_A },
      { id: "a-rear", owner: NATION_A },
      { id: "a-far", owner: NATION_A },
      { id: "b-front", owner: NATION_B },
    ],
    [
      ["b-front", "a-cap"],
      ["a-cap", "a-zone"],
      ["a-zone", "a-rear"],
      ["a-rear", "a-far"],
    ],
  );
  startWar(world, NATION_A, NATION_B);
  for (let index = 0; index < 4; index += 1) {
    setUnitStrength(
      addLandUnit(world, NATION_A, "a-cap", "Infantry"),
      friendlyFrontStrength / 4,
    );
    setUnitStrength(
      addLandUnit(world, NATION_A, "a-far", "Infantry"),
      friendlyFrontStrength / 4,
    );
    setUnitStrength(
      addLandUnit(world, NATION_B, "b-front", "Infantry"),
      enemyFrontStrength / 4,
    );
  }
  updateAllocationSystem(world);
  return world;
}

function createCapitalReallocationWorld(): WorldState {
  const world = createFrontWorld(
    [
      { id: "a-cap", owner: NATION_A },
      { id: "a-mid-1", owner: NATION_A },
      { id: "a-mid-2", owner: NATION_A },
      { id: "a-far", owner: NATION_A },
      { id: "b-front", owner: NATION_B },
      { id: "c-front", owner: NATION_C },
    ],
    [
      ["b-front", "a-cap"],
      ["a-cap", "a-mid-1"],
      ["a-mid-1", "a-mid-2"],
      ["a-mid-2", "a-far"],
      ["a-far", "c-front"],
    ],
  );
  startWar(world, NATION_A, NATION_B);
  startWar(world, NATION_A, NATION_C);
  for (let index = 0; index < 2; index += 1) {
    setUnitStrength(addLandUnit(world, NATION_A, "a-cap", "Infantry"), 10);
  }
  for (let index = 0; index < 4; index += 1) {
    setUnitStrength(addLandUnit(world, NATION_A, "a-far", "Infantry"), 10);
  }
  setUnitStrength(addLandUnit(world, NATION_B, "b-front", "Infantry"), 200);
  setUnitStrength(addLandUnit(world, NATION_C, "c-front", "Infantry"), 1);
  updateAllocationSystem(world);

  const capital = world.mesoRegions.find((region) => region.id === id("a-cap"));
  const nation = world.nations.find((candidate) => candidate.id === NATION_A);
  assert(capital && nation);
  capital.building = "capital";
  nation.capitalMesoId = capital.id;
  world.buildingVersion += 1;
  updateCapitalDefense(world);
  updateNationFrontPlans(world);
  updateNationFrontAllocations(world);
  return world;
}

function createCapitalRetargetWorld(): WorldState {
  const world = createFrontWorld(
    [
      { id: "a-city", owner: NATION_A, building: "city" },
      { id: "a-safe", owner: NATION_A },
      { id: "a-front", owner: NATION_A },
      { id: "b-front", owner: NATION_B },
    ],
    [
      ["a-city", "a-safe"],
      ["a-safe", "a-front"],
      ["a-front", "b-front"],
    ],
  );
  startWar(world, NATION_A, NATION_B);
  for (let index = 0; index < 8; index += 1) {
    setUnitStrength(addLandUnit(world, NATION_A, "a-front", "Infantry"), 5);
    setUnitStrength(addLandUnit(world, NATION_B, "b-front", "Infantry"), 100);
  }
  updateAllocationSystem(world);
  updateRetreatPlans(world);
  return world;
}

function createMinorCapitalThreatOperationWorld(): WorldState {
  const world = createFrontWorld(
    [
      { id: "a-cap", owner: NATION_A, building: "capital" },
      { id: "a-zone", owner: NATION_A },
      { id: "a-front", owner: NATION_A },
      { id: "b-front", owner: NATION_B },
    ],
    [
      ["a-cap", "a-zone"],
      ["a-zone", "a-front"],
      ["a-front", "b-front"],
    ],
  );
  startWar(world, NATION_A, NATION_B);
  for (let index = 0; index < 6; index += 1) {
    setUnitStrength(addLandUnit(world, NATION_A, "a-front", "Infantry"), 100);
  }
  for (let index = 0; index < 2; index += 1) {
    setUnitStrength(addLandUnit(world, NATION_B, "b-front", "Infantry"), 50);
  }
  updateAllocationSystem(world);
  return world;
}

function createRetreatCandidateWorld(): WorldState {
  const world = createFrontWorld(
    [
      { id: "a-cap", owner: NATION_A, building: "capital" },
      { id: "a-city", owner: NATION_A, building: "city" },
      { id: "a-safe", owner: NATION_A },
      { id: "a-alt", owner: NATION_A },
      { id: "a-front", owner: NATION_A },
      { id: "b-front", owner: NATION_B },
    ],
    [
      ["a-cap", "a-city"],
      ["a-city", "a-safe"],
      ["a-city", "a-alt"],
      ["a-safe", "a-alt"],
      ["a-safe", "a-front"],
      ["a-front", "b-front"],
    ],
  );
  startWar(world, NATION_A, NATION_B);
  for (let index = 0; index < 8; index += 1) {
    setUnitStrength(addLandUnit(world, NATION_A, "a-front", "Infantry"), 20);
    setUnitStrength(addLandUnit(world, NATION_B, "b-front", "Infantry"), 100);
  }
  updateAllocationSystem(world);
  return world;
}

function createRetreatWorld(): WorldState {
  const world = createRetreatCandidateWorld();
  updateRetreatPlans(world);
  assert.equal(getRetreatPlans(world, NATION_A).length, 1);
  return world;
}

function onlyRetreat(world: WorldState): RetreatPlan {
  const retreats = getRetreatPlans(world, NATION_A);
  assert.equal(retreats.length, 1);
  return retreats[0];
}

function moveRetreatingForceToFallback(
  world: WorldState,
  retreat: RetreatPlan,
): void {
  const fallbackId = retreat.fallbackRegionIds[0];
  assert(fallbackId);
  const retreatingIds = new Set(retreat.retreatingUnitIds);
  for (const unit of world.units) {
    if (!retreatingIds.has(unit.id)) continue;
    unit.regionId = retreat.unitTargetRegionIds.get(unit.id) ?? fallbackId;
    unit.moveTargetId = unit.regionId;
    unit.moveFromId = null;
    unit.moveToId = null;
    unit.moveProgressMs = 0;
  }
}

function createOperationWorld(): WorldState {
  const world = createFrontWorld(
    [
      { id: "a", owner: NATION_A },
      { id: "b", owner: NATION_B },
    ],
    [["a", "b"]],
  );
  startWar(world, NATION_A, NATION_B);
  for (let index = 0; index < 6; index += 1) {
    setUnitStrength(addLandUnit(world, NATION_A, "a", "Infantry"), 100);
  }
  for (let index = 0; index < 2; index += 1) {
    setUnitStrength(addLandUnit(world, NATION_B, "b", "Infantry"), 50);
  }
  updateAllocationSystem(world);
  return world;
}

function createCollapseAdvanceWorld(): WorldState {
  const world = createFrontWorld(
    [
      { id: "a", owner: NATION_A },
      { id: "b0", owner: NATION_B },
      { id: "b1", owner: NATION_B, building: "capital" },
      { id: "b2", owner: NATION_B, building: "city" },
      { id: "b3", owner: NATION_B },
    ],
    [["a", "b0"], ["b0", "b1"], ["b0", "b2"], ["b1", "b3"], ["b2", "b3"]],
  );
  startWar(world, NATION_A, NATION_B);
  for (let index = 0; index < 10; index += 1) setUnitStrength(addLandUnit(world, NATION_A, "a", "Infantry"), 300);
  updateAllocationSystem(world);
  const sector = world.landFronts.operationalSectors[0];
  assert(sector);
  world.stalematePressure.assessments = [{ nationId: NATION_A, enemyNationId: NATION_B, pressure: 0, staticTicks: 1, reasonFlags: ["artificial-inactivity"], artificialInactivity: true, artificialInactivityBlocker: "target-validity", collapseAdvanceCandidate: true, inactivityCategory: "artificial-inactivity", inactivityReason: "no-valid-target", nextEvaluationTick: world.time.fastTick + 1, targetValidityFailureReason: "no-valid-frontline-position", targetValidityOtherReason: null, schwerpunktSectorId: null, selectedAtTick: null, cooldownUntilTick: 0, lastOperationSuccessCount: 0, lastOperationFailureCount: 0, releasedSecondaryStrength: 0 }];
  return world;
}

function createOperationClusterWorld(): WorldState {
  const world = createFrontWorld(
    [
      { id: "a", owner: NATION_A },
      { id: "b0", owner: NATION_B },
      { id: "b1", owner: NATION_B, building: "capital" },
      { id: "b2", owner: NATION_B, building: "city" },
    ],
    [
      ["a", "b0"],
      ["b0", "b1"],
      ["b0", "b2"],
      ["b1", "b2"],
    ],
  );
  startWar(world, NATION_A, NATION_B);
  for (let index = 0; index < 8; index += 1) {
    setUnitStrength(addLandUnit(world, NATION_A, "a", "Infantry"), 100);
  }
  for (let index = 0; index < 2; index += 1) {
    setUnitStrength(addLandUnit(world, NATION_B, "b0", "Infantry"), 50);
  }
  updateAllocationSystem(world);
  return world;
}

function createExploitationPursuitWorld(): WorldState {
  const world = createFrontWorld(
    [
      { id: "a", owner: NATION_A },
      { id: "b0", owner: NATION_B },
      { id: "b1", owner: NATION_B, building: "city" },
      { id: "b2", owner: NATION_B },
    ],
    [
      ["a", "b0"],
      ["b0", "b1"],
      ["b1", "b2"],
    ],
  );
  startWar(world, NATION_A, NATION_B);
  for (let index = 0; index < 8; index += 1) {
    setUnitStrength(addLandUnit(world, NATION_A, "a", "Infantry"), 100);
  }
  setUnitStrength(addLandUnit(world, NATION_B, "b1", "Infantry"), 40);
  updateAllocationSystem(world);
  return world;
}

function prepareStrategicExploitationWorld(): {
  world: WorldState;
  operation: OffensiveOperation;
} {
  const world = createFrontWorld(
    [
      { id: "a", owner: NATION_A },
      { id: "b0", owner: NATION_B },
      { id: "city", owner: NATION_B, building: "city" },
      { id: "capital", owner: NATION_B, building: "capital" },
    ],
    [
      ["a", "b0"],
      ["b0", "city"],
      ["b0", "capital"],
    ],
  );
  startWar(world, NATION_A, NATION_B);
  for (let index = 0; index < 8; index += 1) {
    setUnitStrength(addLandUnit(world, NATION_A, "a", "Infantry"), 100);
  }
  updateAllocationSystem(world);
  updateFrontlineCoverage(world);
  updateOffensiveOperations(world);
  const operation = onlyOperation(world, NATION_A);
  operation.primaryTargetRegionId = id("b0");
  operation.supportingTargetRegionIds = [];
  advanceOperationEvaluation(
    world,
    WORLD_BALANCE.war.landFront.offensiveOperation.minimumPreparationTicks,
  );
  world.occupation.mesoById.set(id("b0"), NATION_A);
  world.occupation.version += 1;
  updateAllocationSystem(world);
  updateFrontlineCoverage(world);
  return { world, operation };
}

function createGapExploitationWorld(): WorldState {
  const specs: RegionSpec[] = [];
  const edges: Edge[] = [];
  for (let index = 0; index < 5; index += 1) {
    specs.push(
      { id: `a${index}`, owner: NATION_A },
      { id: `b${index}`, owner: NATION_B },
    );
    edges.push([`a${index}`, `b${index}`]);
    if (index > 0) {
      edges.push(
        [`a${index - 1}`, `a${index}`],
        [`b${index - 1}`, `b${index}`],
      );
    }
  }
  const world = createFrontWorld(specs, edges);
  startWar(world, NATION_A, NATION_B);
  for (let index = 0; index < 10; index += 1) {
    setUnitStrength(addLandUnit(world, NATION_A, "a2", "Infantry"), 100);
  }
  setUnitStrength(addLandUnit(world, NATION_B, "b0", "Infantry"), 100);
  setUnitStrength(addLandUnit(world, NATION_B, "b4", "Infantry"), 100);
  updateAllocationSystem(world);
  return world;
}

function onlyOperation(world: WorldState, nationId: NationId): OffensiveOperation {
  const operations = getOffensiveOperations(world, nationId);
  assert.equal(operations.length, 1);
  return operations[0];
}

function advanceOperationEvaluation(world: WorldState, fastTicks: number): void {
  world.time.fastTick += fastTicks;
  updateOffensiveOperations(world);
}

function isWithinTestDistance(
  world: WorldState,
  startId: MesoRegionId,
  targetId: MesoRegionId,
  maxDistance: number,
): boolean {
  const mesoById = new Map(world.mesoRegions.map((region) => [region.id, region]));
  const queue: Array<{ id: MesoRegionId; distance: number }> = [
    { id: startId, distance: 0 },
  ];
  const visited = new Set<MesoRegionId>([startId]);
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    if (current.id === targetId) {
      return true;
    }
    if (current.distance >= maxDistance) {
      continue;
    }
    for (const neighbor of mesoById.get(current.id)?.neighbors ?? []) {
      if (visited.has(neighbor.id)) {
        continue;
      }
      visited.add(neighbor.id);
      queue.push({ id: neighbor.id, distance: current.distance + 1 });
    }
  }
  return false;
}

function createAllocatedTwoFrontWorld(): WorldState {
  const world = createFrontWorld(
    [
      { id: "a1", owner: NATION_A },
      { id: "b1", owner: NATION_B },
      { id: "a2", owner: NATION_A },
      { id: "b2", owner: NATION_B },
    ],
    [
      ["a1", "b1"],
      ["a2", "b2"],
    ],
  );
  startWar(world, NATION_A, NATION_B);
  for (const regionId of ["a1", "a2"]) {
    for (let index = 0; index < 3; index += 1) {
      setUnitStrength(addLandUnit(world, NATION_A, regionId, "Infantry"), 100);
    }
  }
  for (const regionId of ["b1", "b2"]) {
    setUnitStrength(addLandUnit(world, NATION_B, regionId, "Infantry"), 100);
  }
  updateAllocationSystem(world);
  return world;
}

function createAllocatedThreeSegmentWorld(
  middleOwnedByThirdNation: boolean,
): WorldState {
  const world = createThreeSegmentWorld(middleOwnedByThirdNation);
  startWar(world, NATION_A, NATION_B);
  for (const regionId of ["a1", "a3"]) {
    for (let index = 0; index < 2; index += 1) {
      addLandUnit(world, NATION_A, regionId, "Infantry");
    }
  }
  for (const regionId of ["b1", "b3"]) {
    for (let index = 0; index < 2; index += 1) {
      addLandUnit(world, NATION_B, regionId, "Infantry");
    }
  }
  updateAllocationSystem(world);
  return world;
}

function updateAllocationSystem(world: WorldState): void {
  updateFrontSystem(world);
  updateNationFrontAllocations(world);
}

function assertUniqueAllocatedUnits(world: WorldState): void {
  const unitIds = getNationFrontAllocations(world).flatMap(
    (allocation) => allocation.unitIds,
  );
  assert.equal(new Set(unitIds).size, unitIds.length);
  assert.equal(world.frontAllocations.frontIdByUnitId.size, unitIds.length);
}

function createStrengthPlanWorld(
  friendlyStrength: number,
  enemyStrength: number,
  friendlyBuilding: MesoRegion["building"] = null,
  enemyBuilding: MesoRegion["building"] = null,
): WorldState {
  const world = createFrontWorld(
    [
      { id: "a", owner: NATION_A, building: friendlyBuilding },
      { id: "b", owner: NATION_B, building: enemyBuilding },
    ],
    [["a", "b"]],
  );
  startWar(world, NATION_A, NATION_B);
  if (friendlyStrength > 0) {
    setUnitStrength(
      addLandUnit(world, NATION_A, "a", "Infantry"),
      friendlyStrength,
    );
  }
  if (enemyStrength > 0) {
    setUnitStrength(addLandUnit(world, NATION_B, "b", "Infantry"), enemyStrength);
  }
  updateFrontSystem(world);
  return world;
}

function createBalancedStalemateWorld(): WorldState {
  const world = createFrontWorld(
    [
      { id: "a-rear", owner: NATION_A },
      { id: "a-front", owner: NATION_A },
      { id: "b-front", owner: NATION_B },
      { id: "b-rear", owner: NATION_B },
    ],
    [["a-rear", "a-front"], ["a-front", "b-front"], ["b-front", "b-rear"]],
  );
  startWar(world, NATION_A, NATION_B);
  for (const nationId of [NATION_A, NATION_B]) {
    const regionId = nationId === NATION_A ? "a-front" : "b-front";
    for (let index = 0; index < 6; index += 1) {
      setUnitStrength(addLandUnit(world, nationId, regionId, "Infantry"), 1_000);
    }
  }
  updateAllocationSystem(world);
  updateFrontlineCoverage(world);
  return world;
}

function updateFrontSystem(world: WorldState): void {
  updateLandFronts(world);
  updateCapitalDefense(world);
  updateNationFrontPlans(world);
}

function planFor(world: WorldState, nationId: NationId) {
  const front = getPhysicalFrontsForNation(world, nationId)[0];
  assert(front);
  const plan = getFrontPlan(world, front.id, nationId);
  assert(plan);
  return plan;
}

function setUnitStrength(
  unit: ReturnType<typeof addLandUnit>,
  desiredStrength: number,
): void {
  const currentStrength = getUnitCombatStrength(unit);
  assert(currentStrength > 0);
  unit.manpower *= desiredStrength / currentStrength;
  assert(Math.abs(getUnitCombatStrength(unit) - desiredStrength) < 0.0001);
}

function assertPlanReferencesAreValid(
  world: WorldState,
  expectedPhysicalFronts: number,
): void {
  assert.equal(world.landFronts.physicalFronts.length, expectedPhysicalFronts);
  assert.equal(world.frontPlans.plans.length, expectedPhysicalFronts * 2);
  const validFrontIds = new Set(
    world.landFronts.physicalFronts.map((front) => front.id),
  );
  for (const plan of world.frontPlans.plans) {
    assert(validFrontIds.has(plan.frontId));
  }
}

function createSimpleBorderWorld(inactiveNationIds = new Set<NationId>()): WorldState {
  return createFrontWorld(
    [
      { id: "a", owner: NATION_A },
      { id: "b", owner: NATION_B },
    ],
    [["a", "b"]],
    inactiveNationIds,
  );
}

function createThreeSegmentWorld(middleOwnedByThirdNation: boolean): WorldState {
  return createFrontWorld(
    [
      { id: "a1", owner: NATION_A },
      { id: "a2", owner: middleOwnedByThirdNation ? NATION_C : NATION_A },
      { id: "a3", owner: NATION_A },
      { id: "b1", owner: NATION_B },
      { id: "b2", owner: middleOwnedByThirdNation ? NATION_C : NATION_B },
      { id: "b3", owner: NATION_B },
    ],
    [
      ["a1", "a2"],
      ["a2", "a3"],
      ["b1", "b2"],
      ["b2", "b3"],
      ["a1", "b1"],
      ["a2", "b2"],
      ["a3", "b3"],
    ],
  );
}

function createFrontWorld(
  specs: RegionSpec[],
  edges: Edge[],
  inactiveNationIds = new Set<NationId>(),
): WorldState {
  const neighbors = new Map<string, string[]>();
  for (const spec of specs) {
    neighbors.set(spec.id, []);
  }
  for (const [a, b] of edges) {
    neighbors.get(a)?.push(b);
    neighbors.get(b)?.push(a);
  }
  const mesoRegions: MesoRegion[] = specs.map((spec, index) => ({
    id: id(spec.id),
    type: "land",
    centerId: `micro-${index}` as MicroRegionId,
    center: { x: index, y: 0 },
    microRegionIds: [],
    neighbors: (neighbors.get(spec.id) ?? []).map((neighborId) => ({
      id: id(neighborId),
      hasRiver: false,
    })),
    building: spec.building ?? null,
    resource: null,
  }));
  const macroRegions: MacroRegion[] = specs.map((spec, index) => ({
    id: createMacroRegionId(index),
    nationId: spec.owner,
    mesoRegionIds: [id(spec.id)],
    isCore: true,
  }));
  const fallbackCapitalId = mesoRegions[0]?.id ?? id("missing");
  const nations: NationRuntime[] = ALL_NATIONS.map((nationId) => {
    const ownedMacros = inactiveNationIds.has(nationId)
      ? []
      : macroRegions.filter((macro) => macro.nationId === nationId).map((macro) => macro.id);
    const capitalMesoId =
      macroRegions.find((macro) => macro.nationId === nationId)?.mesoRegionIds[0] ??
      fallbackCapitalId;
    return createRuntimeNation(nationId, capitalMesoId, ownedMacros);
  });
  const occupation = createOccupationState();
  for (const spec of specs) {
    if (spec.occupier && spec.occupier !== spec.owner) {
      occupation.mesoById.set(id(spec.id), spec.occupier);
    }
  }
  if (occupation.mesoById.size > 0) {
    occupation.version = 1;
  }
  return {
    width: 100,
    height: 100,
    microRegions: [],
    microRegionEdges: [],
    mesoRegions,
    macroRegions,
    nations,
    wars: [],
    battles: [],
    occupation,
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
    stalematePressure: createStalematePressureState(),
    collapseAdvances: createCollapseAdvanceState(),
    mapVersion: 0,
    territoryVersion: 0,
    buildingVersion: 0,
    units: [],
    unitIdCounter: 0,
    simRng: new SeededRng(1),
    cache: createWorldCache(),
    time: createSimTime(),
  };
}

function createRuntimeNation(
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

function startWar(world: WorldState, nationAId: NationId, nationBId: NationId): void {
  assert(declareWar(world.wars, nationAId, nationBId, world.time.fastTick, true));
}

function frontsBetween(world: WorldState, nationId: NationId, enemyNationId: NationId) {
  return getPhysicalFrontsForNation(world, nationId).filter(
    (front) =>
      (front.nationAId === nationId && front.nationBId === enemyNationId) ||
      (front.nationBId === nationId && front.nationAId === enemyNationId),
  );
}

function setRegionOwner(world: WorldState, regionId: string, nextOwnerId: NationId): void {
  const targetId = id(regionId);
  const macro = world.macroRegions.find((entry) => entry.mesoRegionIds.includes(targetId));
  assert(macro);
  const previousOwner = world.nations.find((nation) => nation.id === macro.nationId);
  const nextOwner = world.nations.find((nation) => nation.id === nextOwnerId);
  assert(previousOwner && nextOwner);
  previousOwner.macroRegionIds = previousOwner.macroRegionIds.filter(
    (macroId) => macroId !== macro.id,
  );
  macro.nationId = nextOwnerId;
  if (!nextOwner.macroRegionIds.includes(macro.id)) {
    nextOwner.macroRegionIds.push(macro.id);
  }
}

function addLandUnit(
  world: WorldState,
  nationId: NationId,
  regionId: string,
  type: LandUnitType,
) {
  const unit = createUnitForType(
    createUnitId(world.unitIdCounter),
    nationId,
    id(regionId),
    type,
  );
  world.unitIdCounter += 1;
  world.units.push(unit);
  return unit;
}

function addUnit(
  world: WorldState,
  nationId: NationId,
  regionId: string,
  type: UnitType,
) {
  return addUnitAtRegion(world, nationId, id(regionId), type);
}

function addUnitAtRegion(
  world: WorldState,
  nationId: NationId,
  regionId: MesoRegionId,
  type: UnitType,
) {
  const unit = createUnitForType(
    createUnitId(world.unitIdCounter),
    nationId,
    regionId,
    type,
  );
  world.unitIdCounter += 1;
  world.units.push(unit);
  return unit;
}

function id(value: string): MesoRegionId {
  return value as MesoRegionId;
}

function ids(...values: string[]): MesoRegionId[] {
  return values.map(id).sort();
}
