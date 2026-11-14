import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

const rawPath = resolve(process.argv[2] ?? "diagnostics/war-ai-cost-calibration-pilot.json.gz");
const matrixPath = resolve(process.argv[3] ?? "diagnostics/war-ai-r2-16-control-development.json.gz");
const output = resolve(process.argv[4] ?? "diagnostics/war-ai-cost-calibration-summary.json.gz");
const load = async (path: string) => JSON.parse(gunzipSync(await readFile(path)).toString("utf8"));
const [raw, matrix] = await Promise.all([load(rawPath), load(matrixPath)]);
const key = (row: { scenario: string; seed: number }) => `${row.scenario}:${row.seed}`;
const ref = new Map<string, any>(matrix.results.map((row: any) => [key(row), row]));
if (raw.ticks !== matrix.ticks || !raw.campaignEnabled || !matrix.campaignEnabled || raw.results.length !== 12) {
  throw new Error("Calibration pilot metadata/case count mismatch");
}
const nonCpu = (value: any): any => Array.isArray(value) ? value.map(nonCpu) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).filter(([name]) => !name.toLowerCase().includes("cpu"))
    .map(([name, item]) => [name, nonCpu(item)])) : value;
const rows = new Map<string, any>(raw.results.map((row: any) => [key(row), row]));
if (rows.size !== 12 || [...rows.keys()].some((caseKey) => !ref.has(caseKey))) throw new Error("Matrix subset keys differ");
for (const [caseKey, row] of rows) {
  const baseline = ref.get(caseKey)!;
  if (JSON.stringify(nonCpu(row.endWorld)) !== JSON.stringify(nonCpu(baseline.endWorld)) ||
    JSON.stringify(row.warOutcomes) !== JSON.stringify(baseline.warOutcomes)) throw new Error(`Replay parity failed: ${caseKey}`);
}
const pair = () => ({ cases: new Set<string>(), predicted: [] as number[], actual: [] as number[], error: [] as number[] });
const signBucket = () => ({ cases: new Set<string>(), allPredicted: [] as number[], paired: pair() });
const groups = new Map<string, any>();
for (const row of raw.results as any[]) for (const item of row.comparisons) {
  const role = item.role, mode = item.origin.militaryMode ?? "missing", groupKey = `${role}|${mode}`;
  const group = groups.get(groupKey) ?? { role, militaryMode: mode, caseKeys: new Set(), eligible: 0, censored: 0,
    censorReasons: {}, allPredicted: [], eligiblePair: pair(), byPredictionSign: {
      zero: signBucket(), positive: signBucket(), missing: signBucket() },
    caseValues: new Map() };
  const caseKey = key(row); group.caseKeys.add(caseKey);
  const caseValue = group.caseValues.get(caseKey) ?? { paired: pair(), bySign: {
    zero: pair(), positive: pair(), missing: pair() } };
  if (item.eligible) group.eligible += 1; else group.censored += 1;
  for (const reason of item.censorReasons) group.censorReasons[reason] = (group.censorReasons[reason] ?? 0) + 1;
  const predicted = item.predictedLossFractionFromObservedRate;
  const actual = item.actualCasualtyFractionIncrease;
  if (item.eligible !== (actual !== null) || (item.eligible && predicted === null)) {
    throw new Error(`Eligible prediction/actual mismatch: ${caseKey}`);
  }
  const category = predicted === null ? "missing" : predicted <= 0 ? "zero" : "positive";
  const signGroup = group.byPredictionSign[category]; signGroup.cases.add(caseKey);
  if (predicted !== null) { group.allPredicted.push(predicted); signGroup.allPredicted.push(predicted); }
  if (item.eligible) {
    const error = predicted! - actual;
    for (const target of [group.eligiblePair, signGroup.paired, caseValue.paired, caseValue.bySign[category]]) {
      target.cases.add(caseKey); target.predicted.push(predicted!); target.actual.push(actual); target.error.push(error);
    }
  }
  group.caseValues.set(caseKey, caseValue);
  groups.set(groupKey, group);
}
const distribution = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
    median: sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2 : null,
    min: sorted[0] ?? null, max: sorted.at(-1) ?? null };
};
const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const pairedSummary = (observations: any[], cases: any[]) => {
  const predicted = observations.flatMap((item) => item.predicted), actual = observations.flatMap((item) => item.actual);
  const error = observations.flatMap((item) => item.error);
  if (predicted.length !== actual.length || actual.length !== error.length) throw new Error("Paired observation counts differ");
  const casePredicted = cases.map((item) => average(item.predicted)).filter((n: number | null): n is number => n !== null);
  const caseActual = cases.map((item) => average(item.actual)).filter((n: number | null): n is number => n !== null);
  const caseError = cases.map((item) => average(item.error)).filter((n: number | null): n is number => n !== null);
  if (casePredicted.length !== caseActual.length || caseActual.length !== caseError.length) throw new Error("Paired case counts differ");
  return { eligibleObservations: predicted.length, eligibleCaseCount: casePredicted.length,
    predicted: distribution(predicted), actual: distribution(actual), error: distribution(error),
    caseMeanPredicted: distribution(casePredicted), caseMeanActual: distribution(caseActual),
    caseMeanError: distribution(caseError) };
};
const groupReports = [...groups.values()].map((group) => {
  const cases = [...group.caseValues.values()];
  const eligibleCases = cases.map((value: any) => value.paired).filter((value: any) => value.cases.size > 0);
  const byPredictionSign = Object.fromEntries(Object.entries(group.byPredictionSign).map(([name, values]: [string, any]) => {
    const signCases = cases.map((value: any) => value.bySign[name]).filter((value: any) => value.cases.size > 0);
    return [name, { predictionCaseCount: values.cases.size, allPredicted: distribution(values.allPredicted),
      ...pairedSummary([values.paired], signCases) }];
  }));
  const paired = pairedSummary([group.eligiblePair], eligibleCases);
  return { role: group.role, militaryMode: group.militaryMode, caseCount: group.caseKeys.size,
    observations: group.eligible + group.censored, eligible: group.eligible, censored: group.censored,
    censorReasons: group.censorReasons, allPredicted: distribution(group.allPredicted),
    actualEligible: distribution(group.eligiblePair.actual), eligiblePaired: paired, byPredictionSign };
});
for (const group of groupReports) for (const sign of Object.values(group.byPredictionSign) as any[]) {
  if (sign.eligibleObservations !== sign.predicted.n || sign.predicted.n !== sign.actual.n || sign.actual.n !== sign.error.n) {
    throw new Error("Prediction-sign paired counts differ");
  }
}
const analysisScriptHash = createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex");
const validation = { reference: matrixPath, raw: rawPath, caseCount: rows.size,
  nonCpuEndWorldExact: true, fullWarOutcomesExact: true, matrixRevision: matrix.revision,
  sourceMetadata: { revision: raw.revision, sourceTree: raw.sourceTree, harnessHash: raw.harnessHash,
    classifierHash: raw.classifierHash, observerHash: raw.observerHash, runtime: raw.runtime },
  analysisScriptHash,
  sha256: { raw: createHash("sha256").update(await readFile(rawPath)).digest("hex"),
    reference: createHash("sha256").update(await readFile(matrixPath)).digest("hex") } };
const report = { validation, coverage: groupReports,
  note: "Descriptive calibration only. Overlapping 300-tick windows are correlated; no CI or p-value treats windows as independent. Actual distributions include eligible comparisons only; forecast distributions retain censored origins when recorded." };
await writeFile(output, gzipSync(JSON.stringify(report, null, 2)));
console.log(JSON.stringify({ output, cases: rows.size, groups: groupReports.length, exactParity: true }));
