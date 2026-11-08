import { readFile, writeFile } from "node:fs/promises";

const INPUT_PATH = "diagnostics/war-window-report.json";
const OUTPUT_PATH = "diagnostics/war-window-model-report.json";
const FIRST_SEED = 822_748_319_788;
const TRAIN_SEED_COUNT = 20;
const DURATIONS = [300, 500, 750, 1_000];
const BUCKETS = Array.from({ length: 10 }, (_, index) => index);

interface Observation {
  seed: number;
  surrenderResistance?: number;
  minSideResistance: number;
  attackerCapitalThreat: Threat;
  defenderCapitalThreat: Threat;
  actualRemainingWarTicks: number | null;
  rightCensored: boolean;
  attributionValid: boolean;
  warInstanceId: string;
}
type Threat = "none" | "threatened" | "critical" | null;
type Prediction = (item: Observation) => number | null;

const report = JSON.parse(await readFile(INPUT_PATH, "utf8")) as { experiment?: { seeds?: { count?: number; first?: number } }; observations?: Observation[] };
if (!Array.isArray(report.observations)) throw new Error(`${INPUT_PATH} does not contain observations. Run npm run diagnose:war-window first.`);
const resolved = report.observations.filter((item) => item.attributionValid && !item.rightCensored && item.actualRemainingWarTicks !== null);
const splitSeed = FIRST_SEED + TRAIN_SEED_COUNT;
const train = resolved.filter((item) => item.seed < splitSeed);
const evaluation = resolved.filter((item) => item.seed >= splitSeed);
if (!train.length || !evaluation.length) throw new Error(`Expected resolved observations in both the first ${TRAIN_SEED_COUNT} training seeds and final evaluation seeds.`);

const fit = linearFit(train);
const bucketValues = BUCKETS.map((bucket) => train.filter((item) => bucketFor(item.minSideResistance) === bucket).map((item) => item.actualRemainingWarTicks!));
const candidates: { name: string; rules: string; predict: Prediction }[] = [
  { name: "A-current-linear-min-side", rules: "round(120 + 1080 * min(attackerResistance, defenderResistance))", predict: (item) => Math.round(120 + 1080 * item.minSideResistance) },
  { name: "B-fitted-linear-min-side", rules: `max(0, round(${fit.intercept} + ${fit.slope} * minSideResistance)); fitted only on first 20 seeds`, predict: (item) => Math.max(0, Math.round(fit.intercept + fit.slope * item.minSideResistance)) },
  { name: "C-piecewise-bucket-median", rules: "training-set median actual remaining lifetime for min-side resistance bucket", predict: (item) => percentile(bucketValues[bucketFor(item.minSideResistance)], .5) },
  { name: "C-piecewise-bucket-p25", rules: "training-set p25 actual remaining lifetime for min-side resistance bucket", predict: (item) => percentile(bucketValues[bucketFor(item.minSideResistance)], .25) },
  { name: "D-min-side-with-threatened-360-critical-180-cap", rules: "A, capped at 360 when either capital is threatened and at 180 when either is critical", predict: (item) => capitalCap(Math.round(120 + 1080 * item.minSideResistance), item, 360, 180) },
  { name: "D-min-side-with-threatened-500-critical-240-cap", rules: "A, capped at 500 when either capital is threatened and at 240 when either is critical", predict: (item) => capitalCap(Math.round(120 + 1080 * item.minSideResistance), item, 500, 240) },
];

