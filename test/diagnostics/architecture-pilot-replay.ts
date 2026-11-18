import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { WorldState } from "../../src/sim/world-state";

const [root, rawSeed] = process.argv.slice(2);
const seed = Number(rawSeed);
if (!root || ![822_748_319_780, 822_748_319_788, 822_748_319_799].includes(seed) || !global.gc) {
  throw new Error("Usage: node --expose-gc --import tsx test/diagnostics/architecture-pilot-replay.ts <engine-root> <pilot seed>");
}

const load = (file: string) => import(pathToFileURL(resolve(root, file)).href);
const { createSeededWorld } = await load("test/helpers/seeded-world.ts");
const { runSimulation } = await load("test/helpers/simulation-driver.ts");
const { withMutedSimulationLogs } = await load("test/helpers/muted-logs.ts");
const world: WorldState = createSeededWorld({
  seed, width: 640, height: 360, quick: true,
  config: { systems: {
    warCampaignEnabled: true, diplomacyEnabled: true, mobilizationEnabled: true,
    researchEnabled: true, tradeEnabled: true, armsAidEnabled: true, foodEnabled: true, politicalTurbulenceEnabled: true,
  } },
});
if (world.wars.length) throw new Error("The natural replay must start at peace");

const wars = new Set<string>();
const claims = new Set<string>();
const deferred = new Set<string>();
const electoral = new Set<string>();
const command = new Map<string, boolean>();
const outcomes = new Map<string, string>();
global.gc();
const startHeap = process.memoryUsage().heapUsed;
let peakHeap = startHeap, peakUnits = world.units.length;
const startCpu = process.cpuUsage();
withMutedSimulationLogs(() => runSimulation(world, {
  ticks: 10_000,
  observe(current: WorldState) {
    const tick = current.time.fastTick;
    if (tick % 10 !== 0) return;
    if (tick % 100 === 0) peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
    peakUnits = Math.max(peakUnits, current.units.length);
    for (const war of current.wars) {
      wars.add(`${war.nationAId}:${war.nationBId}:${war.startedAtFastTick}`);
    }
    for (const relation of current.diplomacy?.relations.values() ?? []) {
      const objective = relation.crisis?.claimObjective;
      if (objective) claims.add(`${objective.interestId}:${objective.openedAtTick}`);
      for (const record of relation.deferredClaims?.values() ?? []) {
        const key = `${record.interestId}:${record.firstAtTick}`;
        deferred.add(key);
        if (record.electoralPressure && record.score >= record.minimumScore - record.electoralPressure.scoreIncrease) {
          electoral.add(key);
        }
      }
    }
    for (const result of current.diplomacy?.claimOutcomeHistory ?? []) {
      const key = `${result.objective.interestId}:${result.objective.openedAtTick}`;
      claims.add(key);
      outcomes.set(key, result.outcome);
    }
    for (const operation of [...current.offensiveOperations.operations, ...current.offensiveOperations.history]) {
      if (operation.theaterLaunchDecision) {
        command.set(operation.id, operation.theaterLaunchDecision.outcome === "wait-for-assembly");
      }
    }
  },
}));
const cpu = process.cpuUsage(startCpu);
global.gc();
const endHeap = process.memoryUsage().heapUsed;
const mib = (bytes: number) => +(bytes / 2 ** 20).toFixed(1);
console.log(JSON.stringify({
  seed, cpuMs: Math.round((cpu.user + cpu.system) / 1000),
  startHeapMiB: mib(startHeap), peakHeapMiB: mib(peakHeap), endHeapMiB: mib(endHeap), peakUnits,
  warsObserved: wars.size, claims: claims.size, deferred: deferred.size, electoral: electoral.size,
  commandDecisions: command.size, assemblyWaits: [...command.values()].filter(Boolean).length,
  claimOutcomes: [...outcomes.values()].sort(),
}));
