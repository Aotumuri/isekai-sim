import assert from "node:assert/strict";
import test from "node:test";
import { SeededRng } from "../../src/utils/seeded-rng";
import { WORLD_BALANCE } from "../../src/data/balance";
import { updateCapitalDefense } from "../../src/sim/capital-defense";
import { createCapitalDefenseState } from "../../src/sim/capital-defense";
import { createUnitForType } from "../../src/sim/create-units";
import { createLandFrontState, updateLandFronts } from "../../src/sim/land-fronts";
import {
  createNationFrontAllocationState,
  updateNationFrontAllocations,
} from "../../src/sim/nation-front-allocations";
import { createNationFrontPlanState, updateNationFrontPlans } from "../../src/sim/nation-front-plans";
import {
  createNationResourceFlow,
  createNationResources,
  type NationRuntime,
} from "../../src/sim/nation-runtime";
import { createOccupationState } from "../../src/sim/occupation";
import { createOffensiveOperationState } from "../../src/sim/offensive-operations";
import { createCollapseAdvanceState } from "../../src/sim/collapse-advance";
import { createBattlefieldTopologyState } from "../../src/sim/battlefield-topology";
import {
  createSupplyAssessmentState,
  updateSupplyAssessment,
} from "../../src/sim/supply-assessment";
import { createIsolationEffectsState } from "../../src/sim/isolation-effects";
import type { PocketRecord } from "../../src/sim/battlefield-topology";
import {
  createReorganizationState,
  getReorganizationPlanForUnit,
  getUnitEquipmentFulfillment,
  updateReorganization,
} from "../../src/sim/reorganization";
import { createRetreatPlanState, type RetreatPlan } from "../../src/sim/retreat-plans";
import {
  createStrategicReserveState,
  type NationReserveState,
} from "../../src/sim/strategic-reserves";
import { createSimTime } from "../../src/sim/time";
import { createUnitId, type UnitState } from "../../src/sim/unit";
import { getUnitCombatStrength } from "../../src/sim/unit-strength";
import { declareWar } from "../../src/sim/war-state";
import type { WorldState } from "../../src/sim/world-state";
import { createFrontlineCoverageState } from "../../src/sim/frontline-coverage";
import { createStalematePressureState } from "../../src/sim/stalemate-pressure";
import { createStrategicProgressState } from "../../src/sim/strategic-progress";
import { createWorldCache } from "../../src/sim/world-cache";
import { createProductionDiagnosticsState } from "../../src/sim/production";
import { createSupplyCutoffAnalysisState } from "../../src/sim/supply-cutoff";
import { createMacroRegionId, type MacroRegion } from "../../src/worldgen/macro-region";
import type { MicroRegionId } from "../../src/worldgen/micro-region";
import type { MesoRegion, MesoRegionId } from "../../src/worldgen/meso-region";
import type { NationId } from "../../src/worldgen/nation";
import { assertWorldInvariants } from "../helpers/invariants";

const NATION_A = "nation-a" as NationId;
const NATION_B = "nation-b" as NationId;

test("healthy unit is not selected for Reorganization", () => {
  const { world, unit } = createReorganizationWorld();
  updateReorganization(world);
  assert.equal(getReorganizationPlanForUnit(world, unit.id), undefined);
});

test("damaged retreat survivor enters Reorganization at the higher handoff threshold", () => {
  const { world, unit } = createReorganizationWorld();
  setReadiness(unit, 0.65, 0.78, 0.78);
  installCompletedRetreat(world, unit);
  updateReorganization(world);
  const plan = getReorganizationPlanForUnit(world, unit.id);
  assert(plan);
  assert(plan.reasonFlags.includes("retreat-survivor"));
});

test("damaged Strategic Reserve unit transfers to exclusive Reorganization ownership", () => {
  const { world, unit } = createReorganizationWorld();
  damageUnit(unit);
  installReserve(world, unit);
  updateReorganization(world);
  const plan = getReorganizationPlanForUnit(world, unit.id);
  assert(plan?.reasonFlags.includes("strategic-reserve"));
  assert(!world.strategicReserves.reserveNationByUnitId.has(unit.id));
  assert(!world.frontAllocations.frontIdByUnitId.has(unit.id));
});

test("Reorganization selects the safe reachable capital as its preferred rear area", () => {
  const { world, unit } = createDamagedPlanWorld();
  const plan = getReorganizationPlanForUnit(world, unit.id);
  assert(plan);
  assert.equal(plan.locationRegionId, id("a-cap"));
});

