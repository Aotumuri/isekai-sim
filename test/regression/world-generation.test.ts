import assert from "node:assert/strict";
import test from "node:test";
import { createWorldConfig } from "../../src/data/world-config";
import { SeededRng } from "../../src/utils/seeded-rng";
import { applyDrainageRivers } from "../../src/worldgen/apply/drainage-rivers";
import { generateMesoRegions } from "../../src/worldgen/generate/meso-regions";
import { generateNations } from "../../src/worldgen/generate/nations";
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
