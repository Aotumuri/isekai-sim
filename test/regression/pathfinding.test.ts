import assert from "node:assert/strict";
import test from "node:test";
import { repositionUnits } from "../../src/sim/nation/reposition-units";
import { buildWarAdjacency, isAtWar } from "../../src/sim/war-state";
import { BenchmarkMetrics } from "../benchmark/metrics";
import { createTestScenario } from "../helpers/test-scenario";
import { buildOwnerByMesoId } from "../scenarios/scenario-utils";
import type { MesoRegionId } from "../../src/worldgen/meso-region";

test("shared next-hop hits remain adjacent and passable", () => {
  const world = createTestScenario("active-war");
  const metrics = new BenchmarkMetrics();
  world.instrumentation = metrics;
  repositionUnits(world, 0);
  resetMoveLegs(world);
  repositionUnits(world, 0);

  assert(metrics.getCounter("pathfinding.shared.hits") > 0);
  const owners = buildOwnerByMesoId(world);
  const mesoById = new Map(world.mesoRegions.map((meso) => [meso.id, meso]));
  const warAdjacency = buildWarAdjacency(world.wars);
  for (const unit of world.units) {
    if (!unit.moveToId) {
      continue;
    }
    assert(
      mesoById.get(unit.regionId)?.neighbors.some((neighbor) => neighbor.id === unit.moveToId),
      `${unit.id} received a non-adjacent next hop`,
    );
    const next = mesoById.get(unit.moveToId);
    const owner = owners.get(unit.moveToId);
    assert(next && next.type !== "sea" && owner);
    assert(owner === unit.nationId || isAtWar(unit.nationId, owner, warAdjacency));
  }
});

test("territory and war changes invalidate shared path fields", () => {
  const world = createTestScenario("active-war");
  warmSharedCache(world);

  const territoryMetrics = new BenchmarkMetrics();
  world.instrumentation = territoryMetrics;
  world.territoryVersion += 1;
  resetMoveLegs(world);
  repositionUnits(world, 0);
  assert.equal(
    territoryMetrics.getCounter("pathfinding.shared.invalidation.territory"),
    1,
  );

  const warMetrics = new BenchmarkMetrics();
  world.instrumentation = warMetrics;
  world.wars = [];
  resetMoveLegs(world);
  repositionUnits(world, 0);
  assert.equal(warMetrics.getCounter("pathfinding.shared.invalidation.wars"), 1);
});

test("occupation change discards the cached field for the changed target", () => {
  const world = createTestScenario("active-war");
  warmSharedCache(world);
  const unit = world.units.find(
    (candidate) => candidate.moveTargetId && candidate.moveTargetId !== candidate.regionId,
  );
  const otherNation = world.nations.find((nation) => nation.id !== unit?.nationId);
  assert(unit?.moveTargetId && otherNation);
  world.occupation.mesoById.set(unit.moveTargetId, otherNation.id);
  world.occupation.version += 1;
  const metrics = new BenchmarkMetrics();
  world.instrumentation = metrics;
  resetMoveLegs(world);

  repositionUnits(world, 0);

  assert.equal(metrics.getCounter("pathfinding.shared.invalidation.occupation"), 1);
  assert(metrics.getCounter("pathfinding.shared.fieldsDiscarded") > 0);
});

test("cached movement follows a strictly decreasing shortest-path distance", () => {
  const world = createTestScenario("base-world");
  world.instrumentation = new BenchmarkMetrics();
  repositionUnits(world, 0);
  const unit = world.units.find(
    (candidate) => candidate.moveTargetId && candidate.moveTargetId !== candidate.regionId,
  );
  assert(unit?.moveTargetId);
  const targetId = unit.moveTargetId;
  const owners = buildOwnerByMesoId(world);
  const mesoById = new Map(world.mesoRegions.map((meso) => [meso.id, meso]));
  const allowed = (id: MesoRegionId) =>
    owners.get(id) === unit.nationId && mesoById.get(id)?.type !== "sea";
  let previousDistance = shortestDistance(unit.regionId, targetId, mesoById, allowed);
  assert(Number.isFinite(previousDistance));
  const visited = new Set([unit.regionId]);
  let previousRegion = unit.regionId;

  for (let i = 0; i < 300 && unit.regionId !== targetId; i += 1) {
    repositionUnits(world, 100);
    assert.equal(unit.moveTargetId, targetId);
    if (unit.regionId === previousRegion) {
      continue;
    }
    assert(!visited.has(unit.regionId), `${unit.id} entered a path loop at ${unit.regionId}`);
    visited.add(unit.regionId);
    const distance = shortestDistance(unit.regionId, targetId, mesoById, allowed);
    assert.equal(distance, previousDistance - 1);
    previousDistance = distance;
    previousRegion = unit.regionId;
  }

  assert.equal(unit.regionId, targetId, `${unit.id} did not reach its target`);
});

function warmSharedCache(world: ReturnType<typeof createTestScenario>): void {
  world.instrumentation = new BenchmarkMetrics();
  repositionUnits(world, 0);
  resetMoveLegs(world);
  repositionUnits(world, 0);
}

function resetMoveLegs(world: ReturnType<typeof createTestScenario>): void {
  for (const unit of world.units) {
    if (!unit.moveTargetId || unit.moveTargetId === unit.regionId) {
      continue;
    }
    unit.moveFromId = null;
    unit.moveToId = null;
    unit.moveProgressMs = 0;
  }
}

function shortestDistance(
  startId: MesoRegionId,
  targetId: MesoRegionId,
  mesoById: Map<MesoRegionId, { neighbors: Array<{ id: MesoRegionId }> }>,
  isAllowed: (id: MesoRegionId) => boolean,
): number {
  const queue: Array<[MesoRegionId, number]> = [[startId, 0]];
  const visited = new Set<MesoRegionId>([startId]);
  for (let head = 0; head < queue.length; head += 1) {
    const [current, distance] = queue[head];
    if (current === targetId) {
      return distance;
    }
    for (const neighbor of mesoById.get(current)?.neighbors ?? []) {
      if (visited.has(neighbor.id) || !isAllowed(neighbor.id)) {
        continue;
      }
      visited.add(neighbor.id);
      queue.push([neighbor.id, distance + 1]);
    }
  }
  return Number.POSITIVE_INFINITY;
}