test("rear-area selection never chooses sea", () => {
  const { world, unit } = createDamagedPlanWorld();
  const plan = getReorganizationPlanForUnit(world, unit.id);
  assert(plan);
  assert.notEqual(world.mesoRegions.find((region) => region.id === plan.locationRegionId)?.type, "sea");
});

test("rear-area selection excludes an enemy-occupied capital", () => {
  const { world, unit } = createReorganizationWorld();
  damageUnit(unit);
  world.occupation.mesoById.set(id("a-cap"), NATION_B);
  world.occupation.version += 1;
  updateReorganization(world);
  const plan = getReorganizationPlanForUnit(world, unit.id);
  assert(plan);
  assert.notEqual(plan.locationRegionId, id("a-cap"));
});

test("unit in an active battle is not pulled into Reorganization", () => {
  const { world, unit } = createReorganizationWorld();
  damageUnit(unit);
  world.battles.push({
    id: "battle-test" as WorldState["battles"][number]["id"],
    mesoId: unit.regionId,
    attackerNationId: NATION_B,
    defenderNationId: NATION_A,
    startedAtFastTick: 0,
    lastActiveFastTick: 0,
    attackDirectionCount: 1,
    attackSourceRegionIds: [],
    attackStrengthBySourceRegion: new Map(),
    multiDirectionModifier: 1,
    attackerOrganizationLoss: 0,
    defenderOrganizationLoss: 0,
    attackerManpowerLoss: 0,
    defenderManpowerLoss: 0,
  });
  updateReorganization(world);
  assert.equal(getReorganizationPlanForUnit(world, unit.id), undefined);
});

test("organization recovers gradually in a safe rear area", () => {
  const { world, unit } = createDamagedPlanWorld();
  arriveAtRear(world, unit);
  const before = unit.org;
  advanceReorganization(world);
  assert(unit.org > before);
  assert(unit.org < 1);
});

test("manpower reinforcement consumes the existing national manpower stock", () => {
  const { world, unit } = createDamagedPlanWorld();
  arriveAtRear(world, unit);
  const nation = getNationA(world);
  const manpowerBefore = unit.manpower;
  const stockBefore = nation.resources.manpower;
  advanceReorganization(world);
  const reinforced = unit.manpower - manpowerBefore;
  assert(reinforced > 0);
  assert.equal(stockBefore - nation.resources.manpower, reinforced);
  assert.equal(nation.resourceFlow.usage.manpower, reinforced);
});

test("multiple equipment models preserve their mix while consuming weapons stock", () => {
  const { world, unit } = createDamagedPlanWorld();
  arriveAtRear(world, unit);
  const nation = getNationA(world);
  const stockBefore = nation.resources.weapons;
  const ratioBefore = unit.equipment[0].fill / unit.equipment[1].fill;
  advanceReorganization(world);
  assert(getUnitEquipmentFulfillment(unit) > 0.45);
  assert(nation.resources.weapons < stockBefore);
  assert(Math.abs(unit.equipment[0].fill / unit.equipment[1].fill - ratioBefore) < 1e-9);
});

test("resource shortage stops manpower and equipment reinforcement", () => {
  const { world, unit } = createDamagedPlanWorld();
  arriveAtRear(world, unit);
  const nation = getNationA(world);
  nation.resources.manpower = 0;
  nation.resources.weapons = 0;
  const manpowerBefore = unit.manpower;
  const equipmentBefore = getUnitEquipmentFulfillment(unit);
  advanceReorganization(world);
  assert.equal(unit.manpower, manpowerBefore);
  assert.equal(getUnitEquipmentFulfillment(unit), equipmentBefore);
  assert(world.reorganization.resourceShortageCount >= 2);
});

test("organization still recovers when manpower and equipment are unavailable", () => {
  const { world, unit } = createDamagedPlanWorld();
  arriveAtRear(world, unit);
  const nation = getNationA(world);
  nation.resources.manpower = 0;
  nation.resources.weapons = 0;
  const before = unit.org;
  advanceReorganization(world);
  assert(unit.org > before);
});

test("isolated Reorganization blocks manpower and equipment without consuming national resources", () => {
  const { world, unit } = createDamagedPlanWorld();
  placePlanAtIsland(world, unit, false);
  const nation = getNationA(world);
  const before = {
    organization: unit.org,
    manpower: unit.manpower,
    equipment: getUnitEquipmentFulfillment(unit),
    nationalManpower: nation.resources.manpower,
    nationalWeapons: nation.resources.weapons,
  };
  advanceReorganization(world);

  assert.equal(unit.org, before.organization);
  assert.equal(unit.manpower, before.manpower);
  assert.equal(getUnitEquipmentFulfillment(unit), before.equipment);
  assert.equal(nation.resources.manpower, before.nationalManpower);
  assert.equal(nation.resources.weapons, before.nationalWeapons);
  const plan = getReorganizationPlanForUnit(world, unit.id);
  assert(plan);
  assert.equal(plan.supplyStatus, "isolated");
  assert(plan.organizationDeniedByIsolation > 0);
  assert(plan.manpowerDeniedByIsolation > 0);
  assert(plan.equipmentDeniedByIsolation > 0);
});

