import assert from "node:assert/strict";
import test from "node:test";
import { createScenarioWorld } from "../scenarios";
import { createWarOutcomeObserver } from "../benchmark/war-outcome-observer";
import { runBenchmark } from "../benchmark/benchmark-runner";
import type { BenchmarkOptions } from "../benchmark/types";

test("war outcome observer retains opening targets and records terminal wars", () => {
  const world = createScenarioWorld("active-war", { seed: 822_748_319_788, quick: true, width: 640, height: 360 });
  const observer = createWarOutcomeObserver();
  observer.observe(world);
  const goals = observer.result().wars.map((outcome) => [...outcome.objectiveIds]);
  assert.equal(goals.length, world.wars.length * 2);
  world.wars[0].ultimatumRegionIds = [world.nations[0].capitalMesoId];
  world.time.fastTick = 8;
  world.wars = [];
  observer.observe(world);
  assert.deepEqual(observer.result().wars.map((outcome) => outcome.objectiveIds), goals);
  assert.ok(observer.result().wars.every((outcome) => outcome.endedAtTick === 8));
  assert.equal(observer.result().activeWarTicks, 8);
  world.time.fastTick = 12;
  observer.observe(world);
  assert.equal(observer.result().activeWarTicks, 8);
});

test("optional war observation preserves deterministic simulation outcomes", () => {
  const options: BenchmarkOptions = {
    scenario: "active-war", seed: 822_748_319_788, quick: true, width: 640, height: 360,
    ticks: 300, mode: "throughput", speed: 32, frameDeltaMs: 1000 / 60,
    reserveEnabled: true, reorganizationEnabled: true, exploitationEnabled: true, pocketReductionEnabled: true,
  };
  const plain = runBenchmark(options);
  const observed = runBenchmark({ ...options, observeWarOutcomes: true });
  for (const key of ["units", "wars", "occupations", "operationsCompleted", "capitalFalls", "nationalWeaponsStock"] as const) {
    assert.equal(observed.endWorld[key], plain.endWorld[key], key);
  }
  assert.equal(plain.warOutcomes, undefined);
  assert.ok(observed.warOutcomes!.wars.length > 0);
});
