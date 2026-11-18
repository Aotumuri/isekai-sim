import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { LandUnitLifecycleEvent } from "../../src/sim/instrumentation";
import { isNationRegionSupplied } from "../../src/sim/supply-assessment";
import { buildWarAdjacency, isAtWar } from "../../src/sim/war-state";
import { getMesoById, getOwnerByMesoId } from "../../src/sim/world-cache";
import type { WorldState } from "../../src/sim/world-state";
import { BenchmarkMetrics } from "../benchmark/metrics";
import { createWarOutcomeObserver } from "../benchmark/war-outcome-observer";
import { createCapitalFrontExecutionObserver } from "../helpers/capital-front-execution";
import { semanticWorldSignature } from "../helpers/invariants";
import { withMutedSimulationLogs } from "../helpers/muted-logs";
import { runSimulation } from "../helpers/simulation-driver";
import { createScenarioWorld } from "../scenarios";

const seed = Number(process.argv[2]);
const output = process.argv[3];
const mode = process.argv[4] ?? "--campaign";
if (!Number.isSafeInteger(seed) || seed < 822_748_319_780 || seed > 822_748_319_799 ||
    !output || !["--campaign", "--campaign-off"].includes(mode)) {
  throw new Error("Usage: node --import tsx test/diagnostics/war-ai-capital-front-execution.ts <R2 development seed> <report.json> [--campaign-off]");
}
const warCampaignEnabled = mode === "--campaign";

function observeCollapse(world: WorldState, event: Extract<LandUnitLifecycleEvent, { reason: "battle-removal" }>) {
  const { tick, unitId, nationId, regionId } = event;
  const owners = getOwnerByMesoId(world);
  const wars = buildWarAdjacency(world.wars);
  const threatened = new Set(world.battles.filter((battle) => battle.lastActiveFastTick === tick)
    .map((battle) => battle.mesoId));
  for (const unit of world.units) {
    if (unit.domain !== "land" || unit.org <= 0 || unit.manpower <= 0 || !isAtWar(nationId, unit.nationId, wars)) continue;
    threatened.add(unit.regionId);
    if (unit.moveToId) threatened.add(unit.moveToId);
  }
  const regions = getMesoById(world);
  const fallbackCandidates = (regions.get(regionId)?.neighbors ?? []).filter(({ id }) => {
    const candidate = regions.get(id);
    return candidate && candidate.type !== "sea" &&
      (world.occupation.mesoById.get(id) ?? owners.get(id)) === nationId &&
      !threatened.has(id) && isNationRegionSupplied(world, nationId, id);
  });
  return { tick, unitId, regionId, manpower: event.remainingManpower,
    retreat: world.retreatPlans.retreatIdByUnitId.get(unitId) ?? null,
    reorganization: world.reorganization.planIdByUnitId.get(unitId) ?? null,
    fallbackCandidates: fallbackCandidates.map(({ id }) => id).sort() };
}

function run(trace: boolean) {
  const world = createScenarioWorld("stalemate-breaker", {
    seed, quick: true, width: 640, height: 360,
    reserveEnabled: true, reorganizationEnabled: true, exploitationEnabled: true, pocketReductionEnabled: true,
    config: { systems: {
      warCampaignEnabled, diplomacyEnabled: true, mobilizationEnabled: true,
      researchEnabled: true, armsAidEnabled: true, tradeEnabled: true, politicalTurbulenceEnabled: true,
    } },
  });
  const [war] = world.wars;
  war.isTest = false;
  const defender = world.nations.find((nation) => nation.id === war.defenderId)!;
  const observer = trace && createCapitalFrontExecutionObserver(defender.id, defender.capitalMesoId);
  const collapses: ReturnType<typeof observeCollapse>[] = [];
  const metrics = new BenchmarkMetrics();
  if (observer) Object.assign(metrics, {
    recordLandUnitLifecycle(event: LandUnitLifecycleEvent) {
      observer.recordLandUnitLifecycle(event);
      if (event.nationId === defender.id && event.reason === "battle-removal" &&
          event.remainingOrganization === 0 && event.remainingManpower > 0) {
        collapses.push(observeCollapse(world, event));
      }
    },
  });
  const outcomes = createWarOutcomeObserver();
  const hash = createHash("sha256");
  let observerMs = 0;
  const startCpu = process.cpuUsage();
  withMutedSimulationLogs(() => runSimulation(world, {
    ticks: 600, metrics,
    observe(current) {
      if (observer) {
        const start = performance.now();
        observer.observe(current);
        observerMs += performance.now() - start;
      }
      outcomes.observe(current);
      hash.update(JSON.stringify([semanticWorldSignature(current), current.warCampaigns, current.simRng.fork().nextFloat()],
        (_key, value) => value instanceof Map || value instanceof Set ? [...value] : value));
    },
  }));
  const cpu = process.cpuUsage(startCpu);
  return { digest: hash.digest("hex"), outcomes: outcomes.result(), observation: observer ? observer.result() : null, collapses,
    observerMs, processCpuMs: (cpu.system + cpu.user) / 1000 };
}

const plain = run(false);
const observed = run(true);
const replay = run(true);
if (plain.digest !== observed.digest || observed.digest !== replay.digest ||
    JSON.stringify(plain.outcomes) !== JSON.stringify(observed.outcomes) ||
    JSON.stringify(observed.outcomes) !== JSON.stringify(replay.outcomes) ||
    JSON.stringify(observed.observation) !== JSON.stringify(replay.observation) ||
    JSON.stringify(observed.collapses) !== JSON.stringify(replay.collapses)) {
  throw new Error(`Observation or replay changed the trajectory: ${plain.digest} / ${observed.digest} / ${replay.digest}`);
}
const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
writeFileSync(output, JSON.stringify({ revision, seed, plain, observed, replayObserverMs: replay.observerMs }, null, 2));
console.log(JSON.stringify({ seed, digest: observed.digest, observerMs: observed.observerMs,
  samples: observed.observation?.samples, events: observed.observation?.events.length,
  omitted: observed.observation?.omittedEvents, ticksByState: observed.observation?.ticksByState,
  vacant: observed.observation?.threatenedVacantTicks }));
