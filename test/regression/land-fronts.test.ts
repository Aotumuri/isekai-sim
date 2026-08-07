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
  getAllocatedFrontId,
  getNationFrontAllocations,
  updateNationFrontAllocations,
} from "../../src/sim/nation-front-allocations";
import { repositionUnits } from "../../src/sim/nation/reposition-units";
import {
  createOffensiveOperationState,
  formatOffensiveOperationSummary,
  getOffensiveOperationForFront,
  getOffensiveOperationForUnit,
  getOffensiveOperations,
  updateOffensiveOperations,
  type OffensiveOperation,
} from "../../src/sim/offensive-operations";
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
    frontAllocations: createNationFrontAllocationState(),
    offensiveOperations: createOffensiveOperationState(),
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
