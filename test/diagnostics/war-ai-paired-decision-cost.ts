import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { WorldState } from "../../src/sim/world-state";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1];
};
const roots = [resolve(option("--before", ".")), resolve(option("--after", ""))];
if (!args.includes("--after")) throw new Error("Supply --after checkout");
const repeats = Number(option("--repeats", "500"));
if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error("Invalid repeats");
const engines = await Promise.all(roots.map(async (root) => {
  if (execFileSync("git", ["-C", root, "diff", "--", "src"], { encoding: "utf8" })) throw new Error("Commit source first");
  const load = (path: string) => import(pathToFileURL(resolve(root, path)).href);
  return { root, revision: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    ...await load("test/scenarios/index.ts"), ...await load("test/helpers/simulation-driver.ts"),
    ...await load("src/sim/war-campaign/update.ts") };
}));
const results: object[] = [];
const info = console.info; console.info = () => undefined;
try {
  for (const scenario of ["stalemate-breaker", "reorganization-heavy", "two-island-amphibious"]) {
    for (const seed of [1022748319780, 1022748319781]) results.push(measure(scenario, seed));
  }
} finally { console.info = info; }
await writeFile(option("--output", "diagnostics/war-ai-paired-decision-cost.json.gz"), gzipSync(JSON.stringify({
  engines: engines.map(({ root, revision }) => ({ root, revision })), repeats,
  runtime: { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch },
  note: "Same-process alternating order; fixed clocks and matching physical/campaign fingerprints. Per-call samples are serially correlated, not independent evaluation seeds.", results,
})));
console.log(`paired decision cost: ${results.length} fixed worlds`);

function prepare(engine: typeof engines[number], scenario: string, seed: number): WorldState {
  const world: WorldState = engine.createScenarioWorld(scenario, { seed, quick: true, width: 640, height: 360,
    reserveEnabled: true, reorganizationEnabled: true, exploitationEnabled: true, pocketReductionEnabled: true,
    config: { systems: { warCampaignEnabled: false, diplomacyEnabled: true, mobilizationEnabled: true,
      researchEnabled: true, armsAidEnabled: true, tradeEnabled: true, politicalTurbulenceEnabled: true } } });
  world.wars.forEach((w) => { w.isTest = false; }); engine.runSimulation(world, { ticks: 500 });
  delete world.instrumentation;
  return world;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value, (_key, item) =>
    item instanceof Map ? [...item] : item instanceof Set ? [...item] : item)).digest("hex");
}

function measure(scenario: string, seed: number) {
  const worlds = engines.map((engine) => prepare(engine, scenario, seed));
  const physics = worlds.map((world) => fingerprint({ units: world.units, wars: world.wars, nations: world.nations,
    macroRegions: world.macroRegions, occupation: world.occupation, time: world.time }));
  if (physics[0] !== physics[1]) throw new Error("Physical inputs differ");
  worlds.forEach((world) => { world.settings!.warCampaignEnabled = true; });
  for (let i = 0; i < 200; i++) engines.forEach((engine, j) => engine.updateWarCampaigns(worlds[j]));
  const samples = [[], []] as { wallMs: number; cpuMs: number }[][];
  for (let i = 0; i < repeats; i++) for (const j of i % 2 ? [1, 0] : [0, 1]) {
    const cpuAt = process.cpuUsage(), at = performance.now();
    engines[j].updateWarCampaigns(worlds[j]);
    const wallMs = performance.now() - at, cpu = process.cpuUsage(cpuAt);
    samples[j].push({ wallMs, cpuMs: (cpu.user + cpu.system) / 1000 });
  }
  const campaignHashes = worlds.map((world) => fingerprint(world.warCampaigns));
  if (campaignHashes[0] !== campaignHashes[1]) throw new Error("Campaign decisions differ");
  const summary = samples.map((rows) => Object.fromEntries(["wallMs", "cpuMs"].map((key) => {
    const values = rows.map((row) => row[key as keyof typeof row]).sort((a, b) => a - b);
    return [key, { median: values[Math.floor(values.length / 2)], mean: values.reduce((a, b) => a + b, 0) / values.length,
      p95: values[Math.ceil(values.length * 0.95) - 1] }];
  })));
  return { scenario, seed, physicalFingerprint: physics[0], campaignFingerprint: campaignHashes[0],
    units: worlds[0].units.length, wars: worlds[0].wars.length, summary, samples };
}