test("isolated organization is frozen while supplied recovery remains unchanged", () => {
  const isolated = createDamagedPlanWorld();
  const supplied = createDamagedPlanWorld();
  placePlanAtIsland(isolated.world, isolated.unit, false);
  placePlanAtIsland(supplied.world, supplied.unit, true);
  const isolatedBefore = isolated.unit.org;
  const suppliedBefore = supplied.unit.org;

  advanceReorganization(isolated.world);
  advanceReorganization(supplied.world);

  assert.equal(isolated.unit.org, isolatedBefore);
  assert(Math.abs(
    supplied.unit.org - suppliedBefore -
    WORLD_BALANCE.war.landFront.reorganization.organizationRecoveryPerSlowTick,
  ) < 1e-12);
});

test("an isolated city multiplier cannot bypass Supply", () => {
  assertIsolatedFacilityDoesNotRecover("city");
});

test("an isolated capital multiplier cannot bypass Supply", () => {
  assertIsolatedFacilityDoesNotRecover("capital");
});

test("supplied to isolated transition stops reinforcement without recreating the plan", () => {
  const { world, unit } = createDamagedPlanWorld();
  arriveAtRear(world, unit);
  advanceReorganization(world);
  const plan = getReorganizationPlanForUnit(world, unit.id);
  assert(plan);
  const planId = plan.id;
  const manpowerAfterSupplied = unit.manpower;
  const equipmentAfterSupplied = getUnitEquipmentFulfillment(unit);
  const organizationAfterSupplied = unit.org;
  getNationA(world).capitalMesoId = id("a-island");
  advanceReorganization(world);

  const isolatedPlan = getReorganizationPlanForUnit(world, unit.id);
  assert(isolatedPlan);
  assert.equal(isolatedPlan.id, planId);
  assert.equal(isolatedPlan.supplyStatus, "isolated");
  assert.equal(unit.manpower, manpowerAfterSupplied);
  assert.equal(getUnitEquipmentFulfillment(unit), equipmentAfterSupplied);
  assert.equal(unit.org, organizationAfterSupplied);
  assert.equal(world.reorganization.plansEnteringIsolation, 1);
});

test("isolated to supplied transition resumes reinforcement on the existing plan", () => {
  const { world, unit } = createDamagedPlanWorld();
  arriveAtRear(world, unit);
  getNationA(world).capitalMesoId = id("a-island");
  advanceReorganization(world);
  const plan = getReorganizationPlanForUnit(world, unit.id);
  assert(plan);
  const planId = plan.id;
  const manpowerWhileIsolated = unit.manpower;
  const equipmentWhileIsolated = getUnitEquipmentFulfillment(unit);
  const organizationWhileIsolated = unit.org;
  getNationA(world).capitalMesoId = id("a-cap");
  advanceReorganization(world);

  const reconnectedPlan = getReorganizationPlanForUnit(world, unit.id);
  assert(reconnectedPlan);
  assert.equal(reconnectedPlan.id, planId);
  assert.equal(reconnectedPlan.supplyStatus, "supplied");
  assert(unit.manpower > manpowerWhileIsolated);
  assert(getUnitEquipmentFulfillment(unit) > equipmentWhileIsolated);
  assert(unit.org > organizationWhileIsolated);
  assert.equal(world.reorganization.plansReconnecting, 1);
  assert.equal(world.reorganization.reconnectedPlansResumingOrganization, 1);
});

