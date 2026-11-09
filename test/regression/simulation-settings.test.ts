import assert from "node:assert/strict";
import test from "node:test";
import { createSimulationSettings, getWarDeclarationMode } from "../../src/sim/simulation-settings";
import { getNationCharacter } from "../../src/sim/nation-character";
import { updateWarDeclarations } from "../../src/sim/war-declaration";
import { createSocietyWorld } from "../helpers/society-world";

test("diplomacy overrides the legacy declaration scheduler and can be switched off", () => {
  const world = createSocietyWorld();
  for (const nation of world.nations) nation.nextWarDeclarationTick = 0;
  assert.equal(getWarDeclarationMode(world), "diplomacy");
  updateWarDeclarations(world);
  assert(world.nations.every((nation) => nation.nextWarDeclarationTick === 0));
  world.settings!.diplomacyEnabled = false;
  assert.equal(getWarDeclarationMode(world), "legacy");
  world.settings!.legacyWarDeclarationsEnabled = false;
  assert.equal(getWarDeclarationMode(world), "off");
  assert.equal(createSimulationSettings().researchEnabled, true);
});

test("national characters are deterministic and do not consume the simulation RNG", () => {
  const first = createSocietyWorld();
  const second = createSocietyWorld();
  const expected = first.nations.map((nation) => getNationCharacter(first, nation.id));
  second.nations.reverse();
  for (const nation of second.nations) assert.deepEqual(getNationCharacter(second, nation.id),
    expected[first.nations.findIndex((item) => item.id === nation.id)]);
  assert.equal(first.simRng.nextFloat(), second.simRng.nextFloat());
  assert(new Set(expected.map((character) => character.doctrine)).size > 1);
});

test("pausing stops time without banking a burst of catch-up ticks", async () => {
  const { createSimClock } = await import("../../src/sim/time");
  const { updateSimulation } = await import("../../src/sim/update");
  const world = createSocietyWorld(), clock = createSimClock();
  clock.paused = true;
  updateSimulation(world, clock, 10_000);
  assert.equal(world.time.fastTick, 0);
  assert.equal(clock.accumulatorMs, 0);
  clock.paused = false; clock.speedIndex = 2;
  updateSimulation(world, clock, 100);
  assert.equal(world.time.fastTick, 1);
});

test("slowing from x32 to x16 discards queued ticks and preserves slow-tick progress", async () => {
  const { createSimClock, decreaseSpeed, getSpeedMultiplier, setSpeedIndex } =
    await import("../../src/sim/time");
  const { stepFastTick, updateSimulation } = await import("../../src/sim/update");
  const world = createSocietyWorld();
  const clock = createSimClock();
  setSpeedIndex(clock, 7);
  for (let tick = 0; tick < 9; tick += 1) stepFastTick(world, 100);
  clock.accumulatorMs = 3_050;
  clock.slowAccumulatorMs = 3_950;

  assert.equal(decreaseSpeed(clock), true);
  assert.equal(getSpeedMultiplier(clock), 16);
  assert.equal(clock.accumulatorMs, 50);
  assert.equal(clock.slowAccumulatorMs, 950);

  updateSimulation(world, clock, 50 / 16);
  assert.equal(world.time.fastTick, 10);
  assert.equal(world.time.slowTick, 1);
  assert.equal(clock.accumulatorMs, 0);
  assert.equal(clock.slowAccumulatorMs, 0);
});
