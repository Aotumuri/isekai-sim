import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import type { BenchmarkResult } from "../benchmark/types";

interface Matrix {
  revision: string;
  ticks: number;
  partition: string;
  seedCount: number;
  fullSystems?: boolean;
  observeWarOutcomes?: boolean;
  normalWars?: boolean;
  results: BenchmarkResult[];
  failures: unknown[];
}
const paths = process.argv.slice(2);
if (paths.length < 1 || paths.length > 2) throw new Error("Supply baseline and optional candidate matrix paths");
const matrices = await Promise.all(paths.map(async (path) => {
  const bytes = await readFile(path);
  return JSON.parse((path.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8")) as Matrix;
}));
if (matrices.length === 2) {
  const [a, b] = matrices;
  if (a.ticks !== b.ticks || a.partition !== b.partition ||
    a.seedCount !== b.seedCount || !!a.fullSystems !== !!b.fullSystems ||
    !!a.observeWarOutcomes !== !!b.observeWarOutcomes) {
    throw new Error("Cannot compare incompatible experiments");
  }
  if (!!a.normalWars !== !!b.normalWars) throw new Error("Cannot compare different war rules");
  const keys = (matrix: Matrix) => matrix.results.map((row) => `${row.scenario}:${row.seed}`).sort().join("|");
  if (keys(a) !== keys(b)) throw new Error("A/B requires identical completed scenario/seed pairs");
}
const metrics: [string, (row: BenchmarkResult) => number][] = [
  ["wallClockMs", (row) => row.wallClockMs],
  ["cpuMs", (row) => row.cpuUserMs + row.cpuSystemMs],
  ["heapMiB", (row) => row.heapUsedBytes / 2 ** 20],
  ["operationsCreated", (row) => row.endWorld.operationsCreated],
  ["operationsCompleted", (row) => row.endWorld.operationsCompleted],
  ["operationsCancelled", (row) => row.endWorld.operationsCancelled],
  ["operationsFailed", (row) => row.endWorld.operationsFailed],
  ["capitalFalls", (row) => row.endWorld.capitalFalls],
  ["warsRemaining", (row) => row.endWorld.wars],
  ["stalemateMaximumDuration", (row) => row.endWorld.stalemateMaximumDuration],
  ["frontlineAssignmentSwitches", (row) => row.endWorld.frontlineAssignmentSwitches],
];
if (matrices.every((matrix) => matrix.observeWarOutcomes)) {
  const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  // Registered scenario factories all start at fastTick=0. Separate fixed
  // opening wars from endogenous declarations, whose population can differ.
  const openingWars = (row: BenchmarkResult) => row.warOutcomes!.wars.filter((war) => war.observedAtTick === 0);
  metrics.push(
    ["openingWarSides", (row) => openingWars(row).length],
    ["openingAggressorObjectiveHeldRate", (row) => average(openingWars(row).filter((war) => war.aggressor).map((war) => Number(war.objectiveHeld)))],
    ["openingDefenderTerritoryHeldRate", (row) => average(openingWars(row).filter((war) => !war.aggressor).map((war) => Number(war.objectiveHeld)))],
    ["openingNationSurvivalRate", (row) => average(openingWars(row).map((war) => Number(war.survived)))],
    ["openingMeanCasualties", (row) => average(openingWars(row).map((war) => war.casualties))],
    ["aggressorObjectiveHeldRate", (row) => average(row.warOutcomes!.wars.filter((war) => war.aggressor).map((war) => Number(war.objectiveHeld)))],
    ["defenderTerritoryHeldRate", (row) => average(row.warOutcomes!.wars.filter((war) => !war.aggressor).map((war) => Number(war.objectiveHeld)))],
    ["nationSurvivalRate", (row) => average(row.warOutcomes!.wars.map((war) => Number(war.survived)))],
    ["meanCasualties", (row) => average(row.warOutcomes!.wars.map((war) => war.casualties))],
    ["meanEndedWarTicks", (row) => average(row.warOutcomes!.wars.filter((war) => war.endedAtTick !== null).map((war) => war.endedAtTick! - war.startedAtTick))],
    ["unfinishedWarSides", (row) => row.warOutcomes!.wars.filter((war) => war.endedAtTick === null).length],
    ["activeWarTicks", (row) => row.warOutcomes!.activeWarTicks],
    ["campaignChanges", (row) => row.warOutcomes!.campaignChanges],
  );
}
function distribution(values: number[]) {
  values.sort((a, b) => a - b);
  const n = values.length;
  if (!n) throw new Error("Empty distribution");
  return {
    n, mean: values.reduce((a, b) => a + b, 0) / n,
    median: (values[Math.floor((n - 1) / 2)] + values[Math.floor(n / 2)]) / 2,
    min: values[0], max: values[n - 1], p95: values[Math.ceil(n * 0.95) - 1],
  };
}
const summary = matrices.map((matrix) => ({
  revision: matrix.revision, ticks: matrix.ticks, fullSystems: !!matrix.fullSystems,
  failures: matrix.failures,
  scenarios: Object.fromEntries([...new Set(matrix.results.map((row) => row.scenario))].map((scenario) => {
    const rows = matrix.results.filter((row) => row.scenario === scenario);
    return [scenario, Object.fromEntries(metrics.map(([name, read]) => [name, distribution(rows.map(read))]))];
  })),
}));
const pairedDeltas = matrices.length === 2 ? matrices[0].results.map((before) => {
  const after = matrices[1].results.find((row) => row.seed === before.seed && row.scenario === before.scenario)!;
  return { scenario: before.scenario, seed: before.seed,
    deltas: Object.fromEntries(metrics.map(([name, read]) => [name, read(after) - read(before)])),
  };
}) : undefined;
console.log(JSON.stringify({ summary, pairedDeltas }, null, 2));
