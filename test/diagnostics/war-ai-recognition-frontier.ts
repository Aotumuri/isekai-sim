import { readFile, writeFile, rename } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createScenarioWorld } from "../scenarios";
import { runSimulation } from "../helpers/simulation-driver";
import { withMutedSimulationLogs } from "../helpers/muted-logs";
import { summarizeWorld } from "../helpers/world-summary";
import { BenchmarkMetrics } from "../benchmark/metrics";
import { createWarOutcomeObserver } from "../benchmark/war-outcome-observer";
import { assessPeaceOffer, whitePeaceTerms, type PeaceTerms } from "../../src/sim/war-negotiations";
import { campaignRecognitionRegions, reciprocalRecognitionTerms } from "../../src/sim/war-campaign/peace-recognition";
import { canNegotiateCampaignBilateralPeace } from "../../src/sim/war-campaign/settlement-readiness";
import { createPeaceAssessmentContext } from "../../src/sim/peace-assessment-context";
import type { WorldState } from "../../src/sim/world-state";
import type { WarState } from "../../src/sim/war-state";
import type { BenchmarkScenarioName } from "../benchmark/types";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const seeds = Number(option("--seeds", "20")), ticks = Number(option("--ticks", "2000"));
if (![seeds, ticks].every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error("Invalid count");
if (execFileSync("git", ["diff", "--", "src"], { encoding: "utf8" })) throw new Error("Commit source first");
const output = option("--output", "diagnostics/war-ai-r2-recognition-frontier.json.gz");
const scenarios = ["matched-war", "stalemate-breaker", "reorganization-heavy"] as BenchmarkScenarioName[];
let report = { revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  sourceTree: execFileSync("git", ["rev-parse", "HEAD:src"], { encoding: "utf8" }).trim(),
  harnessHash: createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex"),
  runtime: { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch },
  seeds, ticks, scenarios, results: [] as ReturnType<typeof episode>[],
  note: "Read-only price frontier, paired observer-disabled controls. Scores before maturity indicate future willingness only. Repeated samples are correlated; no offers are published and no acceptance rule is changed." };
try {
  const saved = JSON.parse(gunzipSync(await readFile(output)).toString());
  for (const key of ["sourceTree", "harnessHash", "runtime", "seeds", "ticks", "scenarios"] as const) {
    if (JSON.stringify(saved[key]) !== JSON.stringify(report[key])) throw new Error(`Incompatible ${key}`);
  }
  report = saved;
} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
for (let i = 0; i < seeds; i++) for (const scenario of scenarios) {
  const seed = 822748319780 + i;
  for (const enabled of [false, true]) {
    if (report.results.some((r) => r.seed === seed && r.scenario === scenario && r.enabled === enabled)) continue;
    report.results.push(withMutedSimulationLogs(() => episode(seed, scenario, enabled)));
    await writeFile(`${output}.tmp`, gzipSync(JSON.stringify(report))); await rename(`${output}.tmp`, output);
  }
  const pair = report.results.filter((r) => r.seed === seed && r.scenario === scenario);
  for (const key of ["warOutcomes", "endWorld"] as const) {
    if (JSON.stringify(nonCpu(pair[0][key])) !== JSON.stringify(nonCpu(pair[1][key]))) throw new Error(`Observer changed ${scenario}:${seed} ${key}`);
  }
  console.log(`${scenario} ${seed}: observer parity; ${report.results.length}/${seeds * scenarios.length * 2}`);
}

function nonCpu(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(nonCpu);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !key.endsWith("CpuMs")).map(([key, item]) => [key, nonCpu(item)]));
  return value;
}

