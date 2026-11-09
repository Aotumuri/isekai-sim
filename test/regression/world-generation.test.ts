import assert from "node:assert/strict";
import test from "node:test";
import { WORLD_BALANCE } from "../../src/data/balance";
import { createWorld } from "../../src/sim/create-world";
import { createDefaultWorldConfig, createWorldConfig } from "../../src/data/world-config";
import { getOwnerByMesoId } from "../../src/sim/world-cache";
import { SeededRng } from "../../src/utils/seeded-rng";
import { applyDrainageRivers } from "../../src/worldgen/apply/drainage-rivers";
import { generateMesoRegions } from "../../src/worldgen/generate/meso-regions";
import { generateNations } from "../../src/worldgen/generate/nations";
import { growTerrainBorders } from "../../src/worldgen/generate/terrain-borders";
import { createMesoRegionId, type MesoRegion } from "../../src/worldgen/meso-region";
import { createMicroRegionId, type MicroRegion } from "../../src/worldgen/micro-region";

test("tiny islands become water and larger islands retain a port even when cities fill the coast", () => {
  // Three land components share a sea region. Only the middle one is too small.
  const edges = [[0, 1], [1, 2], [2, 8], [3, 4], [3, 8], [5, 6], [6, 7], [5, 8], [7, 8]];
  const microRegions: MicroRegion[] = Array.from({ length: 9 }, (_, index) => ({
    id: createMicroRegionId(index),
    site: { x: index, y: 0 },
    polygon: [],
    neighbors: edges.flatMap(([a, b]) =>
      a === index ? [createMicroRegionId(b)] : b === index ? [createMicroRegionId(a)] : []),
    elevation: index === 8 ? 0.05 : 0.8,
    isSea: index === 8,
    isRiver: false,
    mesoRegionId: null,
  }));
  const config = {
    ...createWorldConfig(100, 100),
    mesoLandCenterRatio: 1,
    nationMinCitiesPerNation: 3,
  };
  const rng = new SeededRng(1);
  const mesoRegions = generateMesoRegions(microRegions, config, rng);
  const { macroRegions, nations } = generateNations(mesoRegions, config, rng);

  for (const micro of microRegions.slice(3, 5)) {
    assert.equal(micro.isSea, true);
    assert.equal(micro.elevation, config.elevationSeaLevel);
    const region = mesoRegions.find((item) => item.id === micro.mesoRegionId);
    assert.equal(region?.type, "sea");
    assert.equal(region.building, null);
    assert.equal(region.resource, null);
  }
  assert.equal(nations.length, 2);
  const island = microRegions.slice(5, 8).map((micro) => mesoRegions.find((item) => item.id === micro.mesoRegionId)!);
  assert.equal(island.filter((region) => region.building === "port").length, 1);
  assert.equal(island.filter((region) => region.building === "capital").length, 1);
  assert.equal(macroRegions.flatMap((macro) => macro.mesoRegionIds).length, 6);
});

test("historical drainage joins tributaries across a depression and reaches the sea", () => {
  const links = [[0, 1], [1, 2], [2, 3], [3, 4], [3, 5], [4, 6], [5, 7]];
  const elevations = [0.05, 0.2, 0.5, 0.3, 0.7, 0.8, 0.9, 1];
  const regions: MicroRegion[] = elevations.map((elevation, index) => ({
    id: createMicroRegionId(index),
    site: { x: index, y: 50 },
    polygon: [],
    neighbors: links.flatMap(([a, b]) =>
      a === index ? [createMicroRegionId(b)] : b === index ? [createMicroRegionId(a)] : []),
    elevation,
    isSea: index === 0,
    isRiver: false,
    mesoRegionId: null,
  }));
  const edges = links.map(([a, b]) => ({
    a: createMicroRegionId(a), b: createMicroRegionId(b), hasRiver: false,
  }));
  const config = createWorldConfig(100, 100);
  applyDrainageRivers(regions, edges, config);
  assert.deepEqual(edges.map(({ hasRiver }) => hasRiver), [true, true, true, false, false, false, false]);
  assert.deepEqual(regions.filter(({ isRiver }) => isRiver).map(({ id }) => id),
    [1, 2, 3].map(createMicroRegionId));
  assert.deepEqual(regions.map(({ elevation }) => elevation), elevations);

  applyDrainageRivers(regions, edges, { ...config, riverSourceCount: 0 });
  assert.ok(edges.every(({ hasRiver }) => !hasRiver));
  assert.ok(regions.every(({ isRiver }) => !isRiver));
});

