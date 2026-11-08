import assert from "node:assert/strict";
import test from "node:test";
import { createWorldConfig } from "../../src/data/world-config";
import { SeededRng } from "../../src/utils/seeded-rng";
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
