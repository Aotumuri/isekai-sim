import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { WorldState } from "../../src/sim/world-state";
import type { NationId } from "../../src/worldgen/nation";
import type { WarState } from "../../src/sim/war-state";
import { classifyCampaignCostWindow } from "../helpers/campaign-cost-window";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
const root = resolve(option("--engine-root", "/private/tmp/isekai-r2-15-29fa088"));
if (execFileSync("git", ["-C", root, "diff", "--", "src", "test"], { encoding: "utf8" })) {
  throw new Error("Commit engine and test source first");
}
const revision = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const sourceTree = execFileSync("git", ["-C", root, "rev-parse", "HEAD:src"], { encoding: "utf8" }).trim();
const load = (path: string) => import(pathToFileURL(resolve(root, path)).href);
const { createScenarioWorld } = await load("test/scenarios/index.ts");
const { runSimulation } = await load("test/helpers/simulation-driver.ts");
const { createWarOutcomeObserver } = await load("test/benchmark/war-outcome-observer.ts");
const { summarizeWorld } = await load("test/helpers/world-summary.ts");
const ticks = 10_000, seedStart = 822_748_319_780, seedCount = 4;
const scenarios = ["matched-war", "stalemate-breaker", "reorganization-heavy"];
const output = resolve(option("--output", "diagnostics/war-ai-cost-calibration-pilot.json.gz"));
const harnessHash = createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex");
const classifierHash = createHash("sha256")
  .update(await readFile(new URL("../helpers/campaign-cost-window.ts", import.meta.url))).digest("hex");
const observerHash = createHash("sha256")
  .update(await readFile(resolve(root, "test/benchmark/war-outcome-observer.ts")))
  .update(await readFile(resolve(root, "test/helpers/world-summary.ts"))).digest("hex");
interface CaseResult { seed: number; scenario: string; openingWars: object[]; observations: object[];
  comparisons: object[]; coverage: object; endWorld: unknown; warOutcomes: unknown }
const report = { revision, sourceTree, harnessHash, classifierHash, observerHash, engineRoot: root,
  runtime: { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch },
  ticks, campaignEnabled: true, seedStart, seedCount, scenarios,
  systems: { mobilizationEnabled: true, diplomacyEnabled: true, researchEnabled: true,
    armsAidEnabled: true, tradeEnabled: true, warCampaignEnabled: true, politicalTurbulenceEnabled: true },
  observationWindow: { originMaxFastTick: 900, futureMaxFastTick: 1200, horizonFastTicks: 300 },
  note: "Raw observational calibration only. Alternate resourceCost is retained as policy utility, not interpreted as casualty prediction. Stable-mode pairs are observational, not randomized. Overlapping 300-tick windows are correlated, not independent samples.",
  results: [] as CaseResult[] };
try {
  const saved = JSON.parse(gunzipSync(await readFile(output)).toString("utf8"));
  for (const key of ["revision", "sourceTree", "harnessHash", "classifierHash", "observerHash", "ticks", "campaignEnabled",
    "seedStart", "seedCount", "scenarios", "systems", "runtime", "observationWindow"] as const) {
    if (JSON.stringify(saved[key]) !== JSON.stringify(report[key])) throw new Error(`Incompatible ${key}`);
  }
  if (!Array.isArray(saved.results)) throw new Error("Invalid saved results");
  report.results.push(...saved.results);
} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
await mkdir(dirname(output), { recursive: true });
async function saveProgress(): Promise<void> {
  await writeFile(`${output}.tmp`, gzipSync(JSON.stringify(report)));
  await rename(`${output}.tmp`, output);
}

