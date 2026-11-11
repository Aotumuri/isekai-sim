import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { gzipSync, gunzipSync } from "node:zlib";
import { runBenchmark } from "../benchmark/benchmark-runner";
import type { BenchmarkResult, BenchmarkScenarioName } from "../benchmark/types";

// Incremental output allows long experiments to resume without rerunning rows.
// Never compare different horizons, world sizes, or combat rules as an AI A/B.
const scenarios: BenchmarkScenarioName[] = [
  "active-war", "long-frontline", "stalemate-breaker", "collapse-advance",
  "capital-threat", "retreat-heavy", "reorganization-heavy",
  "two-island-amphibious", "late-game", "base-world",
];
const args = process.argv.slice(2);
function option(name: string, fallback: string): string {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}
function positiveInteger(name: string, fallback: number): number {
  const value = Number(option(name, String(fallback)));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${name}`);
  return value;
}
const count = positiveInteger("--seeds", 20);
const ticks = positiveInteger("--ticks", 3200);
const partition = option("--partition", "development");
const fullSystems = args.includes("--full-systems");
const campaignEnabled = args.includes("--campaign");
const observeWarOutcomes = args.includes("--observe-wars");
if (!["development", "holdout"].includes(partition)) throw new Error("Invalid partition");
const seedStart = partition === "development" ? 822_748_319_780 : 922_748_319_780;
const output = resolve(option("--output", `diagnostics/war-ai-${partition}.json`));
const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["diff", "--", "src"], { encoding: "utf8" });
if (dirty) throw new Error("Commit simulation source before recording an experiment");
interface Experiment {
  revision: string;
  partition: string;
  ticks: number;
  seedStart: number;
  seedCount: number;
  fullSystems: boolean;
  campaignEnabled?: boolean;
  observeWarOutcomes?: boolean;
  scenarios: BenchmarkScenarioName[];
  results: BenchmarkResult[];
  failures: { scenario: string; seed: number; error: string }[];
}
let experiment: Experiment = {
  revision, partition, ticks, seedStart, seedCount: count, scenarios, fullSystems, campaignEnabled, observeWarOutcomes,
  results: [], failures: [],
};
try {
  const bytes = await readFile(output);
  const saved = JSON.parse((output.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8")) as Experiment;
  for (const key of ["revision", "partition", "ticks", "seedStart", "seedCount"] as const) {
    if (saved[key] !== experiment[key]) throw new Error(`Output has incompatible ${key}`);
  }
  if ((saved.fullSystems ?? false) !== fullSystems) throw new Error("Output has incompatible systems");
  if (!!saved.campaignEnabled !== campaignEnabled) throw new Error("Output has incompatible campaign setting");
  if (!!saved.observeWarOutcomes !== observeWarOutcomes) throw new Error("Output has incompatible observation setting");
  experiment = saved;
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
await mkdir(resolve(output, ".."), { recursive: true });
for (let index = 0; index < count; index += 1) {
  const seed = seedStart + index;
  for (const scenario of scenarios) {
    if (experiment.results.some((row) => row.seed === seed && row.scenario === scenario)) continue;
    try {
      const result = runBenchmark({
        observeWarOutcomes,
        config: { systems: {
          mobilizationEnabled: fullSystems, diplomacyEnabled: fullSystems, researchEnabled: fullSystems,
          armsAidEnabled: fullSystems, tradeEnabled: fullSystems, warCampaignEnabled: campaignEnabled,
        } },
        scenario, seed, ticks, width: 640, height: 360, quick: true,
        speed: 32, mode: "throughput", frameDeltaMs: 1000 / 60,
        reserveEnabled: true, reorganizationEnabled: true,
        exploitationEnabled: true, pocketReductionEnabled: true,
      });
      experiment.results.push(result);
      experiment.failures = experiment.failures.filter((row) => row.seed !== seed || row.scenario !== scenario);
      console.log(`${scenario} seed=${seed}: ${result.wallClockMs.toFixed(0)}ms, wars=${result.endWorld.wars}`);
    } catch (error) {
      experiment.failures.push({ scenario, seed, error: String(error) });
      console.error(`${scenario} seed=${seed}: ${String(error)}`);
    }
    const json = `${JSON.stringify(experiment, null, 2)}\n`;
    await writeFile(output, output.endsWith(".gz") ? gzipSync(json) : json);
  }
}
if (experiment.failures.length) process.exitCode = 1;