test("cutting and restoring a corridor stops and resumes reinforcement on one plan", () => {
  const { world, unit } = createDamagedPlanWorld();
  const plan = getReorganizationPlanForUnit(world, unit.id);
  assert(plan);
  plan.locationRegionId = id("a-front");
  unit.regionId = id("a-front");
  advanceReorganization(world);
  const planId = plan.id;
  const suppliedManpower = unit.manpower;
  const suppliedOrganization = unit.org;

  world.occupation.mesoById.set(id("a-mid"), NATION_B);
  world.occupation.version += 1;
  plan.targetOccupationVersion = world.occupation.version;
  advanceReorganization(world);
  assert.equal(getReorganizationPlanForUnit(world, unit.id)?.id, planId);
  assert.equal(getReorganizationPlanForUnit(world, unit.id)?.supplyStatus, "isolated");
  assert.equal(unit.manpower, suppliedManpower);
  assert.equal(unit.org, suppliedOrganization);

  world.occupation.mesoById.delete(id("a-mid"));
  world.occupation.version += 1;
  plan.targetOccupationVersion = world.occupation.version;
  advanceReorganization(world);
  assert.equal(getReorganizationPlanForUnit(world, unit.id)?.id, planId);
  assert.equal(getReorganizationPlanForUnit(world, unit.id)?.supplyStatus, "supplied");
  assert(unit.manpower > suppliedManpower);
  assert(unit.org > suppliedOrganization);
});

test("isolated ready thresholds remain unchanged and can stall a plan", () => {
  const { world, unit } = createDamagedPlanWorld();
  arriveAtRear(world, unit);
  setReadiness(unit, 0.79, 0.74, 0.74);
  getNationA(world).capitalMesoId = id("a-island");
  advanceReorganization(world);

  const plan = getReorganizationPlanForUnit(world, unit.id);
  assert(plan);
  assert.equal(plan.supplyStatus, "isolated");
  assert.equal(unit.org, 0.79);
  assert.equal(world.reorganization.stalledIsolatedPlans, 1);
  assert.equal(world.reorganization.isolatedPlansStalledByOrganization, 1);
  assert.equal(world.reorganization.isolatedPlansReachingReady, 0);
});

test("Pocket diagnostics do not control reinforcement; Supply remains source of truth", () => {
  const { world, unit } = createDamagedPlanWorld();
  arriveAtRear(world, unit);
  world.battlefieldTopology.pockets = [fakePocket(NATION_A, unit.regionId)];
  const manpowerBefore = unit.manpower;
  advanceReorganization(world);

  assert(unit.manpower > manpowerBefore);
  assert.equal(
    getReorganizationPlanForUnit(world, unit.id)?.supplyStatus,
    "supplied",
  );
  assert.equal(world.reorganization.reinforcementDeniedInsidePockets, 0);
});

test("isolated Pocket diagnostics record units and denied reinforcement", () => {
  const { world, unit } = createDamagedPlanWorld();
  placePlanAtIsland(world, unit, false);
  world.battlefieldTopology.pockets = [fakePocket(NATION_A, unit.regionId)];
  advanceReorganization(world);

  assert.equal(world.reorganization.isolatedReorganizationUnitsInsidePockets, 1);
  assert(world.reorganization.reinforcementDeniedInsidePockets > 0);
  assert(world.reorganization.organizationDeniedInsidePockets > 0);
  assert((getReorganizationPlanForUnit(world, unit.id)
    ?.deniedReinforcementInsidePocket ?? 0) > 0);
});

test("a low-organization Pocket unit cannot cycle back to ready while isolated", () => {
  const { world, unit } = createDamagedPlanWorld();
  placePlanAtIsland(world, unit, false);
  setReadiness(unit, 0.3, 0.8, 0.8);
  world.battlefieldTopology.pockets = [fakePocket(NATION_A, unit.regionId)];
  for (let index = 0; index < 5; index += 1) advanceReorganization(world);

  assert.equal(unit.org, 0.3);
  assert(getReorganizationPlanForUnit(world, unit.id));
  assert.equal(world.reorganization.isolatedPocketUnitsEnteringReorganization, 1);
  assert.equal(world.reorganization.pocketUnitsReturningToCombat, 0);
  assert(world.reorganization.organizationDeniedInsidePockets > 0);
});

test("Reorganization itself adds neither isolation decay nor a direct combat modifier", () => {
  const { world, unit } = createDamagedPlanWorld();
  placePlanAtIsland(world, unit, false);
  unit.org = 0.9;
  const organizationBefore = unit.org;
  const strengthBefore = getUnitCombatStrength(unit);
  advanceReorganization(world);

  assert.equal(unit.org, organizationBefore);
  assert.equal(getUnitCombatStrength(unit), strengthBefore);
  assert(getReorganizationPlanForUnit(world, unit.id));
});

test("isolated reinforcement accounting remains finite and non-negative", () => {
  const { world, unit } = createDamagedPlanWorld();
  placePlanAtIsland(world, unit, false);
  const nation = getNationA(world);
  for (let index = 0; index < 10; index += 1) advanceReorganization(world);

  assert(nation.resources.manpower >= 0);
  assert(nation.resources.weapons >= 0);
  for (const value of [
    world.reorganization.manpowerDeniedByIsolation,
    world.reorganization.equipmentDeniedByIsolation,
    world.reorganization.isolatedDurationTicks,
    nation.resources.manpower,
    nation.resources.weapons,
  ]) {
    assert(Number.isFinite(value));
  }
});

