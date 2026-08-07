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
  getLandFrontsForNation,
  updateLandFronts,
} from "../../src/sim/land-fronts";
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
  assert.deepEqual(fronts[0].friendlyBorderRegionIds, ids("a1", "a2"));
  assert.deepEqual(fronts[0].enemyBorderRegionIds, ids("b1", "b2"));
  assert.equal(fronts[0].borderLength, 2);
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

  assert.equal(world.landFronts.fronts.length, 0);
});

test("starting a war creates a front on the next front update", () => {
  const world = createSimpleBorderWorld();
  updateLandFronts(world);
  assert.equal(world.landFronts.fronts.length, 0);

  startWar(world, NATION_A, NATION_B);
  updateLandFronts(world);

  assert.equal(frontsBetween(world, NATION_A, NATION_B).length, 1);
  assert.equal(frontsBetween(world, NATION_B, NATION_A).length, 1);
});

test("ending a war removes its fronts", () => {
  const world = createSimpleBorderWorld();
  startWar(world, NATION_A, NATION_B);
  updateLandFronts(world);
  assert.equal(world.landFronts.fronts.length, 2);

  world.wars = [];
  updateLandFronts(world);

  assert.equal(world.landFronts.fronts.length, 0);
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
  assert.deepEqual(occupiedFront[0].enemyBorderRegionIds, ids("c1"));

  world.occupation.mesoById.delete(id("c1"));
  world.occupation.version += 1;
  updateLandFronts(world);

  assert.equal(frontsBetween(world, NATION_A, NATION_B).length, 0);
});

test("inactive nations do not receive or create fronts", () => {
  const world = createSimpleBorderWorld(new Set([NATION_B]));
  startWar(world, NATION_A, NATION_B);

  updateLandFronts(world);

  assert.equal(world.landFronts.fronts.length, 0);
  assert.equal(getLandFrontsForNation(world, NATION_B).length, 0);
});

test("front border lists contain unique valid region IDs", () => {
  const world = createThreeSegmentWorld(false);
  startWar(world, NATION_A, NATION_B);
  updateLandFronts(world);
  const validIds = new Set(world.mesoRegions.map((meso) => meso.id));

  for (const front of world.landFronts.fronts) {
    const friendly = new Set(front.friendlyBorderRegionIds);
    const enemy = new Set(front.enemyBorderRegionIds);
    assert.equal(friendly.size, front.friendlyBorderRegionIds.length);
    assert.equal(enemy.size, front.enemyBorderRegionIds.length);
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
  assert.deepEqual(front.friendlyUnitIds, [borderUnit.id, rearUnit.id].sort());
  assert(!front.friendlyUnitIds.includes(deepUnit.id));
  assert.deepEqual(front.enemyUnitIds, [enemyUnit.id]);
  assert.equal(
    front.friendlyStrength,
    getUnitCombatStrength(borderUnit) + getUnitCombatStrength(rearUnit),
  );
  assert.equal(front.nearbyFriendlyCityCount, 1);
  assert.equal(front.hasNearbyFriendlyCapital, true);
  assert.equal(front.hasNearbyEnemyCapital, true);
  for (const value of [front.friendlyStrength, front.enemyStrength, front.strengthRatio]) {
    assert(Number.isFinite(value));
  }
});

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
  return getLandFrontsForNation(world, nationId).filter(
    (front) => front.enemyNationId === enemyNationId,
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
