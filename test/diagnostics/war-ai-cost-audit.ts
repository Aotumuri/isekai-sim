import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createFieldLossObserver } from "../helpers/field-loss-observer";
import type { WorldState } from "../../src/sim/world-state";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1];
};
const root = resolve(option("--engine-root", "."));
const load = (path: string) => import(pathToFileURL(resolve(root, path)).href);
const { createScenarioWorld } = await load("test/scenarios/index.ts");
const { runSimulation } = await load("test/helpers/simulation-driver.ts");
const { BenchmarkMetrics } = await load("test/benchmark/metrics.ts");
const { getWarCasualties } = await load("src/sim/war-state.ts");
const campaign = args.includes("--campaign");
const ticks = Number(option("--ticks", "1000"));
const count = Number(option("--seeds", "4"));
if (![ticks, count].every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error("Invalid integers");
const results: object[] = [];
const original = console.info;
console.info = () => undefined;
try {
  for (let i = 0; i < count; i++) {
    for (const scenario of ["matched-war", "stalemate-breaker", "reorganization-heavy", "two-island-amphibious"]) {
      const seed = 1022748319780 + i;
      const world: WorldState = createScenarioWorld(scenario, { seed, quick: true, width: 640, height: 360,
        reserveEnabled: true, reorganizationEnabled: true, exploitationEnabled: true, pocketReductionEnabled: true,
        config: { systems: { warCampaignEnabled: campaign, diplomacyEnabled: true, mobilizationEnabled: true,
          researchEnabled: true, armsAidEnabled: true, tradeEnabled: true, politicalTurbulenceEnabled: true } } });
      world.wars.forEach((war) => { war.isTest = false; });
      const openingWars = [...world.wars];
      const seenWars = new Set(world.wars);
      const startFingerprint = createHash("sha256").update(JSON.stringify({
        units: world.units, wars: world.wars, macroRegions: world.macroRegions,
        resources: world.nations.map((n) => [n.id, n.resources]),
      })).digest("hex");
      const loss = createFieldLossObserver();
      const spending = new Map<string, { weapons: number; manpower: number; fuel: number; lastTick: number; burdenSeconds: number }>();
      let lastSlowTick = world.time.slowTick;
      class AuditMetrics extends BenchmarkMetrics {
        recordDuration(name: string, ms: number) {
          super.recordDuration(name, ms);
          if (name === "repositionUnits") loss.before(world);
          if (name === "battle.update") loss.after(world);
        }
      }
      runSimulation(world, { ticks, metrics: new AuditMetrics(), observe(current: WorldState) {
        current.wars.forEach((war) => seenWars.add(war));
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
        spending: Object.fromEntries(spending),
        openingWarSides: openingWars.flatMap((war) => [war.nationAId, war.nationBId].map((nationId) => ({
          nationId, aggressor: nationId === war.aggressorId,
          directWarCasualties: getWarCasualties(war, nationId),
          alive: world.nations.find((nation) => nation.id === nationId)!.macroRegionIds.length > 0,
        }))) });
    }
  }
} finally { console.info = original; }
const report = { revision: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  engineRoot: root, campaign, ticks, seeds: count,
  note: "Field losses and totalDirectWarCasualties cover the whole episode; production flow excludes recovery, trade and aid. openingWarSides direct casualties cover opening wars only. Compare scopes explicitly.", results };
await writeFile(option("--output", "diagnostics/war-ai-r2-cost-audit.json.gz"), gzipSync(JSON.stringify(report)));
console.log(JSON.stringify({ rows: results.length, revision: report.revision, campaign }));