test("ready requires organization, manpower, and equipment thresholds together", () => {
  const { world, unit } = createDamagedPlanWorld();
  arriveAtRear(world, unit);
  setReadiness(unit, 0.81, 0.76, 0.74);
  getNationA(world).resources.weapons = 0;
  advanceReorganization(world);
  assert(getReorganizationPlanForUnit(world, unit.id));
  getNationA(world).resources.weapons = 10;
  advanceReorganization(world);
  assert.equal(getReorganizationPlanForUnit(world, unit.id), undefined);
  assert.equal(world.reorganization.history.at(-1)?.phase, "ready");
});

test("ready unit becomes available to Front Allocation again", () => {
  const { world, unit } = createDamagedPlanWorld();
  arriveAtRear(world, unit);
  setReadiness(unit, 0.79, 0.76, 0.76);
  advanceReorganization(world);
  assert.equal(getReorganizationPlanForUnit(world, unit.id), undefined);
  updateNationFrontAllocations(world);
  assert(world.frontAllocations.frontIdByUnitId.has(unit.id));
  advanceReorganization(world);
  assert.equal(world.reorganization.returnedToFrontCount, 1);
});

test("ready unit can refill an existing Strategic Reserve deficit", () => {
  const { world, unit } = createReorganizationWorld();
  damageUnit(unit);
  const reserve = installReserve(world, unit);
  reserve.desiredReserveStrength = 100_000;
  updateReorganization(world);
  arriveAtRear(world, unit);
  setReadiness(unit, 0.79, 0.76, 0.76);
  advanceReorganization(world);
  assert(world.strategicReserves.reserveNationByUnitId.has(unit.id));
  assert.equal(world.reorganization.returnedToReserveCount, 1);
  assert.equal(world.reorganization.reserveSurvivorsReturnedCount, 1);
});

test("active Offensive Operation membership blocks Reorganization ownership", () => {
  const { world, unit } = createReorganizationWorld();
  damageUnit(unit);
  world.offensiveOperations.operationIdByUnitId.set(
    unit.id,
    "operation-test" as WorldState["offensiveOperations"]["operations"][number]["id"],
  );
  updateReorganization(world);
  assert.equal(getReorganizationPlanForUnit(world, unit.id), undefined);
});

test("active RetreatPlan membership blocks Reorganization ownership", () => {
  const { world, unit } = createReorganizationWorld();
  damageUnit(unit);
  world.retreatPlans.retreatIdByUnitId.set(
    unit.id,
    "retreat-test" as RetreatPlan["id"],
  );
  updateReorganization(world);
  assert.equal(getReorganizationPlanForUnit(world, unit.id), undefined);
});

test("active Reserve deployment blocks simultaneous Reorganization ownership", () => {
  const { world, unit } = createReorganizationWorld();
  damageUnit(unit);
  installReserve(world, unit, "moving");
  updateReorganization(world);
  assert.equal(getReorganizationPlanForUnit(world, unit.id), undefined);
  assert(world.strategicReserves.reserveNationByUnitId.has(unit.id));
  const reserve = world.strategicReserves.reservesByNationId.get(NATION_A);
  assert(reserve?.deployment);
  reserve.deployment.status = "returning";
  reserve.status = "returning";
  advanceReorganization(world);
  assert(getReorganizationPlanForUnit(world, unit.id));
});

test("enemy approach interrupts a plan and safely selects another rear area", () => {
  const { world, unit } = createDamagedPlanWorld();
  const original = getReorganizationPlanForUnit(world, unit.id);
  assert(original);
  addUnit(world, NATION_B, "a-cap", "Infantry");
  advanceReorganization(world);
  const plan = getReorganizationPlanForUnit(world, unit.id);
  assert(plan);
  assert.notEqual(plan.locationRegionId, id("a-cap"));
  assert.equal(plan.interruptionCount, 1);
});

test("Reorganization references remain valid and ownership stays exclusive", () => {
  const { world } = createDamagedPlanWorld();
  updateNationFrontAllocations(world);
  assertWorldInvariants(world);
});

