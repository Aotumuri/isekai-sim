import { readFile, writeFile } from "node:fs/promises";

const INPUT = "diagnostics/war-window-report.json";
const OUTPUT = "diagnostics/war-window-stability-report.json";
const FIRST_SEED = 822_748_319_788;
const SPLIT = FIRST_SEED + 20;
const B = Array.from({ length: 10 }, (_, i) => i);
const D = [300, 500, 750, 1_000];
type Threat = "none" | "threatened" | "critical" | null;
interface O { seed: number; warInstanceId: string; minSideResistance: number; attackerCapitalThreat: Threat; defenderCapitalThreat: Threat; actualRemainingWarTicks: number | null; attributionValid: boolean; rightCensored: boolean; }
type P = (o: O) => number | null;
const source = JSON.parse(await readFile(INPUT, "utf8")) as { observations?: O[]; experiment?: unknown };
if (!Array.isArray(source.observations)) throw new Error(`Missing observations in ${INPUT}`);
const resolved = source.observations.filter((o) => o.attributionValid && !o.rightCensored && o.actualRemainingWarTicks !== null);
const train = resolved.filter((o) => o.seed < SPLIT), evaluation = resolved.filter((o) => o.seed >= SPLIT);
if (!train.length || !evaluation.length) throw new Error("Expected a complete 30-seed report with resolved train and evaluation observations.");
const exactBucketMedians = B.map((b) => q(train.filter((o) => bucket(o.minSideResistance) === b).map((o) => o.actualRemainingWarTicks!), .5));
const linear = fit(train);
const fiveBand = [
  { name: "M1-five-band-rounded", rules: "r<.2→150; .2≤r<.5→300; .5≤r<.8→500; .8≤r<.9→850; r≥.9→1200", values: [150, 300, 500, 850, 1_200] },
  { name: "M2-five-band-cautious-middle", rules: "r<.2→150; .2≤r<.5→250; .5≤r<.8→450; .8≤r<.9→800; r≥.9→1150", values: [150, 250, 450, 800, 1_150] },
];
const candidates = [
  { name: "A-current-linear-min-side", rules: "round(120 + 1080r)", predict: (o: O) => Math.round(120 + 1080 * o.minSideResistance) },
  { name: "B-fitted-linear-min-side", rules: `max(0, round(${linear.intercept} + ${linear.slope}r)); fit on first 20 seeds`, predict: (o: O) => Math.max(0, Math.round(linear.intercept + linear.slope * o.minSideResistance)) },
  { name: "C-exact-0.1-bucket-median", rules: "first-20-seed bucket medians", predict: (o: O) => exactBucketMedians[bucket(o.minSideResistance)] },
  ...fiveBand.map((c) => ({ name: c.name, rules: c.rules, predict: (o: O) => c.values[band(o.minSideResistance)] })),
];
const output = {
  experiment: { sourceReport: INPUT, split: { trainingSeeds: `${FIRST_SEED}-${SPLIT - 1}`, evaluationSeeds: `${SPLIT}-${FIRST_SEED + 29}` }, rightCensoring: "Excluded from exact-lifetime metrics; never counted as failures." },
  bucketStability: { observationWeightedPerSeed: seedBucketStats(resolved, false), warInstanceWeightedPerSeed: seedBucketStats(resolved, true), interpretation: "Each per-seed value is a median; the displayed distribution prevents long-running seeds from dominating." },
  candidateDefinitions: { exactTrainingBucketMedians: exactBucketMedians, monotonicBandBoundaries: [0, .2, .5, .8, .9, 1], rationale: "The first two 0.1 buckets have similarly short central lifetimes; .2-.4 and .5-.7 have unstable adjacent bucket medians, so they are deliberately pooled; .8-.9 and .9-1.0 retain the consistently longer upper-resistance regimes." },
  comparison: candidates.map((c) => ({ name: c.name, rules: c.rules, evaluation: both(c.predict, evaluation) })),
  sensitivity: fiveBand.map((c) => ({ base: c.name, variants: [-100, 100].map((delta) => ({ deltaTicksAppliedToEveryBand: delta, rules: `${c.rules}; each band ${delta >= 0 ? "+" : ""}${delta}`, evaluation: both((o) => Math.max(0, c.values[band(o.minSideResistance)] + delta), evaluation) })) })),
  capitalThreatAsSeparateRiskSignal: capitalRisk(evaluation),
  limitation: "This is a deterministic temporal seed split, not independent future-world validation. Results establish relative stability and safety/coverage trade-offs, not a guaranteed lifetime forecast.",
};
await writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(`War-window stability diagnostic complete: ${OUTPUT}`);

