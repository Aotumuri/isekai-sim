import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

// Validate common physical/outcome observations without treating timing as
// deterministic. Extra observer fields are deliberately outside this claim.
interface Row {
  scenario: string; seed: number; startFingerprint?: string;
  startWorld?: unknown; simulationSettings?: unknown; endWorld: unknown; warOutcomes: unknown;
}
interface Report {
  revision: string; sourceTree?: string; ticks: number; campaign?: boolean;
  campaignEnabled?: boolean; results?: Row[]; failures?: unknown[];
}
const args = process.argv.slice(2), subset = args.includes("--subset");
const paths = args.filter((arg) => arg !== "--subset");
if (paths.length !== 2) throw new Error("Supply reference and replay paths, optionally --subset for selected traces");
async function load(path: string): Promise<Report> {
  const bytes = await readFile(path);
  return JSON.parse((path.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString());
}
function nonCpu(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(nonCpu);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !key.toLowerCase().includes("cpu"))
    .map(([key, item]) => [key, nonCpu(item)]));
  return value;
}
const [reference, replay] = await Promise.all(paths.map(load));
assert.equal(reference.ticks, replay.ticks, "Different horizons");
assert.equal(!!(reference.campaignEnabled ?? reference.campaign),
  !!(replay.campaignEnabled ?? replay.campaign), "Different campaign settings");
if (reference.sourceTree && replay.sourceTree) assert.equal(reference.sourceTree, replay.sourceTree, "Different source trees");
assert.equal(reference.failures?.length ?? 0, 0, "Reference failures");
assert.equal(replay.failures?.length ?? 0, 0, "Replay failures");
const key = (row: Row) => `${row.scenario}:${row.seed}`;
const originals = reference.results ?? [reference as unknown as Row];
const rows = replay.results ?? [replay as unknown as Row];
const indexed = new Map(originals.map((row) => [key(row), row]));
assert.ok(rows.length, "Empty replay");
assert.equal(indexed.size, originals.length, "Duplicate reference cases");
assert.equal(new Set(rows.map(key)).size, rows.length, "Duplicate replay cases");
if (!subset) assert.equal(rows.length, originals.length, "Incomplete replay");
for (const row of rows) {
  const before = indexed.get(key(row));
  assert.ok(before, `Unknown replay case ${key(row)}`);
  for (const field of ["startFingerprint", "startWorld", "simulationSettings", "endWorld", "warOutcomes"] as const) {
    if (field.startsWith("start") || field === "simulationSettings") {
      if (before[field] === undefined || row[field] === undefined) continue;
    }
    assert.notEqual(before[field], undefined, `Missing reference ${field}`);
    assert.notEqual(row[field], undefined, `Missing replay ${field}`);
    assert.deepEqual(field === "warOutcomes" ? row[field] : nonCpu(row[field]),
      field === "warOutcomes" ? before[field] : nonCpu(before[field]), `${key(row)} ${field}`);
  }
}
console.log(JSON.stringify({ reference: paths[0], replay: paths[1], cases: rows.length, subset,
  endWorldNonCpuExact: true, fullWarOutcomesExact: true,
  note: "Only common recorded fields are validated; this does not prove full hidden-state parity or strategic superiority." }));
