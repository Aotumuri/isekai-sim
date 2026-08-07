import type { BenchmarkResult, MetricSummary, WorldSummary } from "./types";

export function formatBenchmarkReport(result: BenchmarkResult): string {
  const lines = [
    `Scenario: ${result.scenario}`,
    `Seed: ${result.seed}`,
    `Mode: ${result.mode}`,
    `Ticks: ${result.processedFastTicks} fast / ${result.processedSlowTicks} slow`,
    "",
    "World (start -> end)",
    "--------------------",
    ...formatWorld(result.startWorld, result.endWorld),
    "",
    "Performance",
    "-----------",
    `wall clock              ${formatMs(result.wallClockMs)}`,
    `throughput              ${result.throughputTicksPerSecond.toFixed(1)} ticks/s`,
    `effective sim speed     x${result.effectiveSimulationSpeed.toFixed(2)}`,
  ];

  for (const name of preferredMetricOrder(result.metrics)) {
    const metric = result.metrics[name];
    lines.push(formatMetric(name, metric));
  }

  lines.push("", "Counters", "--------");
  for (const [name, value] of Object.entries(result.counters)) {
    lines.push(`${name.padEnd(29)} ${formatNumber(value)}`);
  }
  const requests = result.counters["pathfinding.shared.requests"] ?? 0;
  const hits = result.counters["pathfinding.shared.hits"] ?? 0;
  if (requests > 0) {
    lines.push(`${"pathfinding.shared.hitRate".padEnd(29)} ${((hits / requests) * 100).toFixed(1)}%`);
  }
  return lines.join("\n");
}

function formatWorld(start: WorldSummary, end: WorldSummary): string[] {
  const fields: Array<[string, keyof WorldSummary]> = [
    ["nations", "nations"],
    ["active nations", "activeNations"],
    ["extinct nations", "extinctNations"],
    ["units", "units"],
    ["wars", "wars"],
    ["battles", "battles"],
    ["occupations", "occupations"],
    ["physical land fronts", "landFronts"],
    ["nation front plans", "nationFrontPlans"],
    ["front allocated units", "frontAllocatedUnits"],
    ["front unassigned units", "frontUnassignedUnits"],
    ["micro regions", "microRegions"],
    ["meso regions", "mesoRegions"],
    ["macro regions", "macroRegions"],
  ];
  return fields.map(([label, key]) =>
    `${label.padEnd(22)} ${formatNumber(start[key])} -> ${formatNumber(end[key])}`,
  );
}

function preferredMetricOrder(metrics: Record<string, MetricSummary>): string[] {
  const preferred = [
    "simulation.total",
    "simulation.frame",
    "repositionUnits",
    "assignment.rebuild",
    "assignment.defense",
    "assignment.attack",
    "movement.progression",
    "pathfinding.bfs",
    "landFront.rebuild",
    "landFront.metrics",
    "landFront.planEvaluation",
    "landFront.allocation",
    "updateOccupation",
    "updateCapitals",
    "surrender",
  ];
  const remaining = Object.keys(metrics).filter((name) => !preferred.includes(name));
  return [...preferred.filter((name) => metrics[name]), ...remaining.sort()];
}

function formatMetric(name: string, metric: MetricSummary): string {
  return `${name.padEnd(22)} total ${formatMs(metric.totalMs).padStart(10)}  avg ${formatMs(metric.averageMs).padStart(9)}  p95 ${formatMs(metric.p95Ms).padStart(9)}  max ${formatMs(metric.maxMs).padStart(9)}  n=${metric.count}`;
}

function formatMs(value: number): string {
  return `${value.toFixed(value >= 100 ? 1 : 3)} ms`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString("en-US") : value.toFixed(3);
}