function seedBucketStats(items: O[], warWeighted: boolean): object[] { return B.map((b) => { const values: number[] = []; const wars = new Set<string>(); for (const seedItems of group(items.filter((o) => bucket(o.minSideResistance) === b), (o) => String(o.seed)).values()) { const source = warWeighted ? [...group(seedItems, (o) => o.warInstanceId).values()].map((w) => q(w.map((o) => o.actualRemainingWarTicks!), .5)!) : seedItems.map((o) => o.actualRemainingWarTicks!); if (source.length) values.push(q(source, .5)!); for (const o of seedItems) wars.add(o.warInstanceId); } return { bucket: label(b), seedsContainingObservations: values.length, uniqueWarInstances: wars.size, perSeedMedianDistribution: { median: q(values,.5), p25: q(values,.25), p75: q(values,.75), min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null } }; }); }
function both(p: P, items: O[]): object { return { observationWeighted: metrics(p, items), warInstanceWeighted: { representativeWithinWar: "median actual remaining lifetime observation", ...metrics(p, [...group(items, (o) => o.warInstanceId).values()].map(rep)) } }; }
function metrics(p: P, items: O[]): object { const rows = items.map((o) => ({ o, v: p(o) })).filter((x): x is { o: O; v: number } => x.v !== null); const e = rows.map((x) => x.v - x.o.actualRemainingWarTicks!); return { observationCount: rows.length, meanPredictionError: mean(e), medianPredictionError: q(e,.5), meanAbsoluteError: mean(e.map(Math.abs)), overprediction250Rate: rate(e, (x) => x > 250), overprediction500Rate: rate(e, (x) => x > 500), feasibility: Object.fromEntries(D.map((d) => [d, feasibility(rows,d)])) }; }
function feasibility(rows: { o: O; v: number }[], d: number): object { const safe = rows.filter((x) => x.o.actualRemainingWarTicks! >= d), allowed = rows.filter((x) => x.v >= d), good = allowed.filter((x) => x.o.actualRemainingWarTicks! >= d); return { allowedCount: allowed.length, falseSafeRate: allowed.length ? (allowed.length-good.length)/allowed.length : null, coverage: safe.length ? good.length/safe.length : null }; }
function capitalRisk(items: O[]): object { const groups = { "either-critical": items.filter((o) => o.attackerCapitalThreat === "critical" || o.defenderCapitalThreat === "critical"), "either-threatened-or-critical": items.filter((o) => ["threatened","critical"].includes(o.attackerCapitalThreat ?? "") || ["threatened","critical"].includes(o.defenderCapitalThreat ?? "")), "neither-threatened": items.filter((o) => (o.attackerCapitalThreat === "none" || o.attackerCapitalThreat === null) && (o.defenderCapitalThreat === "none" || o.defenderCapitalThreat === null)) }; return Object.fromEntries(Object.entries(groups).map(([name, rows]) => [name, { observationCount: rows.length, actualRemainingWarTicks: { median: q(rows.map((o) => o.actualRemainingWarTicks!),.5), p25: q(rows.map((o) => o.actualRemainingWarTicks!),.25) }, allowedByBestMonotonicAt500: feasibility(rows.map((o) => ({ o, v: fiveBand[0].values[band(o.minSideResistance)] })),500) }])); }
function fit(items: O[]): { intercept:number; slope:number } { const xm=mean(items.map((o)=>o.minSideResistance))!, ym=mean(items.map((o)=>o.actualRemainingWarTicks!))!, den=items.reduce((s,o)=>s+(o.minSideResistance-xm)**2,0), slope=den?items.reduce((s,o)=>s+(o.minSideResistance-xm)*(o.actualRemainingWarTicks!-ym),0)/den:0; return {intercept: round(ym-slope*xm),slope:round(slope)}; }
function band(r:number):number{return r<.2?0:r<.5?1:r<.8?2:r<.9?3:4;} function bucket(r:number):number{return Math.min(9,Math.max(0,Math.floor(r*10)));} function label(b:number):string{return b===9?"[0.9, 1.0]":`[${(b/10).toFixed(1)}, ${((b+1)/10).toFixed(1)})`;}
function group<T>(items:T[],f:(x:T)=>string):Map<string,T[]>{const m=new Map<string,T[]>();for(const x of items){const a=m.get(f(x))??[];a.push(x);m.set(f(x),a);}return m;} function rep(x:O[]):O{return [...x].sort((a,b)=>a.actualRemainingWarTicks!-b.actualRemainingWarTicks!)[Math.floor(x.length/2)];} function mean(x:number[]):number|null{return x.length?x.reduce((a,b)=>a+b,0)/x.length:null;} function q(x:number[],p:number):number|null{if(!x.length)return null;const s=[...x].sort((a,b)=>a-b),i=(s.length-1)*p,l=Math.floor(i),h=Math.ceil(i);return s[l]+(s[h]-s[l])*(i-l);} function rate(x:number[],f:(v:number)=>boolean):number|null{return x.length?x.filter(f).length/x.length:null;} function round(x:number):number{return Math.round(x*1000)/1000;}
