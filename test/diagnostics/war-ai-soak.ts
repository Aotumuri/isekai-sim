import assert from "node:assert/strict";
import { mkdir, writeFile, rename } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createScenarioWorld } from "../scenarios";
import { runSimulation } from "../helpers/simulation-driver";
import { BenchmarkMetrics } from "../benchmark/metrics";
import type { WorldState } from "../../src/sim/world-state";

// Run with node --expose-gc --import tsx. GC samples are outside timed chunks.
const args = process.argv.slice(2);
function option(name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1] ?? "";
}
const ticks = Number(option("--ticks", "100000"));
const seeds = Number(option("--seeds", "3"));
const politicalTurbulence = args.includes("--political-turbulence");
if (![ticks, seeds].every((value) => Number.isSafeInteger(value) && value > 0)) throw new Error("Positive integer ticks/seeds required");
if (typeof global.gc !== "function") throw new Error("Run with --expose-gc for meaningful retained-heap samples");
const collect = global.gc;
const output = resolve(option("--output", "diagnostics/war-ai-soak.json"));
const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (execFileSync("git", ["diff", "--", "src"], { encoding: "utf8" })) throw new Error("Commit simulation source first");
interface Sample {
  tick: number; heapAfterGcBytes: number; rssBytes: number; elapsedMs: number; cpuMs: number;
  campaigns: number; goals: number; events: number; history: number; budgetFronts: number;
  wars: number; units: number;
}
interface Episode { seed: number; campaign: boolean; samples: Sample[]; complete: boolean; peak: ReturnType<typeof stateSize> }
const report = { revision, ticks, seeds, politicalTurbulence, quick: true, chunkTicks: 10000, episodes: [] as Episode[] };
const originalInfo = console.info;
console.info = () => undefined;
await mkdir(dirname(output), { recursive: true });
try {
  for (let index = 0; index < seeds; index += 1) {
    // Alternate arm order to avoid assigning all warmup costs to one arm.
    for (const campaign of index % 2 ? [true, false] : [false, true]) {
      await runEpisode(822_748_319_780 + index, campaign);
    }
  }
} finally {
  console.info = originalInfo;
}

async function save(): Promise<void> {
  await writeFile(`${output}.tmp`, `${JSON.stringify(report, null, 2)}\n`);
  await rename(`${output}.tmp`, output);
}

async function runEpisode(seed: number, campaign: boolean): Promise<void> {
  const world = createScenarioWorld("base-world", {
    seed, width: 640, height: 360, quick: true,
    config: { systems: { mobilizationEnabled: true, diplomacyEnabled: true, researchEnabled: true,
      armsAidEnabled: true, tradeEnabled: true, warCampaignEnabled: campaign,
      politicalTurbulenceEnabled: politicalTurbulence } },
  });
  const metrics = new BenchmarkMetrics();
  assert.equal(world.settings?.politicalTurbulenceEnabled, politicalTurbulence);
  const episode: Episode = { seed, campaign, samples: [], complete: false, peak: stateSize(world) };
  report.episodes.push(episode);
  let checkedSlowTick = -1;
  const observe = (state: WorldState) => {
    if (checkedSlowTick === state.time.slowTick) return;
    checkedSlowTick = state.time.slowTick;
    const size = stateSize(state);
    assert.ok(size.campaigns <= state.nations.length);
    assert.ok(size.goals <= state.wars.length * 2);
    assert.ok(size.events <= 200 && size.history <= 100);
    for (const key of Object.keys(size) as (keyof typeof size)[]) episode.peak[key] = Math.max(episode.peak[key], size[key]);
  };
  for (let processed = 0; processed < ticks;) {
    const count = Math.min(10000, ticks - processed);
    const cpuStart = process.cpuUsage();
    const run = runSimulation(world, { ticks: count, metrics, observe });
    const cpu = process.cpuUsage(cpuStart);
    processed += count;
    collect();
    const memory = process.memoryUsage();
    const regions = new Set(world.mesoRegions.map((region) => region.id));
    for (const plan of world.warCampaigns?.byNationId.values() ?? []) {
      assert.ok(world.nations.some((nation) => nation.id === plan.nationId && nation.macroRegionIds.length > 0));
      assert.ok(plan.objectives.every((goal) => goal.regionIds.every((id) => regions.has(id))));
    }
    assert.ok(world.units.every((unit) => Number.isFinite(unit.manpower) && Number.isFinite(unit.org) && regions.has(unit.regionId)));
    episode.samples.push({ tick: world.time.fastTick, heapAfterGcBytes: memory.heapUsed,
      rssBytes: memory.rss, elapsedMs: run.wallClockMs, cpuMs: (cpu.user + cpu.system) / 1000,
      ...stateSize(world), wars: world.wars.length, units: world.units.length });
    await save();
  }
  episode.complete = true;
  await save();
  console.log(`seed=${seed} campaign=${campaign}: ${ticks} ticks, heap=${episode.samples.at(-1)!.heapAfterGcBytes}`);
}

function stateSize(world: WorldState) {
  const state = world.warCampaigns;
  return { campaigns: state?.byNationId.size ?? 0,
    goals: [...state?.byNationId.values() ?? []].reduce((sum, plan) => sum + plan.objectives.length, 0),
    events: state?.events.length ?? 0, history: state?.goalHistory.length ?? 0,
    budgetFronts: state?.forceBudget?.remainingByFrontNation.size ?? 0 };
}
