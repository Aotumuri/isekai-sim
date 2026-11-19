import assert from "node:assert/strict";
import { createSimulationSettings } from "../../src/sim/simulation-settings";
import type { SimulationCounterName, SimulationMetricName } from "../../src/sim/instrumentation";
import { DAYS_PER_SLOW_TICK } from "../../src/sim/time";
import { stepSimulationDay } from "../../src/sim/update";
import { createSeededWorld } from "../helpers/seeded-world";
import { withMutedSimulationLogs } from "../helpers/muted-logs";
import { observeWorldHistory } from "./world-history-observer";
import { createFlowTotals, sampleFlows, summarizeWorld } from "./world-checkpoint";

const [scenario, rawSeed, ...rawDays] = process.argv.slice(2);
assert(["quick", "quick-default", "medium", "scale", "dense"].includes(scenario ?? ""),
  "Usage: long-term-world.ts quick|quick-default|medium|scale|dense SEED DAY [DAY...]");
const seed = Number(rawSeed), days = rawDays.map(Number);
assert(Number.isSafeInteger(seed) && seed >= 0);
assert(days.length && days.every((day, index) => Number.isSafeInteger(day) && day > (days[index - 1] ?? 0)));
const optionalSystems = ["warCampaignEnabled", "politicalTurbulenceEnabled", "defeatedFormationsEnabled"] as const;
const disabled = process.env.WORLD_DISABLE;
assert(!disabled || optionalSystems.some((system) => system === disabled), "Unknown WORLD_DISABLE setting");
const settings = createSimulationSettings(scenario === "quick-default" ? {} : {
  warCampaignEnabled: disabled !== "warCampaignEnabled",
  politicalTurbulenceEnabled: disabled !== "politicalTurbulenceEnabled",
  defeatedFormationsEnabled: disabled !== "defeatedFormationsEnabled",
});
const world = withMutedSimulationLogs(() => createSeededWorld({
  seed, quick: scenario.startsWith("quick"), config: {
    systems: settings,
    ...(scenario === "scale" || scenario === "dense" ? {
      nationTargetMacroRegionsPerNation: 1,
      nationMacroRegionSizeRange: scenario === "dense" ? { min: 2, max: 4 } : { min: 7, max: 11 },
    } : {}),
  },
}));
const timings: Partial<Record<SimulationMetricName, number>> = {};
const counters: Partial<Record<SimulationCounterName, number>> = {};
if (process.env.WORLD_METRICS === "1") world.instrumentation = {
  recordDuration(name, ms) { timings[name] = (timings[name] ?? 0) + ms; },
  incrementCounter(name, amount = 1) { counters[name] = (counters[name] ?? 0) + amount; },
};
const history = observeWorldHistory(world);
const flows = createFlowTotals();
let previous = 0, peakUnits = world.units.length, warDays = 0, unitDays = 0;
let fastMs = 0, slowMs = 0;
const cpu = process.cpuUsage(), start = performance.now();
console.log(JSON.stringify({ scenario, seed, settings, instrumented: !!world.instrumentation,
  initial: summarizeWorld(world), districts: world.mesoRegions.length, days }));
for (const day of days) {
  console.info = history.observeLog;
  try {
    while (world.time.fastTick < day) {
      if (world.instrumentation) {
        const t = performance.now();
        stepSimulationDay(world);
        if (world.time.fastTick % DAYS_PER_SLOW_TICK === 0) slowMs += performance.now() - t;
        else fastMs += performance.now() - t;
      } else stepSimulationDay(world);
      history.sampleDay();
      if (world.time.fastTick % DAYS_PER_SLOW_TICK === 0) sampleFlows(world, flows);
      warDays += world.wars.length;
      unitDays += world.units.length;
      peakUnits = Math.max(peakUnits, world.units.length);
    }
  } finally {
    history.restoreLog();
  }
  const elapsed = performance.now() - start;
  const usage = process.cpuUsage(cpu);
  global.gc?.();
  console.log(JSON.stringify({ day, since: previous, ...summarizeWorld(world), peakUnits, warDays, unitDays, flows,
    historyCounts: history.counts, wallMs: elapsed, cpuMs: (usage.user + usage.system) / 1000,
    peakRssKiB: process.resourceUsage().maxRSS, heapBytes: process.memoryUsage().heapUsed,
    ...(world.instrumentation ? { fastOnlyMs: fastMs, cycleBoundaryMs: slowMs, timings, counters } : {}),
  }));
  previous = day;
}
console.log(JSON.stringify({ history: history.timeline, historyCounts: history.counts }));
