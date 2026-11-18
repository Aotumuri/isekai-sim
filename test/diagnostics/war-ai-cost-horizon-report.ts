import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import { classifyCampaignCostWindow, type CampaignCostWindowPoint, type CampaignCostWindowResult } from "../helpers/campaign-cost-window";

interface Observation extends CampaignCostWindowPoint {
  nationId: string;
  tick: number;
}
interface ArchivedOrigin extends CampaignCostWindowResult {
  role: string;
  origin: Observation;
}
interface Episode {
  scenario: string;
  seed: number;
  observations: Observation[];
  comparisons: ArchivedOrigin[];
}
const source = process.argv[2] ?? "diagnostics/war-ai-cost-calibration-pilot.json.gz";
const output = process.argv[3] ?? "diagnostics/war-ai-r2-26-cost-horizons.json.gz";
const bytes = await readFile(source);
const pilot = JSON.parse(gunzipSync(bytes).toString("utf8")) as {
  revision: string; sourceTree: string; ticks: number; results: Episode[];
};
assert.equal(pilot.ticks, 10_000);
assert.equal(pilot.results.length, 12);
assert.equal(new Set(pilot.results.map((row) => `${row.scenario}:${row.seed}`)).size, 12);
const horizons = [50, 100, 150, 300];
const windowKey = (point: Observation, tick = point.tick) =>
  `${point.openingWarKey}:${point.nationId}:${tick}`;
const mean = (values: number[]) => values.length
  ? values.reduce((total, value) => total + value, 0) / values.length : null;

function measure(row: Episode, horizon: number) {
  const observations = new Map(row.observations.map((point) => [windowKey(point), point]));
  assert.equal(observations.size, row.observations.length);
  return row.comparisons.map((item) => {
    const { origin } = item;
    const samples = Array.from({ length: horizon / 10 }, (_, i) =>
      observations.get(windowKey(origin, origin.tick + (i + 1) * 10)) ?? null);
    const comparison = classifyCampaignCostWindow(origin, samples.at(-1) ?? null, samples);
    const predicted = origin.observation ? Math.min(1, origin.observation.lossRate * (horizon / 10)) : null;
    if (horizon === 300) {
      assert.equal(comparison.eligible, item.eligible);
      assert.deepEqual(comparison.censorReasons, item.censorReasons);
      assert.equal(comparison.actualCasualtyFractionIncrease, item.actualCasualtyFractionIncrease);
      assert.equal(predicted, item.predictedLossFractionFromObservedRate);
    }
    return {
      role: item.role, mode: origin.militaryMode ?? "missing",
      caseKey: `${row.scenario}:${row.seed}`, scenario: row.scenario,
      eligible: comparison.eligible, reasons: comparison.censorReasons,
      predicted, actual: comparison.actualCasualtyFractionIncrease,
    };
  });
}

function summarize(rows: ReturnType<typeof measure>) {
  const eligible = rows.filter((row) => row.eligible);
  const positive = eligible.filter((row) => row.actual! > 0);
  const cases = new Set(eligible.map((row) => row.caseKey));
  const counts: Record<string, number> = {};
  for (const row of rows) for (const reason of row.reasons) counts[reason] = (counts[reason] ?? 0) + 1;
  const perCase = [...cases].map((caseKey) => {
    const items = eligible.filter((row) => row.caseKey === caseKey);
    const predicted = mean(items.map((row) => row.predicted!))!;
    const actual = mean(items.map((row) => row.actual!))!;
    return { caseKey, eligible: items.length, predicted, actual, error: predicted - actual };
  });
  return {
    origins: rows.length, eligible: eligible.length, eligibleCases: cases.size, censored: rows.length - eligible.length,
    positiveLossCases: new Set(positive.map((row) => row.caseKey)).size,
    positiveLossFamilies: [...new Set(positive.map((row) => row.scenario))].sort(),
    caseMeanForecast: mean(perCase.map((row) => row.predicted)),
    caseMeanObserved: mean(perCase.map((row) => row.actual)),
    censorReasons: counts, perCase,
  };
}

const byHorizon = Object.fromEntries(horizons.map((horizon) => {
  const rows = pilot.results.flatMap((row) => measure(row, horizon));
  const groups = [...new Set(rows.map((row) => `${row.role}:${row.mode}`))];
  return [horizon, {
    roles: Object.fromEntries(groups.map((group) =>
      [group, summarize(rows.filter((row) => `${row.role}:${row.mode}` === group))])),
    offensive: summarize(rows.filter((row) => row.mode === "limited-offensive")),
  }];
}));
const sha256 = (content: Buffer) => createHash("sha256").update(content).digest("hex");
const report = { source, rawSha256: sha256(bytes), scriptSha256: sha256(await readFile(new URL(import.meta.url))),
  classifierSha256: sha256(await readFile(new URL("../helpers/campaign-cost-window.ts", import.meta.url))),
  revision: pilot.revision, sourceTree: pilot.sourceTree, cases: pilot.results.length,
  original300TickClassificationExact: true, byHorizon };
await writeFile(output, gzipSync(JSON.stringify(report)));
console.log(JSON.stringify({ output, cases: report.cases, horizons }));
