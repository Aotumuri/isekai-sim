import type {
  SimulationCounterName,
  SimulationInstrumentation,
  SimulationMetricName,
} from "../../src/sim/instrumentation";
import type { MetricSummary } from "./types";

const DEFAULT_MAX_SAMPLES = 2_048;

interface MetricAccumulator {
  count: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  samples: number[];
  nextSampleIndex: number;
}

export class BenchmarkMetrics implements SimulationInstrumentation {
  private readonly metrics = new Map<string, MetricAccumulator>();
  private readonly counters = new Map<string, number>();

  constructor(private readonly maxSamples = DEFAULT_MAX_SAMPLES) {}

  recordDuration(name: SimulationMetricName | string, durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new Error(`Invalid duration for ${name}: ${durationMs}`);
    }
    let metric = this.metrics.get(name);
    if (!metric) {
      metric = {
        count: 0,
        totalMs: 0,
        minMs: Number.POSITIVE_INFINITY,
        maxMs: 0,
        samples: [],
        nextSampleIndex: 0,
      };
      this.metrics.set(name, metric);
    }
    metric.count += 1;
    metric.totalMs += durationMs;
    metric.minMs = Math.min(metric.minMs, durationMs);
    metric.maxMs = Math.max(metric.maxMs, durationMs);
    if (metric.samples.length < this.maxSamples) {
      metric.samples.push(durationMs);
    } else if (this.maxSamples > 0) {
      // A ring buffer bounds memory while keeping recent benchmark behavior.
      metric.samples[metric.nextSampleIndex] = durationMs;
      metric.nextSampleIndex = (metric.nextSampleIndex + 1) % this.maxSamples;
    }
  }

  incrementCounter(
    name: SimulationCounterName | string,
    amount = 1,
  ): void {
    if (!Number.isFinite(amount)) {
      throw new Error(`Invalid counter increment for ${name}: ${amount}`);
    }
    this.counters.set(name, (this.counters.get(name) ?? 0) + amount);
  }

  measure<T>(name: string, operation: () => T): T {
    const startedAt = performance.now();
    try {
      return operation();
    } finally {
      this.recordDuration(name, performance.now() - startedAt);
    }
  }

  getCounter(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  getCounters(): Record<string, number> {
    return Object.fromEntries(
      [...this.counters.entries()].sort(([a], [b]) => a.localeCompare(b)),
    );
  }

  getMetricSummaries(): Record<string, MetricSummary> {
    const summaries: Record<string, MetricSummary> = {};
    for (const [name, metric] of [...this.metrics.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const sortedSamples = [...metric.samples].sort((a, b) => a - b);
      summaries[name] = {
        count: metric.count,
        totalMs: metric.totalMs,
        averageMs: metric.count > 0 ? metric.totalMs / metric.count : 0,
        minMs: Number.isFinite(metric.minMs) ? metric.minMs : 0,
        maxMs: metric.maxMs,
        p50Ms: percentile(sortedSamples, 0.5),
        p95Ms: percentile(sortedSamples, 0.95),
        p99Ms: percentile(sortedSamples, 0.99),
        retainedSamples: metric.samples.length,
      };
    }
    return summaries;
  }
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  );
  return sorted[index];
}
