import { readFile, writeFile } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import { pairedBootstrap } from "../helpers/paired-bootstrap";

const paths = process.argv.slice(2);
if (paths.length !== 3 && paths.length !== 5) throw new Error("Supply baseline/candidate/output or Legacy/R1/R2.13/prototype/output");
const pairOnly = paths.length === 3;
const audits = await Promise.all(paths.slice(0, -1).map(async (path) => JSON.parse(gunzipSync(await readFile(path)).toString())));
const labels = pairOnly ? ["baseline", "candidate"] : ["Legacy-equivalent (R1 disabled)", "R1", "R2.13", "prototype"];
const key = (row: any) => `${row.scenario}:${row.seed}`;
const rowKeys = (rows: any[]) => rows.map(key).sort().join("|");
for (const audit of audits.slice(1)) {
  for (const field of ["ticks", "seeds", "seedStart", "scenarios", "runtime", "harnessHash", "observerHash", "measurementPhase"]) {
    if (JSON.stringify(audit[field]) !== JSON.stringify(audits[0][field])) throw new Error(`Incompatible ${field}`);
  }
  if (rowKeys(audit.results) !== rowKeys(audits[0].results)) throw new Error("Incomplete paired cases");
  for (const row of audit.results) {
    const before = audits[0].results.find((candidate: any) => key(candidate) === key(row));
    if (row.startFingerprint !== before.startFingerprint) throw new Error(`Changed opening ${key(row)}`);
  }
}
if ((!pairOnly && audits[0].campaign) || audits.slice(1).some((audit) => !audit.campaign)) throw new Error("Incorrect control flags");
if (audits.some((audit) => audit.measurementPhase !== "after-reposition-before-battle-and-slow-ai")) throw new Error("Measure at the movement boundary");
if (audits.some((audit) => audit.results.length !== audit.seeds * audit.scenarios.length)) throw new Error("Finish all audit rows");

function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: values.length, mean: values.reduce((a, b) => a + b, 0) / values.length,
    median: (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2,
    min: sorted[0], max: sorted.at(-1) };
}
const fields = Object.keys(audits[0].results[0].travel);
const rateFields = [
  { name: "ordinaryDiscardedMsPerTravelMs", numerator: "ordinaryDiscardedProgressMs", denominator: "ordinaryTravelMs" },
  { name: "ordinaryResetEventsPerRetarget", numerator: "ordinaryResetEvents", denominator: "ordinarySameEdgeRetargets" },
  { name: "allUnblockedResetEventsPerRetarget", numerator: "allUnblockedResetEvents", denominator: "allUnblockedSameEdgeRetargets" },
];
if (fields.includes("sameFrontTravelMs")) rateFields.push(
  { name: "sameFrontDiscardedMsPerTravelMs", numerator: "sameFrontDiscardedProgressMs", denominator: "sameFrontTravelMs" },
  { name: "sameFrontResetEventsPerRetarget", numerator: "sameFrontResetEvents", denominator: "sameFrontSameEdgeRetargets" },
);
const scenarios = audits[0].scenarios.map((scenario: string) => {
  const arms = audits.map((audit, i) => {
    const rows = audit.results.filter((row: any) => row.scenario === scenario);
    const sum = (field: string) => rows.reduce((total: number, row: any) => total + row.travel[field], 0);
    return { label: labels[i], revision: audit.revision, sourceTree: audit.sourceTree,
      metrics: Object.fromEntries(fields.map((field) => [field, distribution(rows.map((row: any) => row.travel[field]))])),
      exposureRates: Object.fromEntries(rateFields.map(({ name, numerator, denominator }) => [name, {
        pooled: sum(denominator) ? sum(numerator) / sum(denominator) : null,
        totalNumerator: sum(numerator), totalDenominator: sum(denominator),
        zeroExposureSeeds: rows.filter((row: any) => row.travel[denominator] === 0).length,
      }])) };
  });
  const comparisons = audits.slice(0, -1).map((control, i) => {
    const rows = control.results.filter((row: any) => row.scenario === scenario);
    const pairs = rows.map((before: any) => ({ before, after: audits.at(-1).results.find((row: any) => key(row) === key(before)) }));
    return { versus: labels[i],
      metrics: Object.fromEntries(fields.map((field) => [field, pairedBootstrap(pairs.map(({ before, after }: any) =>
        after.travel[field] - before.travel[field]))])),
      exposureRates: Object.fromEntries(rateFields.map(({ name, numerator, denominator }) => {
        const exposed = pairs.filter(({ before, after }: any) => before.travel[denominator] > 0 && after.travel[denominator] > 0);
        return [name, { exposedPairedSeeds: exposed.length, totalPairedSeeds: pairs.length,
          interval: exposed.length ? pairedBootstrap(exposed.map(({ before, after }: any) =>
            after.travel[numerator] / after.travel[denominator] - before.travel[numerator] / before.travel[denominator])) : null }];
      })) };
  });
  return { scenario, arms, comparisons };
});
await writeFile(paths.at(-1)!, gzipSync(JSON.stringify({ paths: paths.slice(0, -1), scenarios,
  note: "Paired seed intervals with fixed 10000 resamples. Original mission-conditioned, supplemental same-front physical, and all-unblocked views are distinct. Pooled exposure rates are descriptive; per-seed rate intervals include only pairs with nonzero exposure on both sides and disclose coverage. This travel report alone is not adoption evidence. National outcomes and independent cost reports remain required." })));
console.log(JSON.stringify(scenarios.map((scenario: any) => ({ scenario: scenario.scenario,
  discardedOrdinaryMs: scenario.arms.map((arm: any) => ({ label: arm.label, mean: arm.metrics.ordinaryDiscardedProgressMs.mean })) }))));