test("Reorganization numeric state never contains NaN or Infinity", () => {
  const { world, unit } = createDamagedPlanWorld();
  arriveAtRear(world, unit);
  for (let index = 0; index < 5; index += 1) advanceReorganization(world);
  assertWorldInvariants(world);
  for (const value of [
    world.reorganization.organizationRecovered,
    world.reorganization.organizationDeniedByIsolation,
    world.reorganization.isolationToReconnectionTicks,
    world.reorganization.reconnectionToReadyTicks,
    world.reorganization.manpowerReinforced,
    world.reorganization.equipmentReinforced,
    world.reorganization.manpowerResourceConsumed,
    world.reorganization.equipmentStockConsumed,
  ]) {
    assert(Number.isFinite(value));
  }
});

test("naval units never enter Reorganization", () => {
  const { world } = createReorganizationWorld();
  const naval = addUnit(world, NATION_A, "a-sea", "CombatShip");
  naval.org = 0.1;
  naval.manpower = 10;
  updateReorganization(world);
  assert.equal(getReorganizationPlanForUnit(world, naval.id), undefined);
});

test("Reorganization decisions are fixed-seed deterministic", () => {
  const first = createDamagedPlanWorld();
  const second = createDamagedPlanWorld();
  for (let index = 0; index < 8; index += 1) {
    if (index === 1) {
      arriveAtRear(first.world, first.unit);
      arriveAtRear(second.world, second.unit);
    }
    advanceReorganization(first.world);
    advanceReorganization(second.world);
  }
  assert.deepEqual(reorganizationSignature(first.world), reorganizationSignature(second.world));
});

test("critical Capital Emergency can deploy only sufficiently recovered units early", () => {
  const { world, unit } = createDamagedPlanWorld();
  arriveAtRear(world, unit);
  advanceReorganization(world);
  setReadiness(unit, 0.6, 0.8, 0.8);
  addUnit(world, NATION_B, "a-city", "Infantry");
  updateCapitalDefense(world);
  assert.equal(
    world.capitalDefense.assessmentsByNationId.get(NATION_A)?.threatLevel,
    "critical",
  );
  advanceReorganization(world);
  assert.equal(getReorganizationPlanForUnit(world, unit.id), undefined);
  assert.equal(world.reorganization.emergencyEarlyDeploymentCount, 1);
  assert.equal(world.reorganization.history.at(-1)?.outcome, "emergency-deployed");
});

function createDamagedPlanWorld(): { world: WorldState; unit: UnitState } {
  const result = createReorganizationWorld();
  damageUnit(result.unit);
  updateReorganization(result.world);
  assert(getReorganizationPlanForUnit(result.world, result.unit.id));
  return result;
}