function episode(seed: number, scenario: BenchmarkScenarioName, enabled: boolean) {
  const world = createScenarioWorld(scenario, { seed, width: 640, height: 360, quick: true,
    reserveEnabled: true, reorganizationEnabled: true, exploitationEnabled: true, pocketReductionEnabled: true,
    config: { systems: { warCampaignEnabled: true, diplomacyEnabled: true, mobilizationEnabled: true,
      researchEnabled: true, armsAidEnabled: true, tradeEnabled: true, politicalTurbulenceEnabled: true } },
  });
  world.wars.forEach((war) => { war.isTest = false; });
  const opening = world.wars[0], outcomes = createWarOutcomeObserver();
  const stats = { heldSamples: 0, blockedRoute: 0, legalClaims: 0, unpublishedGoalSamples: 0, willingSamples: 0, executableSamples: 0,
    firstUnpublished: null as object | null, firstWilling: null as object | null, firstExecutable: null as object | null };
  class AuditMetrics extends BenchmarkMetrics {
    override recordDuration(name: string, ms: number) {
      super.recordDuration(name, ms);
      if (enabled && name === "warCampaign.evaluation" && world.wars.includes(opening)) inspectClaim(world, opening, stats);
    }
  }
  runSimulation(world, { ticks, metrics: new AuditMetrics(), observe: outcomes.observe });
  return { seed, scenario, enabled, stats, censoredOpening: world.wars.includes(opening),
    aggressor: opening.aggressorId, defender: opening.defenderId, warOutcomes: outcomes.result(), endWorld: summarizeWorld(world) };
}

function inspectClaim(world: WorldState, war: WarState, stats: {
  heldSamples: number; blockedRoute: number; legalClaims: number; unpublishedGoalSamples: number; willingSamples: number; executableSamples: number;
  firstUnpublished: object | null; firstWilling: object | null; firstExecutable: object | null;
}) {
  const campaign = world.warCampaigns?.byNationId.get(war.aggressorId);
  const goal = campaign?.objectives.find((g) => g.opponentId === war.defenderId);
  if (!goal?.achieved || goal.political?.purpose !== "territorial-concession") return;
  stats.heldSamples++;
  if (!canNegotiateCampaignBilateralPeace(world, war)) { stats.blockedRoute++; return; }
  const negotiation = [...(world.warNegotiations?.active.values() ?? [])].find((n) =>
    [n.a, n.b].includes(war.aggressorId) && [n.a, n.b].includes(war.defenderId));
  if (!negotiation || !negotiation.automatic.get(war.aggressorId) || !negotiation.automatic.get(war.defenderId)) return;
  const ids = campaignRecognitionRegions(world, war.aggressorId, war.defenderId);
  if (!ids.length || !goal.regionIds.every((id) => ids.includes(id))) return;
  stats.legalClaims++;
  const published = negotiation.offers.get(war.aggressorId)!;
  if (!ids.every((id) => published.terms.demandedRegionIds.includes(id))) {
    stats.unpublishedGoalSamples++;
    stats.firstUnpublished ??= { tick: world.time.fastTick, mode: campaign!.mode, goalIds: [...ids], published: structuredClone(published) };
  }
  const base = { ...whitePeaceTerms(), demandedRegionIds: ids, truceSeconds: published.terms.truceSeconds };
  const max = Math.min(100, Math.floor(world.nations.find((n) => n.id === war.aggressorId)!.resources.weapons));
  const candidate = minimumCompensation(world, war, base, max);
  if (!candidate) return;
  stats.willingSamples++;
  const snapshot = { tick: world.time.fastTick, mode: campaign!.mode, militaryMode: campaign!.militaryMode,
    goalIds: [...ids], compensation: candidate.terms.offeredWeapons, ourScore: candidate.ours.score, theirScore: candidate.theirs.score,
    ourAcceptance: candidate.ours.accepts, theirAcceptance: candidate.theirs.accepts,
    publishedGoalCoverage: ids.every((id) => published.terms.demandedRegionIds.includes(id)),
    published: structuredClone(published), costFraction: campaign!.constraints.casualtyFraction };
  stats.firstWilling ??= snapshot;
  if (candidate.ours.accepts && candidate.theirs.accepts) { stats.executableSamples++; stats.firstExecutable ??= snapshot; }
}

function minimumCompensation(world: WorldState, war: WarState, base: PeaceTerms, max: number) {
  const context = createPeaceAssessmentContext();
  const assess = (payment: number) => {
    const terms = { ...base, offeredWeapons: payment };
    return { terms, theirs: assessPeaceOffer(world, war.defenderId, war.aggressorId, terms, context),
      ours: assessPeaceOffer(world, war.aggressorId, war.defenderId, reciprocalRecognitionTerms(terms), context) };
  };
  let candidate = assess(0);
  if (candidate.theirs.score < 0) {
    if (max <= 0 || assess(max).theirs.score < 0) return undefined;
    let low = 1, high = max;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (assess(mid).theirs.score >= 0) high = mid; else low = mid + 1;
    }
    candidate = assess(low);
  }
  return candidate.ours.score >= 0 && candidate.theirs.score >= 0 ? candidate : undefined;
}