test("balance selects reproducible historical maps with terrain-dependent deposits", () => {
  const previous = WORLD_BALANCE.mapGenerator;
  const config = { ...createWorldConfig(800, 450, 10_000), seed: 17 };
  try {
    Object.assign(WORLD_BALANCE, { mapGenerator: "legacy" });
    const legacy = createWorld(config);
    Object.assign(WORLD_BALANCE, { mapGenerator: "historical" });
    const world = createWorld(config);
    const repeated = createWorld(config);
    assert.deepEqual(world.microRegions, repeated.microRegions);
    assert.deepEqual(world.mesoRegions, repeated.mesoRegions);
    assert.notDeepEqual(world.microRegions.map(({ isSea }) => isSea),
      legacy.microRegions.map(({ isSea }) => isSea));
    assert.ok(world.microRegionEdges.some(({ hasRiver }) => hasRiver));

    const elevationById = new Map(world.microRegions.map(({ id, elevation }) => [id, elevation]));
    const depositHeight = (resource: "steel" | "fuel") => {
      const cells = world.mesoRegions.filter((region) => region.resource === resource)
        .flatMap(({ microRegionIds }) => microRegionIds);
      assert.ok(cells.length > 0);
      return cells.reduce((sum, id) => sum + elevationById.get(id)!, 0) / cells.length;
    };
    assert.ok(depositHeight("steel") > depositHeight("fuel"));
  } finally {
    Object.assign(WORLD_BALANCE, { mapGenerator: previous });
  }
});

test("historical seeds produce connected land, separate continents, and a sea with an outlet", () => {
  const previous = WORLD_BALANCE.mapGenerator;
  const config = createWorldConfig(600, 340, 12_000);
  try {
    Object.assign(WORLD_BALANCE, { mapGenerator: "historical" });
    const single = createWorld({ ...config, seed: 2 });
    const multiple = createWorld({ ...config, seed: 1 });
    for (const [world, expected] of [[single, 1], [multiple, 2]] as const) {
      const remaining = new Map(world.microRegions.filter((region) => !region.isSea)
        .map((region) => [region.id, region]));
      let continents = 0;
      for (const region of remaining.values()) {
        const land = collectConnectedRegions(region, remaining);
        if (land.length > world.microRegions.length * 0.10) continents += 1;
      }
      assert.equal(continents, expected);
    }

    for (const seed of [4, 7, 15, 21]) {
      const inland = createWorld({ ...config, seed });
      const distanceToCenter = ({ site }: MicroRegion) =>
        Math.hypot(site.x - config.width / 2, site.y - config.height / 2);
      const center = inland.microRegions.reduce((closest, region) =>
        distanceToCenter(region) < distanceToCenter(closest) ? region : closest);
      assert.ok(center.isSea, `seed ${seed} should have water near the center`);
      const sea = new Map(inland.microRegions.filter((region) => region.isSea)
        .map((region) => [region.id, region]));
      const waters = collectConnectedRegions(center, sea);
      assert.ok(waters.some((region) => region.polygon.some(({ x }) => x === 0 || x === config.width)),
        `seed ${seed} should have an outlet to open water`);
    }
  } finally {
    Object.assign(WORLD_BALANCE, { mapGenerator: previous });
  }
});

