import assert from "node:assert/strict";
import test from "node:test";
import {
  beginAiGeographyEvaluation,
  canReachControlled,
  clearAiGeographyCache,
  getAiGeographyStatistics,
  getConnectedComponent,
  getControlledDistanceField,
  getControlledRegions,
  getControlledTopology,
  getDistanceToFront,
  getDynamicSafetyLayer,
  getFrontDistanceField,
  nearestFront,
} from "../../src/sim/ai-geography";
import { isNationActive } from "../../src/sim/nation-active";
import { updateLandFronts } from "../../src/sim/land-fronts";
import type { MesoRegionId } from "../../src/worldgen/meso-region";
import type { NationId } from "../../src/worldgen/nation";
import { createTestScenario } from "../helpers/test-scenario";

test("controlled topology is reused while territory and occupation versions match", () => {
  const world = createTestScenario("active-war");
  const nationId = activeNationId(world);

  const first = getControlledTopology(world, nationId);
  const second = getControlledTopology(world, nationId);

  assert.strictEqual(second, first);
  assert.deepEqual(getAiGeographyStatistics(world), {
    topologyRequests: 2,
    topologyHits: 1,
    topologyRebuilds: 1,
    controlledDistanceRequests: 0,
    controlledDistanceHits: 0,
    controlledDistanceRebuilds: 0,
    frontDistanceRequests: 0,
    frontDistanceHits: 0,
    frontDistanceRebuilds: 0,
    safetyRequests: 0,
    safetyHits: 0,
    safetyRebuilds: 0,
  });
});

test("territory and occupation versions independently invalidate topology", () => {
  const world = createTestScenario("active-war");
  const nationId = activeNationId(world);
  const initial = getControlledTopology(world, nationId);

  world.territoryVersion += 1;
  const afterTerritory = getControlledTopology(world, nationId);
  assert.notStrictEqual(afterTerritory, initial);
  assert.equal(afterTerritory.territoryVersion, world.territoryVersion);

  world.occupation.version += 1;
  const afterOccupation = getControlledTopology(world, nationId);
  assert.notStrictEqual(afterOccupation, afterTerritory);
  assert.equal(afterOccupation.occupationVersion, world.occupation.version);
  assert.equal(getAiGeographyStatistics(world).topologyRebuilds, 3);
});

test("controlled topology never returns stale occupied regions", () => {
  const world = createTestScenario("active-war");
  const nationId = activeNationId(world);
  const enemyId = world.nations.find((nation) => nation.id !== nationId)?.id;
  const regionId = [...getControlledRegions(world, nationId)][0];
  assert(enemyId && regionId);

  world.occupation.mesoById.set(regionId, enemyId);
  world.occupation.version += 1;

  assert(!getControlledRegions(world, nationId).has(regionId));
});

test("connected-component and reachability APIs agree with shared topology", () => {
  const world = createTestScenario("active-war");
  const nationId = activeNationId(world);
  const topology = getControlledTopology(world, nationId);
  const regionIds = [...topology.controlledRegionIds];
  assert(regionIds.length > 0);

  for (const regionId of regionIds) {
    assert.equal(
      getConnectedComponent(world, nationId, regionId),
      topology.componentByRegionId.get(regionId),
    );
  }
  const source = regionIds[0];
  for (const target of regionIds) {
    assert.equal(
      canReachControlled(world, nationId, source, target),
      topology.componentByRegionId.get(source) ===
        topology.componentByRegionId.get(target),
    );
  }
});

test("controlled BFS is reused, invalidated, and deterministically rebuilt", () => {
  const world = createTestScenario("active-war");
  const nationId = activeNationId(world);
  const source = [...getControlledRegions(world, nationId)][0];
  assert(source);
  const first = getControlledDistanceField(world, nationId, [source]);
  const second = getControlledDistanceField(world, nationId, [source, source]);
  assert.strictEqual(second, first);

  const expected = sortedEntries(first.distanceByRegionId);
  clearAiGeographyCache(world);
  const rebuilt = getControlledDistanceField(world, nationId, [source]);
  assert.notStrictEqual(rebuilt, first);
  assert.deepEqual(sortedEntries(rebuilt.distanceByRegionId), expected);

  world.occupation.version += 1;
  const afterOccupation = getControlledDistanceField(world, nationId, [source]);
  assert.notStrictEqual(afterOccupation, rebuilt);
  assert.equal(afterOccupation.occupationVersion, world.occupation.version);
});

test("Front distance fields are reused and invalidated only by Front version", () => {
  const world = createTestScenario("active-war");
  updateLandFronts(world);
  const front = world.landFronts.physicalFronts[0];
  assert(front);
  const nationId = front.sideA.nationId;
  const first = getFrontDistanceField(world, front.id, nationId);
  const second = getFrontDistanceField(world, front.id, nationId);
  assert(first);
  assert.strictEqual(second, first);

  world.territoryVersion += 1;
  assert.strictEqual(getFrontDistanceField(world, front.id, nationId), first);

  world.landFronts.version += 1;
  const rebuilt = getFrontDistanceField(world, front.id, nationId);
  assert(rebuilt);
  assert.notStrictEqual(rebuilt, first);
  assert.deepEqual(
    sortedEntries(rebuilt.distanceByRegionId),
    sortedEntries(first.distanceByRegionId),
  );
});

test("Front distance convenience APIs are consistent with the cached fields", () => {
  const world = createTestScenario("active-war");
  updateLandFronts(world);
  const front = world.landFronts.physicalFronts[0];
  assert(front);
  const nationId = front.sideA.nationId;
  const field = getFrontDistanceField(world, front.id, nationId);
  assert(field);

  for (const [regionId, distance] of field.distanceByRegionId) {
    assert.equal(
      getDistanceToFront(world, front.id, nationId, regionId),
      distance,
    );
    const nearest = nearestFront(world, nationId, regionId);
    assert(nearest);
    assert(nearest.distance <= distance);
  }
});

test("dynamic safety is shared within an evaluation and refreshed across ticks", () => {
  const world = createTestScenario("active-war");
  const first = getDynamicSafetyLayer(world);
  assert.strictEqual(getDynamicSafetyLayer(world), first);

  beginAiGeographyEvaluation(world);
  const nextEvaluation = getDynamicSafetyLayer(world);
  assert.notStrictEqual(nextEvaluation, first);

  world.time.fastTick += 1;
  const nextTick = getDynamicSafetyLayer(world);
  assert.notStrictEqual(nextTick, nextEvaluation);
  assert.equal(nextTick.fastTick, world.time.fastTick);
});

function activeNationId(
  world: ReturnType<typeof createTestScenario>,
): NationId {
  const nation = world.nations.find(isNationActive);
  assert(nation);
  return nation.id;
}

function sortedEntries(
  values: ReadonlyMap<MesoRegionId, number>,
): Array<[MesoRegionId, number]> {
  return [...values].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