const candidateReports = candidates.map((candidate) => ({ name: candidate.name, rules: candidate.rules, train: evaluate(candidate.predict, train), evaluation: evaluate(candidate.predict, evaluation) }));
const result = {
  experiment: { sourceReport: INPUT_PATH, sourceSeeds: report.experiment?.seeds ?? null, split: { training: { firstSeed: FIRST_SEED, seedCount: TRAIN_SEED_COUNT, seedRange: `${FIRST_SEED}-${splitSeed - 1}` }, evaluation: { firstSeed: splitSeed, seedCount: (report.experiment?.seeds?.count ?? 30) - TRAIN_SEED_COUNT, rule: "all later deterministic seeds" } }, resolvedOnlyLimitation: "Right-censored observations are excluded from exact lifetime/error and feasibility metrics; they are not treated as failures." },
  dataQuality: { sourceObservationCount: report.observations.length, resolvedObservationCount: resolved.length, trainResolvedObservationCount: train.length, evaluationResolvedObservationCount: evaluation.length, trainUniqueWarInstances: uniqueWars(train), evaluationUniqueWarInstances: uniqueWars(evaluation) },
  minSideResistanceCalibration: { train: calibration(train), evaluation: calibration(evaluation) },
  candidates: candidateReports,
  selectionGuidance: { primaryEvaluationCriteria: ["evaluation falseSafeRate at 500/750/1000 operation durations", "evaluation >250 and >500 tick overprediction rates", "evaluation coverage of genuinely safe operations", "simplicity when differences are small"], doNotUseTrainingForChoice: true, capitalAdjustmentInterpretation: "Compare D candidates to A on evaluation only; a cap is worthwhile only if it materially lowers false-safe rates without unacceptable coverage loss." },
};
await writeFile(OUTPUT_PATH, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(`War-window model diagnostic complete: ${OUTPUT_PATH}`);

function evaluate(predict: Prediction, items: Observation[]): object {
  const observationWeighted = metrics(predict, items);
  const representative = [...groupBy(items, (item) => item.warInstanceId).values()].map(representativeObservation);
  return { observationWeighted, warInstanceWeighted: { representativeWithinWar: "median actual remaining lifetime observation", ...metrics(predict, representative) } };
}

function metrics(predict: Prediction, items: Observation[]): object {
  const usable = items.map((item) => ({ item, predicted: predict(item) })).filter((item): item is { item: Observation; predicted: number } => item.predicted !== null && Number.isFinite(item.predicted));
  const errors = usable.map(({ item, predicted }) => predicted - item.actualRemainingWarTicks!);
  return { observationCount: usable.length, meanPredictionError: mean(errors), medianPredictionError: percentile(errors, .5), meanAbsoluteError: mean(errors.map(Math.abs)), overpredictionRate: rate(errors, (item) => item > 0), overprediction100Rate: rate(errors, (item) => item > 100), overprediction250Rate: rate(errors, (item) => item > 250), overprediction500Rate: rate(errors, (item) => item > 500), feasibilityQuality: Object.fromEntries(DURATIONS.map((duration) => [duration, feasibility(usable, duration)])) };
}

function feasibility(items: { item: Observation; predicted: number }[], duration: number): object {
  const actualSafe = items.filter(({ item }) => item.actualRemainingWarTicks! >= duration);
  const allowed = items.filter(({ predicted }) => predicted >= duration);
  const trueSafe = allowed.filter(({ item }) => item.actualRemainingWarTicks! >= duration);
  const falseSafe = allowed.length - trueSafe.length;
  return { durationTicks: duration, allowedCount: allowed.length, trueSafeRateAmongAllowed: allowed.length ? trueSafe.length / allowed.length : null, falseSafeRateAmongAllowed: allowed.length ? falseSafe / allowed.length : null, falseNegativeRate: actualSafe.length ? (actualSafe.length - trueSafe.length) / actualSafe.length : null, coverageOfGenuinelySafeOpportunities: actualSafe.length ? trueSafe.length / actualSafe.length : null, genuinelySafeCount: actualSafe.length };
}

function calibration(items: Observation[]): object[] { return BUCKETS.map((bucket) => { const matching = items.filter((item) => bucketFor(item.minSideResistance) === bucket); const values = matching.map((item) => item.actualRemainingWarTicks!); return { bucket: bucket === 9 ? "[0.9, 1.0]" : `[${(bucket / 10).toFixed(1)}, ${((bucket + 1) / 10).toFixed(1)})`, observationCount: matching.length, uniqueWarInstanceCount: uniqueWars(matching), actualRemainingWarTicks: { mean: mean(values), median: percentile(values, .5), p10: percentile(values, .1), p25: percentile(values, .25), p75: percentile(values, .75), p90: percentile(values, .9) }, currentLinearMinSideMetrics: metrics((item) => Math.round(120 + 1080 * item.minSideResistance), matching) }; }); }
function linearFit(items: Observation[]): { intercept: number; slope: number } { const xMean = mean(items.map((item) => item.minSideResistance))!; const yMean = mean(items.map((item) => item.actualRemainingWarTicks!))!; const denom = items.reduce((total, item) => total + (item.minSideResistance - xMean) ** 2, 0); const slope = denom ? items.reduce((total, item) => total + (item.minSideResistance - xMean) * (item.actualRemainingWarTicks! - yMean), 0) / denom : 0; return { intercept: round(yMean - slope * xMean), slope: round(slope) }; }
function capitalCap(value: number, item: Observation, threatenedCap: number, criticalCap: number): number { const threats = [item.attackerCapitalThreat, item.defenderCapitalThreat]; return threats.includes("critical") ? Math.min(value, criticalCap) : threats.includes("threatened") ? Math.min(value, threatenedCap) : value; }
function representativeObservation(items: Observation[]): Observation { return [...items].sort((a, b) => a.actualRemainingWarTicks! - b.actualRemainingWarTicks!)[Math.floor(items.length / 2)]; }
function bucketFor(value: number): number { return Math.min(9, Math.max(0, Math.floor(value * 10))); }
function uniqueWars(items: Observation[]): number { return new Set(items.map((item) => item.warInstanceId)).size; }
function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> { const result = new Map<string, T[]>(); for (const item of items) { const group = result.get(key(item)) ?? []; group.push(item); result.set(key(item), group); } return result; }
function mean(values: number[]): number | null { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null; }
function percentile(values: number[], q: number): number | null { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); const at = (sorted.length - 1) * q, lower = Math.floor(at), upper = Math.ceil(at); return sorted[lower] + (sorted[upper] - sorted[lower]) * (at - lower); }
function rate(values: number[], predicate: (value: number) => boolean): number | null { return values.length ? values.filter(predicate).length / values.length : null; }
function round(value: number): number { return Math.round(value * 1_000) / 1_000; }
