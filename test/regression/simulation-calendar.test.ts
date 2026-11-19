import assert from "node:assert/strict";
import test from "node:test";
import { concludePeace } from "../../src/sim/diplomatic-peace";
import { getRelation, hasTreaty, proposeTreaty } from "../../src/sim/diplomacy";
import { getNationalPolitics, updateNationalPolitics } from "../../src/sim/politics";
import { getNationalResearchSummary, getResearchCost, getResearchPortfolio } from "../../src/sim/research";
import {
  createSimClock, DAYS_PER_YEAR, daysToFastTicks, daysToSlowTicks, FAST_TICK_MS,
  fastTicksToDays, formatWorldDate, getSpeedMultiplier, remainingDays,
  remainingDaysUntilSlowTick, setSpeedIndex, slowTicksToDays, yearsToDays,
} from "../../src/sim/time";
import { stepSimulationDay, updateSimulation } from "../../src/sim/update";
import { declareWar } from "../../src/sim/war-state";
import { createFixedSocietyWorld } from "../helpers/fixed-society-world";
import { semanticWorldSignature } from "../helpers/invariants";

test("the calendar advances daily and starts a new year after 365 elapsed days", () => {
  const world = createFixedSocietyWorld();
  assert.equal(formatWorldDate(world.time.fastTick), "Year 1, day 1");
  stepSimulationDay(world);
  assert.equal(formatWorldDate(world.time.fastTick), "Year 1, day 2");
  for (let i = 1; i < 9; i++) stepSimulationDay(world);
  assert.equal(world.time.slowTick, 0);
  stepSimulationDay(world);
  assert.equal(slowTicksToDays(world.time.slowTick), fastTicksToDays(world.time.fastTick));
  assert.equal(formatWorldDate(364), "Year 1, day 365");
  assert.equal(formatWorldDate(daysToFastTicks(yearsToDays(1))), "Year 2, day 1");
  assert.equal(formatWorldDate(10_000), "Year 28, day 146");
  assert.equal((fastTicksToDays(10_000) / DAYS_PER_YEAR).toFixed(1), "27.4");
});

test("durations round up and expired deadlines have zero days left", () => {
  assert.equal(daysToFastTicks(0), 0);
  assert.equal(daysToFastTicks(0.25), 1);
  assert.equal(daysToSlowTicks(10), 1);
  assert.equal(daysToSlowTicks(10.25), 2);
  assert.equal(daysToSlowTicks(-1), 0);
  assert.equal(remainingDays(12, 10), 0);
  assert.equal(remainingDaysUntilSlowTick(19, 2), 1);
  assert.equal(remainingDaysUntilSlowTick(20, 2), 0);
  assert.equal(remainingDaysUntilSlowTick(23, 2), 0);
  for (const invalid of [NaN, Infinity, -Infinity]) {
    assert.throws(() => daysToSlowTicks(invalid), RangeError);
    assert.equal(formatWorldDate(invalid), "Unknown date");
  }
  assert.equal(formatWorldDate(-1), "Unknown date");
  assert.equal(formatWorldDate(0.5), "Unknown date");
});

test("playback frame batching preserves warfare and society at the same world day", () => {
  const days = 160;
  const run = (speedIndex: number, daysPerFrame: number) => {
    const world = createFixedSocietyWorld();
    const [a, b] = world.nations;
    declareWar(world.wars, a.id, b.id, 0);
    Object.assign(a.resources, { steel: 1000, weapons: 1000, copper: 100 });
    const program = getResearchPortfolio(world, a.id);
    program.levels.firepower = 20;
    program.focus = "firepower";
    program.progress.firepower = getResearchCost(program, "firepower") - 0.001;
    const clock = createSimClock();
    setSpeedIndex(clock, speedIndex);
    const speed = getSpeedMultiplier(clock);
    for (let scheduled = 0; scheduled < days; scheduled += daysPerFrame) {
      updateSimulation(world, clock, daysPerFrame * FAST_TICK_MS / speed);
    }
    // A busy frame can defer queued days. Give the loop frames to finish its backlog.
    for (let frame = 0; frame < days && world.time.fastTick < days; frame++) {
      updateSimulation(world, clock, 0.001);
    }
    assert.equal(world.time.fastTick, days);
    assert.equal(world.time.slowTick, 16);
    assert.equal(program.levels.firepower, 21);
    return {
      simulation: semanticWorldSignature(world),
      society: world.nations.map(({ politics, treasury, food }) => ({ politics, treasury, food })),
      diplomacy: world.diplomacy,
      research: world.research,
      events: world.events,
    };
  };
  assert.deepEqual(run(2, 1), run(7, 8));
});

