import assert from "node:assert/strict";
import test from "node:test";
import { updateCapitals } from "../../src/sim/capitals";
import { isNationActive } from "../../src/sim/nation-active";
import { BenchmarkMetrics } from "../benchmark/metrics";
import { createTestScenario } from "../helpers/test-scenario";

test("nation becomes inactive without deleting its object and can become active again", () => {
  const world = createTestScenario("base-world");
  const nation = world.nations.find((candidate) => candidate.macroRegionIds.length > 0);
  assert(nation);
  const originalMacroIds = [...nation.macroRegionIds];

  nation.macroRegionIds = [];
  assert.equal(isNationActive(nation), false);
  assert(world.nations.includes(nation));

  nation.macroRegionIds = originalMacroIds;
  assert.equal(isNationActive(nation), true);
});

test("inactive nations are skipped by capital scanning", () => {
  const world = createTestScenario("base-world");
  const inactive = world.nations[0];
  assert(inactive);
  inactive.macroRegionIds = [];
  const expectedActive = world.nations.filter(isNationActive).length;
  const metrics = new BenchmarkMetrics();
  world.instrumentation = metrics;

  updateCapitals(world);

  assert.equal(metrics.getCounter("capitals.activeNationScans"), expectedActive);
  assert.equal(isNationActive(inactive), false);
});
