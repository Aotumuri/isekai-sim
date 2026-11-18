import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createWarOutcomeObserver } from "../benchmark/war-outcome-observer";
import { createCapitalFrontExecutionObserver } from "../helpers/capital-front-execution";
import { semanticWorldSignature } from "../helpers/invariants";
import { withMutedSimulationLogs } from "../helpers/muted-logs";
import { runSimulation } from "../helpers/simulation-driver";
import { createScenarioWorld } from "../scenarios";

const seed = Number(process.argv[2]);
const output = process.argv[3];
if (!Number.isSafeInteger(seed) || seed < 822_748_319_780 || seed > 822_748_319_799 || !output) {
  throw new Error("Usage: node --import tsx test/diagnostics/war-ai-capital-front-execution.ts <R2 development seed> <report.json>");
}

function run(trace: boolean) {
  const world = createScenarioWorld("stalemate-breaker", {
    seed, quick: true, width: 640, height: 360,
    reserveEnabled: true, reorganizationEnabled: true, exploitationEnabled: true, pocketReductionEnabled: true,
    config: { systems: {
      warCampaignEnabled: true, diplomacyEnabled: true, mobilizationEnabled: true,
      researchEnabled: true, armsAidEnabled: true, tradeEnabled: true, politicalTurbulenceEnabled: true,
    } },
  });
  const [war] = world.wars;
  war.isTest = false;
  const defender = world.nations.find((nation) => nation.id === war.defenderId)!;
  const observer = trace && createCapitalFrontExecutionObserver(defender.id, defender.capitalMesoId);
  const outcomes = createWarOutcomeObserver();
  const hash = createHash("sha256");
  let observerMs = 0;
  const startCpu = process.cpuUsage();
  withMutedSimulationLogs(() => runSimulation(world, {
    ticks: 600,
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
  return { digest: hash.digest("hex"), outcomes: outcomes.result(), observation: observer ? observer.result() : null,
    observerMs, processCpuMs: (cpu.system + cpu.user) / 1000 };
}

const plain = run(false);
const observed = run(true);
const replay = run(true);
if (plain.digest !== observed.digest || observed.digest !== replay.digest ||
    JSON.stringify(plain.outcomes) !== JSON.stringify(observed.outcomes) ||
    JSON.stringify(observed.outcomes) !== JSON.stringify(replay.outcomes) ||
    JSON.stringify(observed.observation) !== JSON.stringify(replay.observation)) {
  throw new Error(`Observation or replay changed the trajectory: ${plain.digest} / ${observed.digest} / ${replay.digest}`);
}
const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
writeFileSync(output, JSON.stringify({ revision, seed, plain, observed, replayObserverMs: replay.observerMs }, null, 2));
console.log(JSON.stringify({ seed, digest: observed.digest, observerMs: observed.observerMs,
  samples: observed.observation?.samples, events: observed.observation?.events.length,
  omitted: observed.observation?.omittedEvents, ticksByState: observed.observation?.ticksByState,
  vacant: observed.observation?.threatenedVacantTicks }));
