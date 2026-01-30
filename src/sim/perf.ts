type PerfStats = {
  count: number;
  totalMs: number;
  maxMs: number;
};

type PerfEntry = {
  label: string;
  count: number;
  totalMs: number;
  avgMs: number;
  maxMs: number;
};

const stats = new Map<string, PerfStats>();
let enabled = false;

function nowMs(): number {
  const perf = globalThis.performance;
  if (perf && typeof perf.now === "function") {
    return perf.now();
  }
  return Date.now();
}

export function setPerfEnabled(value: boolean): void {
  enabled = value;
}

export function resetPerfStats(): void {
  stats.clear();
}

export function perfStart(_label: string): number {
  if (!enabled) {
    return 0;
  }
  return nowMs();
}

export function perfEnd(label: string, startMs: number): void {
  if (!enabled) {
    return;
  }
  const duration = nowMs() - startMs;
  let entry = stats.get(label);
  if (!entry) {
    entry = { count: 0, totalMs: 0, maxMs: 0 };
    stats.set(label, entry);
  }
  entry.count += 1;
  entry.totalMs += duration;
  if (duration > entry.maxMs) {
    entry.maxMs = duration;
  }
}

export function perfCount(label: string, delta = 1): void {
  if (!enabled) {
    return;
  }
  let entry = stats.get(label);
  if (!entry) {
    entry = { count: 0, totalMs: 0, maxMs: 0 };
    stats.set(label, entry);
  }
  entry.count += delta;
}

export function getPerfSnapshot(): PerfEntry[] {
  const entries: PerfEntry[] = [];
  for (const [label, entry] of stats.entries()) {
    const avgMs = entry.count > 0 ? entry.totalMs / entry.count : 0;
    entries.push({
      label,
      count: entry.count,
      totalMs: entry.totalMs,
      avgMs,
      maxMs: entry.maxMs,
    });
  }
  return entries;
}
