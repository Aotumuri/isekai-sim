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
import { updateNationFrontPlans } from "../../src/sim/nation-front-plans";
import type { WorldState } from "../../src/sim/world-state";
import type { WarState } from "../../src/sim/war-state";
import type { BenchmarkScenarioName } from "../benchmark/types";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1];
};
const seeds = Number(option("--seeds", "4")), ticks = Number(option("--ticks", "10000"));
if (![seeds, ticks].every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error("Invalid count");
if (execFileSync("git", ["diff", "--", "src"], { encoding: "utf8" })) throw new Error("Commit simulation source first");
const output = option("--output", "diagnostics/war-ai-r2-11-loss-exit-probe.json.gz");
const scenarios = ["active-war", "matched-war", "stalemate-breaker", "reorganization-heavy"] as BenchmarkScenarioName[];
const arms = ["normal", "review", "front-loss-exit-removed"] as const;
type Arm = typeof arms[number];
const sourceTree = execFileSync("git", ["rev-parse", "HEAD:src"], { encoding: "utf8" }).trim();
const harnessHash = createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex");
let report = { revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), sourceTree, harnessHash,
  runtime: { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch },
  note: "Intervention only during opening defender front planning; losses/production cover the whole episode, including later wars. National decisions, food limits and later consumers retain the original budget.",
  seeds, ticks, scenarios, arms, results: [] as ReturnType<typeof probe>[] };
try {
  const saved = JSON.parse(gunzipSync(await readFile(output)).toString());
  for (const key of ["sourceTree", "harnessHash", "runtime", "seeds", "ticks", "scenarios", "arms"] as const) {
    if (JSON.stringify(saved[key]) !== JSON.stringify(report[key])) throw new Error(`Incompatible ${key}`);
  }
  report = saved;
} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
for (let i = 0; i < seeds; i++) for (const scenario of scenarios) for (const arm of arms) {
  const seed = 1022748319780 + i;
  if (report.results.some((r) => r.seed === seed && r.scenario === scenario && r.arm === arm)) continue;
  report.results.push(withMutedSimulationLogs(() => probe(seed, scenario, arm)));
  await writeFile(`${output}.tmp`, gzipSync(JSON.stringify(report))); await rename(`${output}.tmp`, output);
  console.log(`${scenario} ${seed} ${arm}: ${report.results.length}/${seeds * scenarios.length * arms.length}`);
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
    warOutcomes: outcomes.result(), costs: loss.result(), productionSpending: Object.fromEntries(spending), endWorld: summarizeWorld(world) };
}

function probeMetrics(world: WorldState, openingWar: WarState, arm: Arm, loss: ReturnType<typeof createFieldLossObserver>) {
  const stats = { reviews: 0, eligibleLossExits: 0, interventions: 0, examples: [] as object[] };
  class ProbeMetrics extends BenchmarkMetrics {
    override recordDuration(name: string, ms: number) {
      super.recordDuration(name, ms);
      if (name === "repositionUnits") loss.before(world);
      if (name === "battle.update") loss.after(world);
      if (name !== "warCampaign.evaluation" || !world.wars.includes(openingWar)) return;
      const campaign = world.warCampaigns?.byNationId.get(openingWar.defenderId);
      if (!campaign) return;
      const constraints = campaign.constraints;
      const eligible = constraints.foodSeconds >= 45 && constraints.casualtyFraction >= constraints.costTolerance;
      if (eligible) stats.eligibleLossExits++;
      if (arm === "normal") return;
      const tolerance = constraints.costTolerance;
      try {
        if (eligible && arm === "front-loss-exit-removed") {
          constraints.costTolerance = Infinity; stats.interventions++;
        }
        // Both review arms rebuild at this exact boundary. All national choices
        // precede the intervention; every later consumer sees the real budget.
        world.frontPlans.campaignVersion = -1;
        updateNationFrontPlans(world); stats.reviews++;
        if (eligible && stats.examples.length < 12) stats.examples.push({ tick: world.time.fastTick,
          mode: campaign.mode, military: campaign.militaryMode, fraction: constraints.casualtyFraction,
          tolerance, capitalCritical: constraints.capitalCritical, ready: campaign.settlementReadyOpponentIds,
          plans: structuredClone(world.frontPlans.plansByNationId.get(openingWar.defenderId) ?? []) });
      } finally { constraints.costTolerance = tolerance; }
    }
  }
  return { metrics: new ProbeMetrics(), stats };
}