test("the larger default map varies the orientation of its three major landmasses", () => {
  const config = createDefaultWorldConfig();
  assert.ok(config.width > 2560 && config.height > 1440);
  assert.ok(config.microRegionCount > 210_000);

  const orientations = new Set<string>();
  for (const seed of [1, 2, 3, 6, 17, 21, 57, 64, 76]) {
    const world = createWorld({ ...config, seed, microRegionCount: 12_000 });
    const remaining = new Map(world.microRegions.filter((region) => !region.isSea)
      .map((region) => [region.id, region]));
    const continents: MicroRegion[][] = [];
    for (const region of remaining.values()) {
      const land = collectConnectedRegions(region, remaining);
      if (land.length > world.microRegions.length * 0.05) continents.push(land);
    }
    assert.equal(continents.length, 3, `seed ${seed}`);
    const [largest, , smallest] = continents.sort((a, b) => b.length - a.length);
    assert.ok(largest!.length > smallest!.length * 1.5, `seed ${seed}`);
    const xs = largest!.map(({ site }) => site.x);
    const ys = largest!.map(({ site }) => site.y);
    const width = (Math.max(...xs) - Math.min(...xs)) / config.width;
    const height = (Math.max(...ys) - Math.min(...ys)) / config.height;
    orientations.add(width > height ? "horizontal" : "vertical");
  }
  assert.equal(orientations.size, 2);
});

test("terrain-driven frontiers can follow a river away from the midpoint", () => {
  const config = { ...createWorldConfig(200, 100), seed: 1 };
  const neighbors = Array.from({ length: 9 }, (_, index) => [index - 1, index + 1].filter((id) => id >= 0 && id < 9));
  const regions: MesoRegion[] = neighbors.map((adjacent, index) => ({
    id: createMesoRegionId(index), center: { x: 15 + index * 20, y: 50 },
    centerId: createMicroRegionId(index), microRegionIds: [], type: "land", building: null, resource: null,
    neighbors: adjacent.map((id) => ({ id: createMesoRegionId(id), hasRiver: false })),
  }));
  const owners = () => growTerrainBorders(regions, [], [0, 8], neighbors, config).ownerByIndex;
  assert.equal(owners()[3], 0);
  regions[2]!.neighbors.find(({ id }) => id === regions[3]!.id)!.hasRiver = true;
  regions[3]!.neighbors.find(({ id }) => id === regions[2]!.id)!.hasRiver = true;
  assert.deepEqual(owners(), [0, 0, 0, 1, 1, 1, 1, 1, 1]);
});

test("terrain-driven frontiers leave every land district connected to its capital", () => {
  const config = createDefaultWorldConfig();
  for (const seed of [0, 17, 103]) {
    const world = createWorld({ ...config, seed, microRegionCount: 32_000, nationTargetMacroRegionsPerNation: 3 });
    const owners = getOwnerByMesoId(world);
    assert.equal(owners.size, world.mesoRegions.filter(({ type }) => type !== "sea").length);
    const districts = new Map(world.mesoRegions.map((region) => [region.id, region]));
    for (const nation of world.nations) {
      const owned = new Set([...owners].filter(([, owner]) => owner === nation.id).map(([id]) => id));
      const reached = [nation.capitalMesoId];
      assert.ok(owned.delete(nation.capitalMesoId));
      for (const id of reached) for (const neighbor of districts.get(id)!.neighbors) {
        if (owned.delete(neighbor.id)) reached.push(neighbor.id);
      }
      assert.equal(owned.size, 0, `seed ${seed}, ${nation.id}`);
    }
  }
});

function collectConnectedRegions(
  start: MicroRegion,
  remaining: Map<MicroRegion["id"], MicroRegion>,
): MicroRegion[] {
  remaining.delete(start.id);
  const connected = [start];
  for (const region of connected) {
    for (const id of region.neighbors) {
      const neighbor = remaining.get(id);
      if (!neighbor) continue;
      remaining.delete(id);
      connected.push(neighbor);
    }
  }
  return connected;
}
