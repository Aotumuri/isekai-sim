import assert from "node:assert/strict";
import test from "node:test";
import type { MesoRegionId } from "../../src/worldgen/meso-region";
import { createScenarioWorld } from "../scenarios";

test("two-island amphibious scenario has exactly two isolated balanced combatants", () => {
  const world = createScenarioWorld("two-island-amphibious", {
    seed: 695_919_685_365, width: 640, height: 360, quick: true,
  });
  assert.equal(world.nations.length, 2);
  assert.equal(world.wars.length, 1);
  assert.equal(world.macroRegions.length, 2);
  assert.deepEqual(world.nations.map((nation) => nation.macroRegionIds.length), [1, 1]);
  assert.equal(countLandComponents(world), 2);
  assert.equal(countEnemyLandEdges(world), 0);
  assert.deepEqual(world.nations.map((nation) =>
    world.mesoRegions.filter((region) => region.building === "port" &&
      world.macroRegions.some((macro) => macro.nationId === nation.id && macro.mesoRegionIds.includes(region.id))).length), [2, 2]);
  assert.deepEqual(world.nations.map((nation) => nation.resources), [world.nations[0]!.resources, world.nations[0]!.resources]);
  assert.deepEqual(world.nations.map((nation) =>
    world.units.filter((unit) => unit.nationId === nation.id).length), [21, 21]);
});

function countLandComponents(world: ReturnType<typeof createScenarioWorld>): number {
  const byId = new Map(world.mesoRegions.map((region) => [region.id, region]));
  const seen = new Set<MesoRegionId>();
  let count = 0;
  for (const region of world.mesoRegions) {
    if (region.type === "sea" || seen.has(region.id)) continue;
    count += 1;
    const queue = [region.id];
    seen.add(region.id);
    for (let head = 0; head < queue.length; head += 1) for (const neighbor of byId.get(queue[head]!)?.neighbors ?? []) {
      if (byId.get(neighbor.id)?.type === "sea" || seen.has(neighbor.id)) continue;
      seen.add(neighbor.id);
      queue.push(neighbor.id);
    }
  }
  return count;
}

function countEnemyLandEdges(world: ReturnType<typeof createScenarioWorld>): number {
  const owner = new Map(world.macroRegions.flatMap((macro) => macro.mesoRegionIds.map((id) => [id, macro.nationId] as const)));
  const byId = new Map(world.mesoRegions.map((region) => [region.id, region]));
  let edges = 0;
  for (const region of world.mesoRegions) for (const neighbor of region.neighbors) {
    if (region.id >= neighbor.id || region.type === "sea" || byId.get(neighbor.id)?.type === "sea") continue;
    if (owner.get(region.id) !== owner.get(neighbor.id)) edges += 1;
  }
  return edges;
}
