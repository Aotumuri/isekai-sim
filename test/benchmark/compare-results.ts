import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { BenchmarkResult } from "./types";

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  throw new Error("Usage: npm run benchmark:compare -- before.json after.json");
}

const before = await readResult(beforePath);
const after = await readResult(afterPath);
if (before.scenario !== after.scenario || before.mode !== after.mode) {
  throw new Error(
    `Cannot compare ${before.scenario}/${before.mode} with ${after.scenario}/${after.mode}`,
  );
}

console.log(`Scenario: ${before.scenario} (${before.mode})`);
console.log(`Seed: ${before.seed} -> ${after.seed}`);
console.log("\nPerformance");
console.log("-----------");
for (const name of [...new Set([...Object.keys(before.metrics), ...Object.keys(after.metrics)])].sort()) {
  const oldValue = before.metrics[name]?.totalMs ?? 0;
  const newValue = after.metrics[name]?.totalMs ?? 0;
  console.log(formatComparison(name, oldValue, newValue, "ms"));
}

console.log("\nCounters");
console.log("--------");
for (const name of [...new Set([...Object.keys(before.counters), ...Object.keys(after.counters)])].sort()) {
  console.log(
    formatComparison(name, before.counters[name] ?? 0, after.counters[name] ?? 0, ""),
  );
}

async function readResult(path: string): Promise<BenchmarkResult> {
  const parsed = JSON.parse(await readFile(resolve(path), "utf8")) as BenchmarkResult;
  if (parsed.schemaVersion !== 1) {
    throw new Error(`Unsupported benchmark schema in ${path}`);
  }
  return parsed;
}

function formatComparison(
  name: string,
  beforeValue: number,
  afterValue: number,
  unit: string,
): string {
  const delta = beforeValue === 0 ? null : ((afterValue - beforeValue) / beforeValue) * 100;
  const suffix = delta === null ? "n/a" : `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`;
  const render = (value: number) => `${value.toFixed(unit ? 3 : 0)}${unit}`;
  return `${name.padEnd(38)} ${render(beforeValue).padStart(13)} -> ${render(afterValue).padStart(13)}  ${suffix}`;
}
