import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";

// Import the entire engine from its frozen checkout; never mix module versions.
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1];
};
const root = resolve(option("--engine-root", "."));
const load = (path: string) => import(pathToFileURL(resolve(root, path)).href);
const { createScenarioWorld } = await load("test/scenarios/index.ts");
const { runSimulation } = await load("test/helpers/simulation-driver.ts");
const { summarizeWorld } = await load("test/helpers/world-summary.ts");
const { updateWarCampaigns } = await load("src/sim/war-campaign/update.ts");
const repeats = Number(option("--repeats", "500"));
if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error("Invalid repeats");
const results: object[] = [];
const original = console.info;
console.info = () => undefined;
try {
  for (const scenario of ["stalemate-breaker", "reorganization-heavy", "two-island-amphibious"]) {
    for (const seed of [1022748319780, 1022748319781]) {
      const world = createScenarioWorld(scenario, { seed, quick: true, width: 640, height: 360,
        reserveEnabled: true, reorganizationEnabled: true, exploitationEnabled: true, pocketReductionEnabled: true,
        config: { systems: { warCampaignEnabled: false, diplomacyEnabled: true,
          mobilizationEnabled: true, researchEnabled: true, armsAidEnabled: true,
          tradeEnabled: true, politicalTurbulenceEnabled: true } } });
      world.wars.forEach((war: { isTest: boolean }) => { war.isTest = false; });
      runSimulation(world, { ticks: 500 });
      // Identical Legacy trajectory up to this point. Decisions are then replayed
      // with a frozen clock, forces, economy and battles, excluding world cost.
      delete world.instrumentation;
      const frozenWorld = summarizeWorld(world);
      world.settings.warCampaignEnabled = true;
      const firstAt = performance.now(); updateWarCampaigns(world);
      const adoptionMs = performance.now() - firstAt;
      for (let i = 0; i < 20; i++) updateWarCampaigns(world);
      const cpuAt = process.cpuUsage();
      const samples: number[] = [];
      for (let i = 0; i < repeats; i++) {
        const at = performance.now(); updateWarCampaigns(world); samples.push(performance.now() - at);
      }
      const cpu = process.cpuUsage(cpuAt);
      const sorted = [...samples].sort((a, b) => a - b);
      results.push({ scenario, seed, frozenWorld, adoptionMs, repeats,
        meanMs: samples.reduce((a, b) => a + b, 0) / repeats,
        medianMs: sorted[Math.floor(repeats / 2)], p95Ms: sorted[Math.ceil(repeats * 0.95) - 1],
        cpuMs: (cpu.user + cpu.system) / 1000, units: world.units.length,
        wars: world.wars.length, campaignNations: world.warCampaigns?.byNationId.size ?? 0 });
    }
  }
} finally { console.info = original; }
const report = { engineRoot: root, revision: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), results };
const output = option("--output", "diagnostics/war-ai-r2-decision-cost.json.gz");
const bytes = Buffer.from(JSON.stringify(report));
await writeFile(output, output.endsWith(".gz") ? gzipSync(bytes) : bytes);
console.log(JSON.stringify(results.map(({ scenario, seed, meanMs, ...rest }: any) => ({ scenario, seed, meanMs }))));
