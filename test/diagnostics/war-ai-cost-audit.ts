import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createFieldLossObserver } from "../helpers/field-loss-observer";
import { createOpeningGovernmentObserver } from "../helpers/war-government-outcome-observer";
import type { WorldState } from "../../src/sim/world-state";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1];
};
const root = resolve(option("--engine-root", "."));
if (execFileSync("git", ["-C", root, "diff", "--", "src", "test"], { encoding: "utf8" })) throw new Error("Commit engine and test source first");
const revision = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const sourceTree = execFileSync("git", ["-C", root, "rev-parse", "HEAD:src"], { encoding: "utf8" }).trim();
const harnessHash = createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex");
const observerHash = createHash("sha256")
  .update(await readFile(new URL("../helpers/field-loss-observer.ts", import.meta.url)))
  .update(await readFile(new URL("../helpers/war-government-outcome-observer.ts", import.meta.url))).digest("hex");
const load = (path: string) => import(pathToFileURL(resolve(root, path)).href);
const { createScenarioWorld } = await load("test/scenarios/index.ts");
const { runSimulation } = await load("test/helpers/simulation-driver.ts");
const { BenchmarkMetrics } = await load("test/benchmark/metrics.ts");
const { getWarCasualties } = await load("src/sim/war-state.ts");
const { getSubjectOverlord } = await load("src/sim/subject-governments.ts");
const { createWarOutcomeObserver } = await load("test/benchmark/war-outcome-observer.ts");
const { summarizeWorld } = await load("test/helpers/world-summary.ts");
const campaign = args.includes("--campaign");
const ticks = Number(option("--ticks", "1000"));
const count = Number(option("--seeds", "4"));
const seedStart = Number(option("--seed-start", "1022748319780"));
const scenarios = option("--scenarios", "matched-war,stalemate-breaker,reorganization-heavy,two-island-amphibious").split(",");
if (![ticks, count, seedStart].every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error("Invalid integers");
interface AuditCase { seed: number; scenario: string; [key: string]: unknown }
const results: AuditCase[] = [];
const output = resolve(option("--output", "diagnostics/war-ai-r2-cost-audit.json.gz"));
const report = { revision, sourceTree, harnessHash, observerHash,
  runtime: { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch },
  engineRoot: root, campaign, ticks, seeds: count, seedStart, scenarios,
  note: "Field losses and totalDirectWarCasualties cover the whole episode; production flow excludes recovery, trade and aid. openingWarSides direct casualties cover opening wars only; alive is episode-end territory survival. openingGovernmentOutcomes freeze at opening-war end, or are censored. Compare scopes explicitly.", results };
try {
  const saved = JSON.parse(gunzipSync(await readFile(output)).toString());
  for (const key of ["revision", "sourceTree", "harnessHash", "observerHash", "runtime", "campaign", "ticks", "seeds", "seedStart", "scenarios"] as const) {
    if (JSON.stringify(saved[key]) !== JSON.stringify(report[key])) throw new Error(`Incompatible ${key}`);
  }
  if (!Array.isArray(saved.results)) throw new Error("Invalid saved results");
  results.push(...saved.results);
} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
await mkdir(dirname(output), { recursive: true });
async function saveAuditProgress(): Promise<void> {
  await writeFile(`${output}.tmp`, gzipSync(JSON.stringify(report)));
  await rename(`${output}.tmp`, output);
}
const original = console.info;
console.info = () => undefined;
try {
  for (let i = 0; i < count; i++) {
    for (const scenario of scenarios) {
      const seed = seedStart + i;
      if (results.some((row) => row.seed === seed && row.scenario === scenario)) continue;
      const world: WorldState = createScenarioWorld(scenario, { seed, quick: true, width: 640, height: 360,
        reserveEnabled: true, reorganizationEnabled: true, exploitationEnabled: true, pocketReductionEnabled: true,
        config: { systems: { warCampaignEnabled: campaign, diplomacyEnabled: true, mobilizationEnabled: true,
          researchEnabled: true, armsAidEnabled: true, tradeEnabled: true, politicalTurbulenceEnabled: true } } });
      world.wars.forEach((war) => { war.isTest = false; });
      const openingWars = [...world.wars];
      const governments = createOpeningGovernmentObserver(world, openingWars);
      const seenWars = new Set(world.wars);
      const outcomes = createWarOutcomeObserver();
      const settlements = new Map<string, NonNullable<WorldState["warNegotiations"]>["settlements"][number]>();
      const startFingerprint = createHash("sha256").update(JSON.stringify({
        units: world.units, wars: world.wars, macroRegions: world.macroRegions,
        resources: world.nations.map((n) => [n.id, n.resources]),
      })).digest("hex");
      const loss = createFieldLossObserver();
      const ledgerTotals = new Map<string, { direct: number; removed: number; weapons: number }>();
      const ledgerSamples = new Map<string, { entry: object; direct: number; removed: number; weapons: number }>();
      const seenGoals = new Set<string>();
      let dependentDefenderGoalCount = 0;
      const firstDependentDefenderGoals: object[] = [];
      const spending = new Map<string, { weapons: number; manpower: number; fuel: number; lastTick: number; burdenSeconds: number }>();
      let lastSlowTick = world.time.slowTick;
      class AuditMetrics extends BenchmarkMetrics {
        recordDuration(name: string, ms: number) {
          super.recordDuration(name, ms);
          if (name === "warCampaign.evaluation") {
            for (const campaign of world.warCampaigns?.byNationId.values() ?? []) for (const goal of campaign.objectives) {
              const key = `${campaign.nationId}:${goal.warKey}`;
              if (seenGoals.has(key)) continue;
              seenGoals.add(key);
              const overlord = getSubjectOverlord(world, campaign.nationId);
              if (goal.kind !== "preserve-sovereignty" || !overlord) continue;
              dependentDefenderGoalCount++;
              if (firstDependentDefenderGoals.length < 20) firstDependentDefenderGoals.push({ tick: world.time.fastTick,
                nation: campaign.nationId, opponent: goal.opponentId, overlord, political: structuredClone(goal.political) });
            }
          }
          if (name === "repositionUnits") loss.before(world);
          if (name === "battle.update") {
            loss.after(world);
            for (const [id, entry] of world.warCampaigns?.battleCosts ?? []) {
              const old = ledgerSamples.get(id);
              const same = old?.entry === entry;
              const total = ledgerTotals.get(id) ?? { direct: 0, removed: 0, weapons: 0 };
              total.direct += entry.directManpowerDamage - (same ? old!.direct : 0);
              total.removed += entry.removedManpower - (same ? old!.removed : 0);
              total.weapons += entry.removedWeaponEquivalent - (same ? old!.weapons : 0);
              ledgerTotals.set(id, total);
              ledgerSamples.set(id, { entry, direct: entry.directManpowerDamage,
                removed: entry.removedManpower, weapons: entry.removedWeaponEquivalent });
            }
          }
        }
      }
      runSimulation(world, { ticks, metrics: new AuditMetrics(), observe(current: WorldState) {
        outcomes.observe(current);
        governments.observe(current);
        current.wars.forEach((war) => seenWars.add(war));
        for (const settlement of current.warNegotiations?.settlements ?? []) {
          settlements.set(`${settlement.a}:${settlement.b}:${settlement.atSlowTick}:${settlement.proposerId}`, settlement);
        }
        if (current.time.slowTick === lastSlowTick) return;
        const elapsed = current.time.slowTick - lastSlowTick;
        lastSlowTick = current.time.slowTick;
        for (const nation of current.nations) {
          const spent = spending.get(nation.id) ?? { weapons: 0, manpower: 0, fuel: 0, lastTick: -1, burdenSeconds: 0 };
          if (nation.resourceFlow.lastTick !== spent.lastTick) {
            spent.weapons += nation.resourceFlow.usage.weapons;
            spent.manpower += nation.resourceFlow.usage.manpower;
            spent.fuel += nation.resourceFlow.usage.fuel;
            spent.lastTick = nation.resourceFlow.lastTick;
          }
          if (nation.macroRegionIds.length) spent.burdenSeconds += (current.mobilization?.byNationId.get(nation.id)?.burden ?? 0) * elapsed;
          spending.set(nation.id, spent);
        }
      } });
      const totalDirectWarCasualties = Object.fromEntries(world.nations.map((nation) => [nation.id,
        [...seenWars].reduce((sum, war) => sum + getWarCasualties(war, nation.id), 0)]));
      results.push({ seed, scenario, startFingerprint, costs: loss.result(), totalDirectWarCasualties,
        openingGovernmentOutcomes: governments.result(),
        episodeGovernmentStates: governments.currentStates(world),
        dependentDefenderGoalCount, firstDependentDefenderGoals,
        warOutcomes: outcomes.result(), settlements: [...settlements.values()], endWorld: summarizeWorld(world),
        campaignLedger: Object.fromEntries(ledgerTotals),
        spending: Object.fromEntries(spending),
        openingWarSides: openingWars.flatMap((war) => [war.nationAId, war.nationBId].map((nationId) => ({
          nationId, opponentId: nationId === war.nationAId ? war.nationBId : war.nationAId,
          startedAtTick: war.startedAtFastTick, aggressor: nationId === war.aggressorId,
          directWarCasualties: getWarCasualties(war, nationId),
          alive: world.nations.find((nation) => nation.id === nationId)!.macroRegionIds.length > 0,
        }))) });
      await saveAuditProgress();
      console.log(`cost audit ${scenario} ${seed}: ${results.length}/${count * scenarios.length}`);
    }
  }
} finally { console.info = original; }
await saveAuditProgress();
console.log(JSON.stringify({ rows: results.length, revision: report.revision, campaign }));