function createReorganizationWorld(): { world: WorldState; unit: UnitState } {
  const specs: Array<{
    name: string;
    owner: NationId;
    type?: MesoRegion["type"];
    building?: MesoRegion["building"];
  }> = [
    { name: "a-cap", owner: NATION_A, building: "capital" },
    { name: "a-city", owner: NATION_A, building: "city" },
    { name: "a-rear", owner: NATION_A },
    { name: "a-mid", owner: NATION_A },
    { name: "a-front", owner: NATION_A },
    { name: "a-island", owner: NATION_A },
    { name: "b-front", owner: NATION_B, building: "capital" },
    { name: "a-sea", owner: NATION_A, type: "sea" },
  ];
  const edges: Array<[string, string]> = [
    ["a-cap", "a-city"],
    ["a-city", "a-rear"],
    ["a-rear", "a-mid"],
    ["a-mid", "a-front"],
    ["a-front", "b-front"],
    ["a-cap", "a-sea"],
  ];
  const neighborNames = new Map(specs.map((spec) => [spec.name, [] as string[]]));
  for (const [a, b] of edges) {
    neighborNames.get(a)?.push(b);
    neighborNames.get(b)?.push(a);
  }
  const mesoRegions: MesoRegion[] = specs.map((spec, index) => ({
    id: id(spec.name),
    type: spec.type ?? "land",
    centerId: `micro-${index}` as MicroRegionId,
    center: { x: index, y: 0 },
    microRegionIds: [],
    neighbors: (neighborNames.get(spec.name) ?? []).map((name) => ({
      id: id(name),
      hasRiver: false,
    })),
    building: spec.building ?? null,
    resource: null,
  }));
  const macroRegions: MacroRegion[] = specs.map((spec, index) => ({
    id: createMacroRegionId(index),
    nationId: spec.owner,
    mesoRegionIds: [id(spec.name)],
    isCore: true,
  }));
  const nations = [NATION_A, NATION_B].map((nationId) =>
    createRuntimeNation(
      nationId,
      nationId === NATION_A ? id("a-cap") : id("b-front"),
      macroRegions
        .filter((macro) => macro.nationId === nationId)
        .map((macro) => macro.id),
    ),
  );
  const world: WorldState = {
    width: 100,
    height: 100,
    microRegions: [],
    microRegionEdges: [],
    mesoRegions,
    macroRegions,
    nations,
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
    strategicReserves: createStrategicReserveState(false),
    reorganization: createReorganizationState(),
    strategicProgress: createStrategicProgressState(),
    stalematePressure: createStalematePressureState(),
    collapseAdvances: createCollapseAdvanceState(),
    battlefieldTopology: createBattlefieldTopologyState(),
    supplyAssessment: createSupplyAssessmentState(),
    isolationEffects: createIsolationEffectsState(),
    productionDiagnostics: createProductionDiagnosticsState(),
    supplyCutoffs: createSupplyCutoffAnalysisState(),
    mapVersion: 0,
    territoryVersion: 0,
    buildingVersion: 0,
    units: [],
    unitIdCounter: 0,
    simRng: new SeededRng(12345),
    cache: createWorldCache(),
    time: createSimTime(),
  };
  assert(declareWar(world.wars, NATION_A, NATION_B, 0, true));
  const unit = addUnit(world, NATION_A, "a-front", "Infantry");
  for (let index = 0; index < 3; index += 1) {
    addUnit(world, NATION_A, "a-front", "Infantry");
  }
  addUnit(world, NATION_B, "b-front", "Infantry");
  const nation = getNationA(world);
  nation.resources.manpower = 10_000;
  nation.resources.weapons = 100;
  updateLandFronts(world);
  updateCapitalDefense(world);
  updateNationFrontPlans(world);
  updateNationFrontAllocations(world);
  updateSupplyAssessment(world);
  return { world, unit };
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

function addUnit(
  world: WorldState,
  nationId: NationId,
  regionName: string,
  type: UnitState["type"],
): UnitState {
  const unit = createUnitForType(
    createUnitId(world.unitIdCounter),
    nationId,
    id(regionName),
    type,
  );
  world.unitIdCounter += 1;
  world.units.push(unit);
  return unit;
}

function damageUnit(unit: UnitState): void {
  setReadiness(unit, 0.2, 0.5, 0.45);
}

function setReadiness(
  unit: UnitState,
  organizationRatio: number,
  manpowerRatio: number,
  equipmentRatio: number,
): void {
  unit.org = organizationRatio;
  unit.manpower = WORLD_BALANCE.unit.types[unit.type].manpower * manpowerRatio;
  const current = getUnitEquipmentFulfillment(unit);
  const multiplier = current > 0 ? equipmentRatio / current : 0;
  for (const slot of unit.equipment) slot.fill *= multiplier;
}

function arriveAtRear(world: WorldState, unit: UnitState): void {
  const plan = getReorganizationPlanForUnit(world, unit.id);
  assert(plan);
  unit.regionId = plan.locationRegionId;
  unit.moveTargetId = null;
  unit.moveFromId = null;
  unit.moveToId = null;
  unit.moveProgressMs = 0;
}

function placePlanAtIsland(
  world: WorldState,
  unit: UnitState,
  supplied: boolean,
): void {
  const plan = getReorganizationPlanForUnit(world, unit.id);
  assert(plan);
  plan.locationRegionId = id("a-island");
  unit.regionId = id("a-island");
  unit.moveTargetId = null;
  unit.moveFromId = null;
  unit.moveToId = null;
  unit.moveProgressMs = 0;
  if (supplied) getNationA(world).capitalMesoId = id("a-island");
  updateSupplyAssessment(world);
}

function assertIsolatedFacilityDoesNotRecover(
  building: "city" | "capital",
): void {
  const { world, unit } = createDamagedPlanWorld();
  const region = world.mesoRegions.find(
    (candidate) => candidate.id === id("a-island"),
  );
  assert(region);
  region.building = building;
  placePlanAtIsland(world, unit, false);
  const before = unit.org;
  advanceReorganization(world);

  assert.equal(unit.org, before);
  assert((getReorganizationPlanForUnit(world, unit.id)
    ?.organizationDeniedByIsolation ?? 0) >
    WORLD_BALANCE.war.landFront.reorganization.organizationRecoveryPerSlowTick);
}

function fakePocket(nationId: NationId, regionId: MesoRegionId): PocketRecord {
  return {
    enemyNationId: nationId,
    regionIds: [regionId],
  } as unknown as PocketRecord;
}

function advanceReorganization(world: WorldState): void {
  world.time.fastTick += 10;
  world.time.slowTick += 1;
  updateSupplyAssessment(world);
  updateReorganization(world);
}

function getNationA(world: WorldState): NationRuntime {
  const nation = world.nations.find((candidate) => candidate.id === NATION_A);
  assert(nation);
  return nation;
}

function installCompletedRetreat(world: WorldState, unit: UnitState): void {
  const front = world.landFronts.physicalFronts[0];
  assert(front);
  const retreat: RetreatPlan = {
    id: "retreat-completed" as RetreatPlan["id"],
    nationId: NATION_A,
    enemyNationId: NATION_B,
    frontId: front.id,
    phase: "completed",
    rearguardUnitIds: [],
    retreatingUnitIds: [unit.id],
    initialRearguardUnitIds: [],
    initialRetreatingUnitIds: [unit.id],
    fallbackRegionIds: [id("a-city")],
    capitalDefenseFallback: true,
    capitalEmergencyRetargetKey: null,
    unitTargetRegionIds: new Map([[unit.id, id("a-city")]]),
    createdAtTick: 0,
    startedAtTick: 0,
    phaseStartedAtTick: 0,
    reasonFlags: ["preserve-army"],
    initialUnitCount: 1,
    initialRearguardUnitCount: 0,
    initialRetreatingUnitCount: 1,
    initialFriendlyStrength: 1,
    initialEnemyStrength: 2,
    initialRearguardStrength: 0,
    initialRetreatingStrength: 1,
    currentRetreatingStrength: 1,
    arrivedUnitCount: 1,
    arrivedStrength: 1,
    outcome: "success",
    completionReason: "regroup-complete",
    completedAtTick: world.time.fastTick,
  };
  world.retreatPlans.history.push(retreat);
}

function installReserve(
  world: WorldState,
  unit: UnitState,
  deploymentStatus?: "moving" | "engaged" | "returning",
): NationReserveState {
  const reserve: NationReserveState = {
    nationId: unit.nationId,
    unitIds: [unit.id],
    totalStrength: 1,
    desiredReserveStrength: 10_000,
    stagingRegionIds: [id("a-cap")],
    status: deploymentStatus ? "deploying" : "ready",
    deployment: deploymentStatus
      ? {
          targetType: "front-reinforcement",
          targetRegionIds: [id("a-front")],
          unitIds: [unit.id],
          unitTargetRegionIds: new Map([[unit.id, id("a-front")]]),
          startedAtTick: 0,
          status: deploymentStatus,
          reasonFlags: ["front-severe-deficit"],
          firstArrivalAtTick: null,
          initialTargetDeficit: 1,
          lastEffectiveDeficit: 1,
          lastArrivedUnitCount: 0,
          capitalEmergencyStartedAtTick: null,
        }
      : undefined,
    membershipStartedAtTickByUnitId: new Map([[unit.id, 0]]),
    cooldownUntilTick: 0,
    lastCollapseDeploymentAtTick: -1_000,
  };
  world.strategicReserves.reserves = [reserve];
  world.strategicReserves.reservesByNationId.set(unit.nationId, reserve);
  world.strategicReserves.reserveNationByUnitId.set(unit.id, unit.nationId);
  updateNationFrontAllocations(world);
  return reserve;
}

function reorganizationSignature(world: WorldState): unknown {
  return {
    units: world.units.map((unit) => ({
      id: unit.id,
      region: unit.regionId,
      org: unit.org,
      manpower: unit.manpower,
      equipment: unit.equipment.map((slot) => [slot.equipmentKey, slot.fill]),
    })),
    plans: world.reorganization.plans.map((plan) => ({
      id: plan.id,
      unit: plan.unitId,
      location: plan.locationRegionId,
      phase: plan.phase,
      recovered: [
        plan.organizationRecovered,
        plan.organizationDeniedByIsolation,
        plan.manpowerReinforced,
        plan.equipmentReinforced,
      ],
      supply: [
        plan.supplyStatus,
        plan.isolatedDurationTicks,
        plan.manpowerDeniedByIsolation,
        plan.equipmentDeniedByIsolation,
      ],
    })),
    resources: world.nations.map((nation) => ({ ...nation.resources })),
    supplyMetrics: {
      suppliedOrganizationRecoveryEvaluations:
        world.reorganization.suppliedOrganizationRecoveryEvaluations,
      isolatedOrganizationRecoveryEvaluations:
        world.reorganization.isolatedOrganizationRecoveryEvaluations,
      organizationDeniedByIsolation:
        world.reorganization.organizationDeniedByIsolation,
    },
    timeline: world.reorganization.timeline.map((event) => ({ ...event })),
  };
}

function id(value: string): MesoRegionId {
  return value as MesoRegionId;
}
