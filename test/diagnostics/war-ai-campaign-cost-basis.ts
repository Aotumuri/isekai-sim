import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { getWarCasualties } from "../../src/sim/war-state";
import type { WarCampaign } from "../../src/sim/war-campaign/state";
import type { WorldState } from "../../src/sim/world-state";
import { BenchmarkMetrics } from "../benchmark/metrics";
import type { BenchmarkScenarioName } from "../benchmark/types";
import { createWarOutcomeObserver } from "../benchmark/war-outcome-observer";
import { withMutedSimulationLogs } from "../helpers/muted-logs";

const scenario = process.argv[2] as BenchmarkScenarioName;
if (!["matched-war", "stalemate-breaker", "reorganization-heavy"].includes(scenario)) {
  throw new Error("Supply a registered development scenario");
}
const output = process.argv[3] ?? `diagnostics/war-ai-r2-25-basis-${scenario}.json.gz`;
const args = process.argv.slice(4);
const option = (name: string) => {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
};
const engine = option("--engine-root");
const root = resolve(engine ?? ".");
const onlySeed = option("--seed");
const rawWindow = option("--decision-window");
const match = rawWindow?.match(/^(\d+):(\d+)$/);
if (rawWindow && (!match || Number(match[1]) > Number(match[2]) || onlySeed === undefined)) {
  throw new Error("A decision window requires ordered tick bounds and a single seed");
}
const window = match ? [Number(match[1]), Number(match[2])] as const : undefined;
const seedStart = 822_748_319_780;
const seeds = Array.from({ length: 20 }, (_, offset) => seedStart + offset)
  .filter((seed) => onlySeed === undefined || String(seed) === onlySeed);
if (!seeds.length) throw new Error("Use a registered development seed");
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
if (git("status", "--porcelain", "--", "src")) throw new Error("Commit the engine source first");
const sourceTree = git("rev-parse", "HEAD:src");
if (!engine && sourceTree !== git("rev-parse", "29fa088:src")) throw new Error("Use the canonical source");
const load = (path: string) => import(pathToFileURL(resolve(root, path)).href);
const { createScenarioWorld } = await load("test/scenarios/index.ts") as typeof import("../scenarios");
const { runSimulation } = await load("test/helpers/simulation-driver.ts") as typeof import("../helpers/simulation-driver");
const { summarizeWorld } = await load("test/helpers/world-summary.ts") as typeof import("../helpers/world-summary");
const ticks = 10_000;

function snapshot(world: WorldState, plan: WarCampaign) {
  const observation = plan.observation!;
  const ledger = world.warCampaigns?.battleCosts?.get(plan.nationId);
  const activeCasualties = world.wars.filter((war) =>
    war.nationAId === plan.nationId || war.nationBId === plan.nationId)
    .reduce((total, war) => total + getWarCasualties(war, plan.nationId), 0);
  return {
    tick: observation.tick, nationId: plan.nationId, casualtyFraction: observation.casualtyFraction,
    denominator: Math.max(1, ...plan.objectives.map((goal) => goal.openingManpower ?? goal.openingStrength)),
    cumulativeLedger: { direct: ledger?.directManpowerDamage ?? 0, removed: ledger?.removedManpower ?? 0 },
    activeCasualties, lossRate: observation.lossRate,
    wars: plan.objectives.map((goal) => goal.warKey).sort(),
    mode: plan.mode, militaryMode: plan.militaryMode, primaryOpponentId: plan.primaryOpponentId,
    reason: plan.reason, costTolerance: plan.constraints.costTolerance,
    capitalCritical: plan.constraints.capitalCritical, foodSeconds: plan.constraints.foodSeconds,
  };
}

function run(seed: number) {
  const world = createScenarioWorld(scenario, {
    seed, quick: true, width: 640, height: 360,
    reserveEnabled: true, reorganizationEnabled: true, exploitationEnabled: true, pocketReductionEnabled: true,
    config: { systems: { warCampaignEnabled: true, diplomacyEnabled: true, mobilizationEnabled: true,
      researchEnabled: true, armsAidEnabled: true, tradeEnabled: true, politicalTurbulenceEnabled: true } },
  });
  world.wars.forEach((war) => { war.isTest = false; });
  const startFingerprint = createHash("sha256").update(JSON.stringify({
    units: world.units, wars: world.wars, macroRegions: world.macroRegions,
    resources: world.nations.map((nation) => [nation.id, nation.resources]),
  })).digest("hex");
  const outcomes = createWarOutcomeObserver();
  const transitions: object[] = [];
  const decisions: object[] = [];
  let previous = new Map<string, ReturnType<typeof snapshot>>();
  let comparedDecisions = 0;
  class CostBasisMetrics extends BenchmarkMetrics {
    override recordDuration(name: string, ms: number) {
      super.recordDuration(name, ms);
      if (name !== "warCampaign.evaluation") return;
      const next = new Map<string, ReturnType<typeof snapshot>>();
      for (const plan of world.warCampaigns?.byNationId.values() ?? []) {
        if (!plan.observation) continue;
        const after = snapshot(world, plan);
        next.set(plan.nationId, after);
        if (window && after.tick >= window[0] && after.tick <= window[1]) {
          decisions.push({ ...after, alternatives: plan.alternatives?.map((alternative) => ({
            opponentId: alternative.opponentId, mode: alternative.mode, score: alternative.score,
            resourceCost: alternative.resourceCost,
          })) });
        }
        const before = previous.get(plan.nationId);
        if (!before || after.tick <= before.tick) continue;
        comparedDecisions++;
        if (before.denominator === after.denominator) continue;
        const basisScale = before.denominator / after.denominator;
        const elapsed = (after.tick - before.tick) / 10;
        const correctedRaw = Math.max(0, after.casualtyFraction - before.casualtyFraction * basisScale) / elapsed;
        const correctedSmoothed = before.lossRate * basisScale * 0.8 + correctedRaw * 0.2;
        transitions.push({
          before, after, correctedSmoothed,
          physicalLossDelta: after.casualtyFraction * after.denominator - before.casualtyFraction * before.denominator,
          unclippedForecastDelta: (correctedSmoothed - after.lossRate) * 30,
          clippedForecastDelta: Math.min(1, correctedSmoothed * 30) - Math.min(1, after.lossRate * 30),
        });
      }
      previous = next;
    }
  }
  runSimulation(world, { ticks, metrics: new CostBasisMetrics(), observe: outcomes.observe });
  return { scenario, seed, startFingerprint, comparedDecisions, transitions,
    warOutcomes: outcomes.result(), endWorld: summarizeWorld(world), ...(window ? { decisions } : {}) };
}

const results: ReturnType<typeof run>[] = [];
for (const seed of seeds) {
  const result = withMutedSimulationLogs(() => run(seed));
  results.push(result);
  console.log(`${scenario} ${seed}: ${result.transitions.length} denominator transitions`);
}
const report = {
  revision: git("rev-parse", "HEAD"), sourceTree,
  harnessHash: createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex"),
  runtime: { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch },
  ticks, campaign: true, ...(window ? { decisionWindow: window } : {}), results,
};
await writeFile(`${output}.tmp`, gzipSync(JSON.stringify(report)));
await rename(`${output}.tmp`, output);