function warKey(war: WarState): string {
  const pair = [war.nationAId, war.nationBId].sort();
  return `${pair[0]}:${pair[1]}@${war.startedAtFastTick}`;
}
function capture(world: WorldState, nationId: NationId, opponentId: NationId, openingKey: string) {
  const nation = world.nations.find((item) => item.id === nationId)!;
  const plan = world.warCampaigns?.byNationId.get(nationId);
  const objective = plan?.objectives.find((item) => item.warKey === openingKey);
  const activeWars = world.wars.filter((war) => war.nationAId === nationId || war.nationBId === nationId)
    .map(warKey).sort();
  const units = world.units.filter((unit) => unit.nationId === nationId);
  const costs = world.warCampaigns?.battleCosts?.get(nationId);
  return { tick: world.time.fastTick, slowTick: world.time.slowTick, nationId, opponentId, openingWarKey: openingKey,
    planPresent: !!plan, objectivePresent: !!objective, openingWarActive: activeWars.includes(openingKey),
    activeWarMembershipKey: activeWars.join("|"),
    campaignMembershipKey: (plan?.objectives.map((item) => item.warKey).sort() ?? []).join("|"),
    openingDenominator: plan ? Math.max(1, ...plan.objectives.map((item) => item.openingManpower ?? item.openingStrength)) : null,
    objective: objective ? structuredClone(objective) : null,
    observation: plan?.observation ? structuredClone(plan.observation) : null,
    constraints: plan?.constraints ? structuredClone(plan.constraints) : null,
    alternatives: plan?.alternatives ? structuredClone(plan.alternatives) : null,
    militaryMode: plan?.militaryMode ?? null,
    primaryOpponentId: plan?.primaryOpponentId ?? null,
    battleCosts: costs ? { directManpowerDamage: costs.directManpowerDamage,
      removedManpower: costs.removedManpower } : null,
    landUnitCount: units.filter((unit) => unit.domain === "land").length,
    currentUnitManpower: units.reduce((sum, unit) => sum + unit.manpower, 0),
    resources: structuredClone(nation.resources) };
}

for (let offset = 0; offset < seedCount; offset += 1) {
  const seed = seedStart + offset;
  for (const scenario of scenarios) {
    if (report.results.some((row) => row.seed === seed && row.scenario === scenario)) continue;
    const world: WorldState = createScenarioWorld(scenario, { seed, quick: true, width: 640, height: 360,
      reserveEnabled: true, reorganizationEnabled: true, exploitationEnabled: true, pocketReductionEnabled: true,
      config: { systems: report.systems } });
    world.wars.forEach((war) => { war.isTest = false; });
    const openingWars = [...world.wars];
    const participants = openingWars.flatMap((war) => {
      const key = warKey(war);
      return [war.nationAId, war.nationBId].map((nationId) => ({ war, key, nationId,
        opponentId: nationId === war.nationAId ? war.nationBId : war.nationAId,
        role: nationId === war.aggressorId ? "aggressor" : "defender" }));
    });
    const snapshots = new Map<string, ReturnType<typeof capture>>();
    const outcomes = createWarOutcomeObserver();
    let lastSlowTick = world.time.slowTick;
    const originalInfo = console.info;
    console.info = () => undefined;
    try {
      runSimulation(world, { ticks, observe(current: WorldState) {
        outcomes.observe(current);
        if (current.time.slowTick === lastSlowTick) return;
        lastSlowTick = current.time.slowTick;
        if (current.time.fastTick > 1200) return;
        for (const item of participants) snapshots.set(`${item.key}:${item.nationId}:${current.time.fastTick}`,
          capture(current, item.nationId, item.opponentId, item.key));
      } });
    } finally { console.info = originalInfo; }
    const observations = [...snapshots.values()];
    const comparisons = participants.flatMap((item) => observations.filter((snapshot) =>
      snapshot.nationId === item.nationId && snapshot.openingWarKey === item.key && snapshot.tick <= 900 &&
      snapshot.openingWarActive && snapshot.objectivePresent).map((origin) => {
      const future = snapshots.get(`${item.key}:${item.nationId}:${origin.tick + 300}`);
      const intermediate = Array.from({ length: 30 }, (_, index) =>
        snapshots.get(`${item.key}:${item.nationId}:${origin.tick + (index + 1) * 10}`) ?? null);
      const classification = classifyCampaignCostWindow(origin, future ?? null, intermediate);
      return { openingWarKey: item.key, nationId: item.nationId, opponentId: item.opponentId,
        role: item.role, origin, future: future ?? null, ...classification };
    }));
    const coverage = comparisons.reduce((counts: Record<string, number>, row) => {
      const key = row.censorReason ?? "eligible"; counts[key] = (counts[key] ?? 0) + 1; return counts;
    }, {});
    report.results.push({ seed, scenario,
      openingWars: openingWars.map((war) => ({ key: warKey(war), nationAId: war.nationAId,
        nationBId: war.nationBId, aggressorId: war.aggressorId, startedAtFastTick: war.startedAtFastTick })),
      observations, comparisons, coverage, endWorld: summarizeWorld(world), warOutcomes: outcomes.result() });
    await saveProgress();
    console.log(`cost calibration ${scenario} ${seed}: ${report.results.length}/12`);
  }
}
