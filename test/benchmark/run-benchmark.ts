import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runBenchmark } from "./benchmark-runner";
import { formatBenchmarkReport } from "./report";
import {
  BENCHMARK_SCENARIOS,
  type BenchmarkMode,
  type BenchmarkOptions,
  type BenchmarkScenarioName,
} from "./types";
import { STANDARD_BENCHMARK_SEED } from "../helpers/seeded-world";

interface ParsedArguments {
  options: BenchmarkOptions;
  outputPath: string | null;
}

const parsed = parseArguments(process.argv.slice(2));
const result = runBenchmark(parsed.options);
console.log(formatBenchmarkReport(result));

if (parsed.outputPath) {
  const outputPath = resolve(parsed.outputPath);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(`\nJSON: ${outputPath}`);
}

function parseArguments(args: string[]): ParsedArguments {
  const quick = args.includes("--quick");
  const scenario = readOption(args, "--scenario") ?? "active-war";
  if (!BENCHMARK_SCENARIOS.includes(scenario as BenchmarkScenarioName)) {
    throw new Error(`Unknown scenario: ${scenario}`);
  }
  const mode = (readOption(args, "--mode") ?? "throughput") as BenchmarkMode;
  if (mode !== "throughput" && mode !== "frame-loop") {
    throw new Error(`Unknown benchmark mode: ${mode}`);
  }
  const reserveMode = readOption(args, "--reserve") ?? "on";
  if (reserveMode !== "on" && reserveMode !== "off") {
    throw new Error(`Unknown reserve mode: ${reserveMode}`);
  }
  const reorganizationMode = readOption(args, "--reorganization") ?? "on";
  if (reorganizationMode !== "on" && reorganizationMode !== "off") {
    throw new Error(`Unknown reorganization mode: ${reorganizationMode}`);
  }
  const exploitationMode = readOption(args, "--exploitation") ?? "on";
  if (exploitationMode !== "on" && exploitationMode !== "off") {
    throw new Error(`Unknown exploitation mode: ${exploitationMode}`);
  }
  return {
    options: {
      scenario: scenario as BenchmarkScenarioName,
      seed: readNumber(args, "--seed", STANDARD_BENCHMARK_SEED),
      ticks: readNumber(args, "--ticks", quick ? 200 : 3_200),
      width: readNumber(args, "--width", quick ? 640 : 1_920),
      height: readNumber(args, "--height", quick ? 360 : 1_080),
      speed: readNumber(args, "--speed", 32),
      mode,
      frameDeltaMs: readNumber(args, "--frame-ms", 1_000 / 60),
      quick,
      reserveEnabled: reserveMode === "on",
      reorganizationEnabled: reorganizationMode === "on",
      exploitationEnabled: exploitationMode === "on",
    },
    outputPath: readOption(args, "--output"),
  };
}

function readOption(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) {
    return null;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function readNumber(args: string[], name: string, fallback: number): number {
  const raw = readOption(args, name);
  if (raw === null) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} requires a finite number; received ${raw}`);
  }
  return value;
}
