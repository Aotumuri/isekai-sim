import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import type { BenchmarkResult } from "../benchmark/types";

interface Matrix {
  revision: string; ticks: number; seedStart: number; seedCount: number; scenarios: string[];
  partition: string; campaignEnabled?: boolean; fullSystems?: boolean; normalWars?: boolean;
  politicalTurbulence?: boolean; observeWarOutcomes?: boolean;
  results: BenchmarkResult[]; failures: unknown[];
}
const [controlPath, campaignPath, referencePath] = process.argv.slice(2);
if (!controlPath || !campaignPath) throw new Error("Supply control, campaign, and optional earlier control paths");
async function read(path: string): Promise<Matrix> {
  const bytes = await readFile(path);
  return JSON.parse((path.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString());
}
function gameplay(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(gameplay);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !key.endsWith("CpuMs")).map(([key, item]) => [key, gameplay(item)]));
  return value;
}
const control = await read(controlPath), campaign = await read(campaignPath);
assert.equal(!!control.campaignEnabled, false);
assert.equal(campaign.campaignEnabled, true);
for (const key of ["ticks", "seedStart", "seedCount", "partition", "fullSystems", "normalWars", "politicalTurbulence", "observeWarOutcomes"] as const) {
  assert.equal(control[key], campaign[key], key);
}
assert.deepEqual(control.scenarios, campaign.scenarios);
function index(matrix: Matrix) {
  assert.deepEqual(matrix.failures, []);
  assert.equal(matrix.results.length, matrix.seedCount * matrix.scenarios.length);
  const indexed = new Map(matrix.results.map((row) => [`${row.scenario}:${row.seed}`, row]));
  assert.equal(indexed.size, matrix.results.length);
  for (const scenario of matrix.scenarios) for (let i = 0; i < matrix.seedCount; i++) {
    assert(indexed.has(`${scenario}:${matrix.seedStart + i}`));
  }
  return indexed;
}
const before = index(control), after = index(campaign);
for (const [key, row] of before) {
  const other = after.get(key)!;
  const { warCampaignEnabled: oldFlag, ...oldSettings } = row.simulationSettings!;
  const { warCampaignEnabled: newFlag, ...newSettings } = other.simulationSettings!;
  assert.equal(oldFlag, false);
  assert.equal(newFlag, true);
  assert.deepEqual(oldSettings, newSettings, `${key} actual settings`);
  assert.equal(oldSettings.politicalTurbulenceEnabled, !!control.politicalTurbulence);
  for (const setting of ["diplomacyEnabled", "mobilizationEnabled", "researchEnabled", "armsAidEnabled", "tradeEnabled"] as const) {
    assert.equal(oldSettings[setting], !!control.fullSystems);
  }
  assert.deepEqual(gameplay(row.startWorld), gameplay(other.startWorld), `${key} starting summary`);
}
let unchangedControlRows = 0;
if (referencePath) {
  const reference = index(await read(referencePath));
  for (const [key, row] of before) {
    const prior = reference.get(key);
    assert(prior, key);
    assert.deepEqual(gameplay(row.endWorld), gameplay(prior.endWorld), `${key} disabled gameplay`);
    assert.deepEqual(row.warOutcomes, prior.warOutcomes, `${key} disabled outcomes`);
    unchangedControlRows++;
  }
}
console.log(JSON.stringify({ control: controlPath, campaign: campaignPath, reference: referencePath,
  revisions: [control.revision, campaign.revision], pairedRows: before.size,
  failures: 0, pairedActualSettings: true, pairedStartingSummaries: true,
  unchangedControlRows, note: "Starting summaries are aggregate counts and stocks; CPU timings are excluded from gameplay equality." }, null, 2));
