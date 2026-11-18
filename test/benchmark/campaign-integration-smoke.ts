import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createDefaultWorldConfig, createWorldConfig } from "../../src/data/world-config";
import { createWorld } from "../../src/sim/create-world";
import { FAST_TICK_MS, SLOW_TICK_MS } from "../../src/sim/time";
import { stepFastTick, stepSlowTick } from "../../src/sim/update";
import { assertWorldInvariants, semanticWorldSignature } from "../helpers/invariants";
import { withMutedSimulationLogs } from "../helpers/muted-logs";
import { createScenarioWorld } from "../scenarios";

const [scenario, seedText, tickText, mode] = process.argv.slice(2);
const seed = Number(seedText);
const ticks = Number(tickText);
assert(Number.isInteger(seed) && seed >= 822_748_319_780 && seed <= 822_748_319_799, "Use a campaign development seed");
assert(Number.isSafeInteger(ticks) && ticks > 0, "Specify a positive tick count");
assert(mode === "on" || mode === "off" || mode === "default", "Specify on, off, or default");
assert(global.gc, "Run Node with --expose-gc");

const preset = scenario === "world-map" ? "world-map" : "japan-scale";
const defaults = createDefaultWorldConfig(preset);
const systems = mode === "default" ? defaults.systems : { ...defaults.systems, warCampaignEnabled: mode === "on" };
const config = { ...defaults, seed, systems };
const quickConfig = {
  ...createWorldConfig(640, 360, 6000), seed, systems,
  mesoLandCenterRatio: 0.04, mesoSeaCenterRatio: 0.004,
  nationTargetMacroRegionsPerNation: 3, nationMacroRegionSizeRange: { min: 4, max: 8 },
};
const controlled = scenario === "unequal-war" || scenario === "economic-constraint";
assert(controlled || scenario === "quick" || scenario === "world-map" || scenario === "japan-scale", "Unknown smoke scenario");
const world = controlled
  ? createScenarioWorld(scenario, { width: 640, height: 360, seed, quick: true, config: quickConfig })
  : createWorld(scenario === "quick" ? quickConfig : config);
if (controlled) world.wars.forEach((war) => { war.isTest = false; });
else assert.equal(world.wars.length, 0);
assert.equal(world.settings?.warCampaignEnabled, mode !== "off");

const initial = { nations: world.nations.length, units: world.units.length, districts: world.mesoRegions.length };
const hash = createHash("sha256");
const campaignHash = createHash("sha256");
const seenWars = new Set<string>();
const seenSettlements = new Set<object>();
let peakPlans = 0;
let peakUnits = world.units.length;
let peakTickMs = 0;

const encode = (value: unknown) => JSON.stringify(value, (_, entry) =>
  entry instanceof Map || entry instanceof Set ? [...entry] : entry === Infinity ? "Infinity" : entry);

function observe(): void {
  if (world.time.fastTick % 100 === 0 || world.time.fastTick === ticks) {
    assertWorldInvariants(world);
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
  for (let index = 0; index < ticks; index++) {
    const tickStart = performance.now();
    stepFastTick(world, FAST_TICK_MS);
    while (world.time.slowTick < Math.floor(world.time.elapsedMs / SLOW_TICK_MS)) stepSlowTick(world, SLOW_TICK_MS);
    peakTickMs = Math.max(peakTickMs, performance.now() - tickStart);
    observe();
  }
});
const cpu = process.cpuUsage(start);
global.gc();
console.log(JSON.stringify({
  scenario, seed, ticks, mode, initial, wars: seenWars.size, activeWars: world.wars.length,
  negotiatedPeace: seenSettlements.size, claimsResolved: world.diplomacy?.claimOutcomeHistory?.length ?? 0,
  peakPlans, peakUnits, hash: hash.digest("hex"), campaignHash: campaignHash.digest("hex"),
  cpuMs: Math.round((cpu.user + cpu.system) / 1000), peakTickMs: Math.round(peakTickMs),
  initialHeapMiB: initialHeap, finalHeapMiB: mib(process.memoryUsage().heapUsed),
}));
