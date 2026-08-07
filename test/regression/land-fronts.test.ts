import assert from "node:assert/strict";
import test from "node:test";
import type { MicroRegionId } from "../../src/worldgen/micro-region";
import type { MesoRegion, MesoRegionId } from "../../src/worldgen/meso-region";
import { createMacroRegionId, type MacroRegion } from "../../src/worldgen/macro-region";
import { createNationId, type NationId } from "../../src/worldgen/nation";
import { SeededRng } from "../../src/utils/seeded-rng";
import { createUnitForType } from "../../src/sim/create-units";
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
  createNationResourceFlow,
  createNationResources,
  type NationRuntime,
} from "../../src/sim/nation-runtime";
import { createOccupationState } from "../../src/sim/occupation";
import { createSimTime } from "../../src/sim/time";
import { createUnitId, type LandUnitType } from "../../src/sim/unit";
import { getUnitCombatStrength } from "../../src/sim/unit-strength";
import { declareWar } from "../../src/sim/war-state";
import { createWorldCache } from "../../src/sim/world-cache";
import type { WorldState } from "../../src/sim/world-state";

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

function updateFrontSystem(world: WorldState): void {
  updateLandFronts(world);
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

function id(value: string): MesoRegionId {
  return value as MesoRegionId;
}

function ids(...values: string[]): MesoRegionId[] {
  return values.map(id).sort();
}
