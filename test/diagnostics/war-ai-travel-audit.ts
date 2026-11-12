import { readFile, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createMarchTravelObserver } from "../helpers/march-travel-observer";
import { withMutedSimulationLogs } from "../helpers/muted-logs";
import type { WorldState } from "../../src/sim/world-state";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const root = resolve(option("--engine-root", "."));
const load = (path: string) => import(pathToFileURL(resolve(root, path)).href);
const { createScenarioWorld } = await load("test/scenarios/index.ts");
const { runSimulation } = await load("test/helpers/simulation-driver.ts");
const { summarizeWorld } = await load("test/helpers/world-summary.ts");
const { BenchmarkMetrics } = await load("test/benchmark/metrics.ts");
const { createWarOutcomeObserver } = await load("test/benchmark/war-outcome-observer.ts");
const ticks = Number(option("--ticks", "10000")), seeds = Number(option("--seeds", "20"));
const seedStart = Number(option("--seed-start", "822748319780"));
if (![ticks, seeds, seedStart].every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error("Invalid count");
const campaign = args.includes("--campaign");
const scenarios = option("--scenarios", "stalemate-breaker,reorganization-heavy").split(",");
if (execFileSync("git", ["-C", root, "diff", "--", "src"], { encoding: "utf8" })) throw new Error("Commit engine source first");
const output = option("--output", "diagnostics/war-ai-travel-audit.json.gz");
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
let report = {
  revision: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  sourceTree: execFileSync("git", ["-C", root, "rev-parse", "HEAD:src"], { encoding: "utf8" }).trim(),
  harnessHash: hash(await readFile(new URL(import.meta.url))),
  observerHash: hash(await readFile(new URL("../helpers/march-travel-observer.ts", import.meta.url))),
  measurementPhase: "after-reposition-before-battle-and-slow-ai",
  runtime: { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch },
  ticks, seeds, seedStart, campaign, scenarios, results: [] as ReturnType<typeof episode>[],
  note: "Read-only endpoint travel audit. Enemy-blocked edges are excluded. Ordinary mission requires unchanged front/revision and no special ownership. Also report unconditional unblocked retargets and exposure denominators; shorter wars alone do not prove better travel. No speed or battle rule is changed.",
};
try {
  const saved = JSON.parse(gunzipSync(await readFile(output)).toString());
  for (const key of ["sourceTree", "harnessHash", "observerHash", "measurementPhase", "runtime", "ticks", "seeds", "seedStart", "campaign", "scenarios"] as const) {
    if (JSON.stringify(saved[key]) !== JSON.stringify(report[key])) throw new Error(`Incompatible ${key}`);
  }
  report = saved;
} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
for (let i = 0; i < seeds; i++) for (const scenario of scenarios) {
  const seed = seedStart + i;
  if (report.results.some((row) => row.seed === seed && row.scenario === scenario)) continue;
  report.results.push(withMutedSimulationLogs(() => episode(seed, scenario)));
  await writeFile(`${output}.tmp`, gzipSync(JSON.stringify(report))); await rename(`${output}.tmp`, output);
  console.log(`${scenario} ${seed}: ${report.results.length}/${seeds * scenarios.length}`);
}

function episode(seed: number, scenario: string) {
  const world: WorldState = createScenarioWorld(scenario, { seed, width: 640, height: 360, quick: true,
    reserveEnabled: true, reorganizationEnabled: true, exploitationEnabled: true, pocketReductionEnabled: true,
    config: { systems: { warCampaignEnabled: campaign, diplomacyEnabled: true, mobilizationEnabled: true,
      researchEnabled: true, armsAidEnabled: true, tradeEnabled: true, politicalTurbulenceEnabled: true } } });
  world.wars.forEach((war) => { war.isTest = false; });
  const startFingerprint = hash(Buffer.from(JSON.stringify({ units: world.units, wars: world.wars,
    macroRegions: world.macroRegions, resources: world.nations.map((nation) => [nation.id, nation.resources]) })));
  const travel = createMarchTravelObserver(), outcomes = createWarOutcomeObserver();
  class TravelMetrics extends BenchmarkMetrics {
    recordDuration(name: string, ms: number) {
      super.recordDuration(name, ms);
      if (name === "repositionUnits") travel.observe(world);
    }
  }
  const metrics = new TravelMetrics();
  travel.observe(world);
  runSimulation(world, { ticks, metrics, observe(current: WorldState) {
    outcomes.observe(current);
  } });
  return { seed, scenario, startFingerprint, travel: travel.result(),
    warOutcomes: outcomes.result(), endWorld: summarizeWorld(world),
    episodeSurvival: Object.fromEntries(world.nations.map((nation) => [nation.id, nation.macroRegionIds.length > 0])),
    counters: metrics.getCounters() };
}
