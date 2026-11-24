import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createDefaultWorldConfig, createWorldConfig } from "../../src/data/world-config";
import { createWorld } from "../../src/sim/create-world";
import { stepSimulationDay } from "../../src/sim/update";
import { assertWorldInvariants, semanticWorldSignature } from "../helpers/invariants";
import { withMutedSimulationLogs } from "../helpers/muted-logs";
import { createScenarioWorld } from "../scenarios";
import { createCampaignBaselineObserver } from "./campaign-baseline-observer";

const [scenario, seedText, tickText, mode, defeatMode = "default", trace] = process.argv.slice(2);
const seed = Number(seedText);
const ticks = Number(tickText);
assert(Number.isInteger(seed) && seed >= 822_748_319_780 && seed <= 822_748_319_799, "Use a campaign development seed");
assert(Number.isSafeInteger(ticks) && ticks > 0, "Specify a positive tick count");
assert(mode === "on" || mode === "off" || mode === "default", "Specify on, off, or default");
assert(global.gc, "Run Node with --expose-gc");
assert(trace === undefined || trace === "trace", "Specify trace to capture campaign observations");

const preset = scenario === "world-map" ? "world-map" : "japan-scale";
const defaults = createDefaultWorldConfig(preset);
assert(defeatMode === "default" || defeatMode === "legacy-defeat", "Specify default or legacy-defeat");
const systems = {
  ...defaults.systems,
  warCampaignEnabled: mode !== "off",
  defeatedFormationsEnabled: defeatMode === "legacy-defeat" ? false : defaults.systems?.defeatedFormationsEnabled,
};
const config = { ...defaults, seed, systems };
const quickConfig = {
  ...createWorldConfig(640, 360, 6000), seed, systems,
  mesoLandCenterRatio: 0.04, mesoSeaCenterRatio: 0.004,
  nationTargetMacroRegionsPerNation: 3, nationMacroRegionSizeRange: { min: 4, max: 8 },
};
const controlled = scenario === "unequal-war" || scenario === "economic-constraint" ||
  scenario === "stalemate-breaker" || scenario === "reorganization-heavy";
assert(controlled || scenario === "quick" || scenario === "world-map" || scenario === "japan-scale", "Unknown smoke scenario");
const world = controlled
  ? createScenarioWorld(scenario, { width: 640, height: 360, seed, quick: true, config: quickConfig })
  : createWorld(scenario === "quick" ? quickConfig : config);
if (controlled) world.wars.forEach((war) => { war.isTest = false; });
else assert.equal(world.wars.length, 0);
assert.equal(world.settings?.warCampaignEnabled, mode !== "off");
assert.equal(world.settings?.defeatedFormationsEnabled, defeatMode !== "legacy-defeat");

const initial = { nations: world.nations.length, units: world.units.length, districts: world.mesoRegions.length };
const hash = createHash("sha256");
const campaignHash = createHash("sha256");
const seenWars = new Set<string>();
const seenSettlements = new Set<object>();
let peakPlans = 0;
let peakUnits = world.units.length;
let peakTickMs = 0;
const baseline = trace ? createCampaignBaselineObserver() : undefined;

const encode = (value: unknown) => JSON.stringify(value, (_, entry) =>
  entry instanceof Map || entry instanceof Set ? [...entry] : entry === Infinity ? "Infinity" : entry);

function observe(): void {
  if (world.time.fastTick % 100 === 0 || world.time.fastTick === ticks) {
    assertWorldInvariants(world);
    const defeat = world.defeatedFormations;
    if (defeat) {
      const activeIds = new Set(world.units.map((unit) => unit.id));
      for (const id of defeat.withdrawals.keys()) assert(!activeIds.has(id), `${id} is still on the field during withdrawal`);
      let accounted = defeat.repatriatedManpower + defeat.displacedManpower;
      for (const group of defeat.prisoners.values()) accounted += group.manpower;
      assert(Math.abs(defeat.capturedManpower - accounted) < Math.max(1, accounted) * 1e-10);
    }
    assert((world.warCampaigns?.events.length ?? 0) <= 200);
    assert((world.warCampaigns?.goalHistory.length ?? 0) <= 100);
    assert((world.diplomacy?.claimOutcomeHistory?.length ?? 0) <= 100);
    for (const nation of world.nations) {
      for (const [resource, stock] of Object.entries(nation.resources)) {
        assert(stock >= -1e-8, `${nation.id}.${resource} has a negative stock`);
      }
    }
    hash.update(encode([semanticWorldSignature(world), world.warNegotiations, world.simRng]));
    campaignHash.update(encode([world.warCampaigns, world.diplomacy?.claimOutcomeHistory]));
  }
  for (const war of world.wars) seenWars.add(`${war.id}:${war.startedAtFastTick}`);
  const latestSettlement = world.warNegotiations?.settlements.at(-1);
  if (latestSettlement) seenSettlements.add(latestSettlement);
  peakPlans = Math.max(peakPlans, world.warCampaigns?.byNationId.size ?? 0);
  peakUnits = Math.max(peakUnits, world.units.length);
}

const mib = (bytes: number) => Math.round(bytes / 2 ** 20);
global.gc();
const initialHeap = mib(process.memoryUsage().heapUsed);
const start = process.cpuUsage();
withMutedSimulationLogs(() => {
  baseline?.observe(world);
  for (let index = 0; index < ticks; index++) {
    const tickStart = performance.now();
    stepSimulationDay(world);
    peakTickMs = Math.max(peakTickMs, performance.now() - tickStart);
    observe();
    baseline?.observe(world);
  }
});
const cpu = process.cpuUsage(start);
global.gc();
console.log(JSON.stringify({
  scenario, seed, ticks, mode, defeatMode, initial, wars: seenWars.size, activeWars: world.wars.length,
  negotiatedPeace: seenSettlements.size, claimsResolved: world.diplomacy?.claimOutcomeHistory?.length ?? 0,
  peakPlans, peakUnits, hash: hash.digest("hex"), campaignHash: campaignHash.digest("hex"),
  personnelHash: createHash("sha256").update(encode(world.defeatedFormations ?? null)).digest("hex"),
  defeat: world.defeatedFormations && {
    withdrawing: world.defeatedFormations.withdrawals.size,
    captured: Math.round(world.defeatedFormations.capturedManpower),
    recovered: Math.round(world.defeatedFormations.recoveredManpower),
    repatriated: Math.round(world.defeatedFormations.repatriatedManpower),
    missing: Math.round(world.defeatedFormations.missingManpower),
    displaced: Math.round(world.defeatedFormations.displacedManpower),
  },
  cpuMs: Math.round((cpu.user + cpu.system) / 1000), peakTickMs: Math.round(peakTickMs),
  initialHeapMiB: initialHeap, finalHeapMiB: mib(process.memoryUsage().heapUsed),
  maxRssMiB: process.resourceUsage().maxRSS / 1024,
  ...(baseline && { campaignBaseline: baseline.result() }),
}));