test("elections repeat every four years and royal succession is staggered over decades", () => {
  const world = createFixedSocietyWorld();
  const politics = world.nations.map((nation) => getNationalPolitics(world, nation));
  const democracy = politics.find((item) => item.system === "democracy")!;
  const monarchy = politics.find((item) => item.system === "monarchy")!;
  assert(democracy && monarchy);
  const election = democracy.nextMandateAt;
  assert(slowTicksToDays(election) >= yearsToDays(3.5));
  assert(slowTicksToDays(election) <= yearsToDays(4));
  assert(slowTicksToDays(monarchy.nextMandateAt) >= yearsToDays(20));
  assert(slowTicksToDays(monarchy.nextMandateAt) <= yearsToDays(35));
  world.time.slowTick = election - 1;
  updateNationalPolitics(world);
  assert.equal(democracy.nextMandateAt, election);
  world.time.slowTick = election;
  updateNationalPolitics(world);
  assert.equal(slowTicksToDays(democracy.nextMandateAt - election), yearsToDays(4));
});

test("a trade agreement and a postwar truce last about five years and expire at the deadline", () => {
  const world = createFixedSocietyWorld();
  const [a, b, c] = world.nations;
  Object.assign(getRelation(world, a.id, b.id), { opinion: 80, trust: 80 });
  assert(proposeTreaty(world, a.id, b.id, "trade"));
  declareWar(world.wars, a.id, c.id, 0);
  assert(concludePeace(world, a.id, c.id));
  for (const [partner, type] of [[b, "trade"], [c, "truce"]] as const) {
    const deadline = getRelation(world, a.id, partner.id).treaties.find((item) => item.type === type)!.expiresAtSlowTick;
    assert.equal(deadline, 183);
    world.time.slowTick = deadline - 1;
    assert(hasTreaty(world, a.id, partner.id, type));
    world.time.slowTick = deadline;
    assert(!hasTreaty(world, a.id, partner.id, type));
  }
});

test("research advances once per ten days while tax and food settle every 100 days", () => {
  const world = createFixedSocietyWorld();
  const [nation] = world.nations;
  Object.assign(nation.resources, { steel: 1000, weapons: 1000, copper: 100 });
  const program = getResearchPortfolio(world, nation.id);
  program.levels.firepower = 10;
  program.focus = "firepower";
  program.progress.firepower = getResearchCost(program, "firepower") - 0.001;
  for (let i = 1; i <= 100; i++) {
    const before = getNationalResearchSummary(world, nation.id).totalScience;
    const lastFood = world.lastFoodTick, lastTax = world.lastTaxCollectionTick;
    stepSimulationDay(world);
    const science = getNationalResearchSummary(world, nation.id).totalScience;
    assert.equal(program.levels.firepower, i < 10 ? 10 : 11);
    if (i % 10 === 0) assert(science > before && science - before < 4);
    else assert.equal(science, before);
    if (i < 100) {
      assert.equal(world.lastFoodTick, lastFood);
      assert.equal(world.lastTaxCollectionTick, lastTax);
    } else {
      assert.equal(world.lastFoodTick, 10);
      assert.equal(world.lastTaxCollectionTick, 10);
    }
  }
});
