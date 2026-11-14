import { readFile, writeFile, rename } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createScenarioWorld } from "../scenarios";
import { runSimulation } from "../helpers/simulation-driver";
import { withMutedSimulationLogs } from "../helpers/muted-logs";
import { createFieldLossObserver } from "../helpers/field-loss-observer";
import { summarizeWorld } from "../helpers/world-summary";
import { BenchmarkMetrics } from "../benchmark/metrics";
import { createWarOutcomeObserver } from "../benchmark/war-outcome-observer";
import { campaignCostLimitReached } from "../../src/sim/war-campaign/policy";
import type { WorldState } from "../../src/sim/world-state";
import type { WarState } from "../../src/sim/war-state";
import type { BenchmarkScenarioName } from "../benchmark/types";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1];
};
const ticks = Number(option("--ticks", "600"));
if (!Number.isSafeInteger(ticks) || ticks <= 0) throw new Error("Invalid count");
if (execFileSync("git", ["diff", "--", "src"], { encoding: "utf8" })) throw new Error("Commit simulation source first");
const output = option("--output", "diagnostics/war-ai-defender-effort-probe.json.gz");
const cases = [
  ...[780, 786, 790].map((suffix) => ({ scenario: "stalemate-breaker" as BenchmarkScenarioName, seed: 822748319000 + suffix })),
  ...[780, 789, 790, 792].map((suffix) => ({ scenario: "reorganization-heavy" as BenchmarkScenarioName, seed: 822748319000 + suffix })),
  ...[781, 789].map((suffix) => ({ scenario: "matched-war" as BenchmarkScenarioName, seed: 822748319000 + suffix })),
];
const arms = ["normal", "defend", "limited-offensive"] as const;
type Arm = typeof arms[number];
const sourceTree = execFileSync("git", ["rev-parse", "HEAD:src"], { encoding: "utf8" }).trim();
const harnessHash = createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex");
let report = { revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), sourceTree, harnessHash,
  runtime: { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch },
  note: "Selected R2.11 defender-survival regressions, not adoption evidence. Force military effort only while the opening war exists, preserving capital, food, budget and negotiated exits. Losses/production cover the whole episode; unfinished wars are censored.",
  ticks, cases, arms, results: [] as ReturnType<typeof probe>[] };
try {
  const saved = JSON.parse(gunzipSync(await readFile(output)).toString());
  for (const key of ["sourceTree", "harnessHash", "runtime", "ticks", "cases", "arms"] as const) {
    if (JSON.stringify(saved[key]) !== JSON.stringify(report[key])) throw new Error(`Incompatible ${key}`);
  }
  report = saved;
} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
for (const { seed, scenario } of cases) for (const arm of arms) {
  if (report.results.some((r) => r.seed === seed && r.scenario === scenario && r.arm === arm)) continue;
  report.results.push(withMutedSimulationLogs(() => probe(seed, scenario, arm)));
  await writeFile(`${output}.tmp`, gzipSync(JSON.stringify(report))); await rename(`${output}.tmp`, output);
  console.log(`${scenario} ${seed} ${arm}: ${report.results.length}/${cases.length * arms.length}`);
}

function probe(seed: number, scenario: BenchmarkScenarioName, arm: Arm) {
  const world = createScenarioWorld(scenario, { seed, width: 640, height: 360, quick: true,
    reserveEnabled: true, reorganizationEnabled: true, exploitationEnabled: true, pocketReductionEnabled: true,
    config: { systems: { warCampaignEnabled: true, diplomacyEnabled: true, mobilizationEnabled: true,
      researchEnabled: true, armsAidEnabled: true, tradeEnabled: true, politicalTurbulenceEnabled: true } },
  });
  world.wars.forEach((war) => { war.isTest = false; });
  const openingWar = world.wars[0], loss = createFieldLossObserver(), outcomes = createWarOutcomeObserver();
  const { metrics, stats } = probeMetrics(world, openingWar, arm, loss);
  const spending = new Map<string, { lastTick: number; manpower: number; weapons: number }>();
  runSimulation(world, { ticks, metrics, observe(current) {
    outcomes.observe(current);
    for (const nation of current.nations) {
      const spent = spending.get(nation.id) ?? { lastTick: -1, manpower: 0, weapons: 0 };
      if (nation.resourceFlow.lastTick === spent.lastTick) continue;
      spent.lastTick = nation.resourceFlow.lastTick;
      spent.manpower += nation.resourceFlow.usage.manpower; spent.weapons += nation.resourceFlow.usage.weapons;
      spending.set(nation.id, spent);
    }
  } });
  return { seed, scenario, arm, defender: openingWar.defenderId, aggressor: openingWar.aggressorId, stats,
    censoredOpening: world.wars.includes(openingWar),
    episodeSurvival: Object.fromEntries(world.nations.map((nation) => [nation.id, nation.macroRegionIds.length > 0])),
    warOutcomes: outcomes.result(), costs: loss.result(), productionSpending: Object.fromEntries(spending), endWorld: summarizeWorld(world) };
}

function probeMetrics(world: WorldState, openingWar: WarState, arm: Arm, loss: ReturnType<typeof createFieldLossObserver>) {
  const stats = { eligible: 0, interventions: 0, protected: 0, examples: [] as object[] };
  class ProbeMetrics extends BenchmarkMetrics {
    override recordDuration(name: string, ms: number) {
      super.recordDuration(name, ms);
      if (name === "repositionUnits") loss.before(world);
      if (name === "battle.update") loss.after(world);
      if (name !== "warCampaign.evaluation" || !world.wars.includes(openingWar)) return;
      const campaign = world.warCampaigns?.byNationId.get(openingWar.defenderId);
      if (!campaign) return;
      if (campaign.constraints.capitalCritical || campaignCostLimitReached(campaign.constraints) ||
        campaign.mode === "seek-peace" || campaign.mode === "consolidate") { stats.protected++; return; }
      stats.eligible++;
      if (arm === "normal") return;
      if (campaign.mode === arm && campaign.militaryMode === arm && campaign.primaryOpponentId === openingWar.aggressorId) return;
      if (stats.examples.length < 12) stats.examples.push({ tick: world.time.fastTick,
        before: { mode: campaign.mode, militaryMode: campaign.militaryMode, primary: campaign.primaryOpponentId },
        alternatives: structuredClone(campaign.alternatives) });
      campaign.mode = arm; campaign.militaryMode = arm; campaign.primaryOpponentId = openingWar.aggressorId;
      campaign.revision++; world.warCampaigns!.version++; stats.interventions++;
    }
  }
  return { metrics: new ProbeMetrics(), stats };
}
