import { mkdir, writeFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createDefaultWorldConfig } from "../../src/data/world-config";
import { runBenchmark } from "../benchmark/benchmark-runner";
import type { BenchmarkResult } from "../benchmark/types";

const args = process.argv.slice(2);
function option(name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1] ?? "";
}
const ticks = Number(option("--ticks", "2000"));
const seeds = Number(option("--seeds", "2"));
if (![ticks, seeds].every((value) => Number.isSafeInteger(value) && value > 0)) throw new Error("Positive ticks/seeds required");
const defaultMap = args.includes("--default-map");
const output = resolve(option("--output", "diagnostics/war-ai-scale.json"));
const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (execFileSync("git", ["diff", "--", "src"], { encoding: "utf8" })) throw new Error("Commit simulation source first");
const results: { campaign: boolean; creationAndRunMs: number; result: BenchmarkResult }[] = [];
await mkdir(dirname(output), { recursive: true });
for (let index = 0; index < seeds; index += 1) {
  for (const campaign of index % 2 ? [true, false] : [false, true]) {
    global.gc?.();
    const config = defaultMap ? createDefaultWorldConfig() : undefined;
    const started = performance.now();
    const result = runBenchmark({
      scenario: "active-war", seed: 822_748_319_780 + index, ticks,
      width: config?.width ?? 1920, height: config?.height ?? 1080,
      quick: false, mode: "throughput", speed: 32, frameDeltaMs: 1000 / 60,
      reserveEnabled: true, reorganizationEnabled: true, exploitationEnabled: true,
      pocketReductionEnabled: true, normalWars: true,
      config: { ...config, systems: { ...config?.systems, mobilizationEnabled: true, diplomacyEnabled: true,
        researchEnabled: true, armsAidEnabled: true, tradeEnabled: true, warCampaignEnabled: campaign } },
    });
    results.push({ campaign, creationAndRunMs: performance.now() - started, result });
    await writeFile(`${output}.tmp`, `${JSON.stringify({ revision, defaultMap, ticks, seeds, results }, null, 2)}\n`);
    await rename(`${output}.tmp`, output);
    console.log(`seed=${result.seed} campaign=${campaign} micro=${result.endWorld.microRegions} meso=${result.endWorld.mesoRegions} runMs=${result.wallClockMs.toFixed(0)}`);
  }
}
