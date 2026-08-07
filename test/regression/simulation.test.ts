import assert from "node:assert/strict";
import test from "node:test";
import { runSimulation } from "../helpers/simulation-driver";
import { assertWorldInvariants, semanticWorldSignature } from "../helpers/invariants";
import { withMutedSimulationLogs } from "../helpers/muted-logs";
import { createTestScenario } from "../helpers/test-scenario";
import { FAST_TICK_MS, SLOW_TICK_MS } from "../../src/sim/time";
import { stepFastTick, stepSlowTick } from "../../src/sim/update";

test("fixed-seed active war keeps core world invariants", () => {
  const world = createTestScenario("active-war");
  const run = withMutedSimulationLogs(() => runSimulation(world, { ticks: 120 }));

  assert.equal(run.processedFastTicks, 120);
  assert(run.metrics.getCounter("pathfinding.bfs") > 0);
  assert(run.metrics.getCounter("occupation.fullRegionScans") === 120);
  assertWorldInvariants(world);
});

test("fixed seed and fixed throughput ticks are deterministic", () => {
  const worldA = createTestScenario("active-war");
  const worldB = createTestScenario("active-war");
  withMutedSimulationLogs(() => {
    runSimulation(worldA, { ticks: 40 });
    runSimulation(worldB, { ticks: 40 });
  });

  assert.deepEqual(semanticWorldSignature(worldA), semanticWorldSignature(worldB));
});

test("enabling instrumentation does not change simulation state", () => {
  const instrumented = createTestScenario("active-war");
  const productionLike = createTestScenario("active-war");
  withMutedSimulationLogs(() => {
    runSimulation(instrumented, { ticks: 40 });
    for (let i = 0; i < 40; i += 1) {
      stepFastTick(productionLike, FAST_TICK_MS);
      const dueSlowTicks = Math.floor(productionLike.time.elapsedMs / SLOW_TICK_MS);
      while (productionLike.time.slowTick < dueSlowTicks) {
        stepSlowTick(productionLike, SLOW_TICK_MS);
      }
    }
  });

  assert.equal(productionLike.instrumentation, undefined);
  assert.deepEqual(
    semanticWorldSignature(instrumented),
    semanticWorldSignature(productionLike),
  );
});

test("late-game scenario keeps active and extinct nations in a valid world", () => {
  const world = withMutedSimulationLogs(() => createTestScenario("late-game"));
  assert(world.nations.some((nation) => nation.macroRegionIds.length === 0));
  assert(world.nations.some((nation) => nation.macroRegionIds.length > 0));
  assert(world.occupation.mesoById.size > 0);

  withMutedSimulationLogs(() => runSimulation(world, { ticks: 30 }));
  assertWorldInvariants(world);
});
