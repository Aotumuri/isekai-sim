import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import type { BenchmarkResult } from "../benchmark/types";
import { pairedBootstrap } from "../helpers/paired-bootstrap";

interface Matrix {
  revision: string;
  runtime?: Record<string, string>;
  ticks: number;
  partition: string;
  seedCount: number;
  fullSystems?: boolean;
  politicalTurbulence?: boolean;
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
  if (!!a.politicalTurbulence !== !!b.politicalTurbulence) throw new Error("Cannot compare different political settings");
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
  ["frontTransfers", (row) => row.counters["landFront.allocationFrontTransfers"] ?? 0],
  ["amphibiousLandings", (row) => row.endWorld.amphibiousCompletedLandings],
  ["amphibiousTransportLosses", (row) => row.endWorld.amphibiousTransportLosses],
  ["recoveryManpowerConsumed", (row) => row.endWorld.reorganizationManpowerConsumed],
  ["recoveryEquipmentConsumed", (row) => row.endWorld.reorganizationEquipmentConsumed],
  ["productionSuccessful", (row) => row.endWorld.productionSuccessful],
  ["finalUnits", (row) => row.endWorld.units],
  ["strategyEvaluationMs", (row) => row.metrics["warCampaign.evaluation"]?.totalMs ?? 0],
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
    ["frontTransfersPer1000WarSideTicks", (row) => (row.counters["landFront.allocationFrontTransfers"] ?? 0) * 1000 /
      Math.max(1, row.warOutcomes!.wars.reduce((sum, war) => sum + Math.max(0, (war.endedAtTick ?? row.requestedTicks) - war.observedAtTick), 0))],
    ["campaignChanges", (row) => row.warOutcomes!.campaignChanges],
  );
  metrics.push(
    ["openingAggressorFirstGoalRate", (row) => average(openingWars(row).filter((war) => war.aggressor).map((war) => Number(war.firstAchievedTick !== null)))],
    ["openingAggressorGoalTicksCapped", (row) => average(openingWars(row).filter((war) => war.aggressor).map((war) => (war.firstAchievedTick ?? row.requestedTicks) - war.startedAtTick))],
    ["openingWarDurationTicksCapped", (row) => average(openingWars(row).map((war) => (war.endedAtTick ?? row.requestedTicks) - war.startedAtTick))],
    ["operationsCancelledSettlement", (row) => row.warOutcomes!.operationEndReasons["cancelled:campaign-settlement"] ?? 0],
  );
  if (matrices.every((matrix) => matrix.results.every((row) => row.warOutcomes!.schemaVersion >= 2))) {
    for (const aggressor of [true, false]) {
      const role = aggressor ? "Aggressor" : "Defender";
      const sides = (row: BenchmarkResult) => openingWars(row).filter((war) => war.aggressor === aggressor);
      metrics.push(
        [`opening${role}NetValueRate`, (row) => average(sides(row).map((war) =>
          (war.opponentTerritorySecuredValue - war.homelandLostValue) / Math.max(1, war.openingTerritorialValue)))],
        [`opening${role}Casualties`, (row) => average(sides(row).map((war) => war.casualties))],
        [`opening${role}SurvivalRate`, (row) => average(sides(row).map((war) => Number(war.survived)))],
      );
    }
    metrics.push(
      ["openingNetStrategicValueRate", (row) => average(openingWars(row).map((war) =>
        (war.opponentTerritorySecuredValue - war.homelandLostValue) / Math.max(1, war.openingTerritorialValue)))],
      ["openingTerritorialGains", (row) => average(openingWars(row).map((war) => war.opponentTerritorySecuredValue))],
      ["openingTerritorialLosses", (row) => average(openingWars(row).map((war) => war.homelandLostValue))],
      ["operationsCancelledPosture", (row) => row.warOutcomes!.operationEndReasons["cancelled:posture-changed"] ?? 0],
      ["operationsCancelledAllocation", (row) => row.warOutcomes!.operationEndReasons["cancelled:allocation-lost"] ?? 0],
    );
  }
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
  runtime: matrix.runtime ?? { node: "not recorded" },
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
const pairedIntervals = pairedDeltas && Object.fromEntries(
  [...new Set(pairedDeltas.map((row) => row.scenario))].map((scenario) => [scenario,
    Object.fromEntries(metrics.map(([name]) => [name, pairedBootstrap(
      pairedDeltas.filter((row) => row.scenario === scenario).map((row) => row.deltas[name]),
    )])),
  ]),
);
console.log(JSON.stringify({ summary, pairedDeltas, pairedIntervals }, null, 2));
