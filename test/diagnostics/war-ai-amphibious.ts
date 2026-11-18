import { writeFile, rename } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createScenarioWorld } from "../scenarios";
import { runSimulation } from "../helpers/simulation-driver";
import { withMutedSimulationLogs } from "../helpers/muted-logs";
import { setAmphibiousDiagnosticObserver, type AmphibiousLaunchFeasibilityDiagnostic } from "../../src/sim/amphibious";
import type { BenchmarkScenarioName } from "../benchmark/types";

// Observe the production forecast unchanged. Rejected alternatives are NOT
// labelled false negatives: their counterfactual landings were never simulated.
const args = process.argv.slice(2);
function option(name: string, fallback: string) {
  const at = args.indexOf(name);
  return at < 0 ? fallback : args[at + 1] ?? "";
}
const seeds = Number(option("--seeds", "20"));
const ticks = Number(option("--ticks", "10000"));
if (![seeds, ticks].every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error("Positive integers required");
const output = option("--output", "diagnostics/war-ai-amphibious-v5.json");
const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (execFileSync("git", ["diff", "--", "src"], { encoding: "utf8" })) throw new Error("Commit simulation source first");
interface Attempt {
  demandId: string; tick: number; forecast: AmphibiousLaunchFeasibilityDiagnostic;
  warKey: string | null; observedEndTick: number | null;
  created: boolean; launchedAt: number | null; landedAt: number | null;
  outcome: string | null; cancellation: string | null;
}
const results: ReturnType<typeof run>[] = [];
for (let index = 0; index < seeds; index++) {
  for (const scenario of ["active-war", "two-island-amphibious"] as BenchmarkScenarioName[]) {
    for (const normal of [false, true]) {
      for (const campaign of index % 2 ? [true, false] : [false, true]) {
        results.push(withMutedSimulationLogs(() => run(822_748_319_780 + index, scenario, normal, campaign)));
        await writeFile(`${output}.tmp`, JSON.stringify({ revision, seeds, ticks,
          note: "War survival is factual in the observed world, not a counterfactual invasion success label. Null end is right-censored.", results }, null, 2));
        await rename(`${output}.tmp`, output);
      }
    }
  }
  console.log(`amphibious forecast seed ${index + 1}/${seeds}`);
}

function run(seed: number, scenario: BenchmarkScenarioName, normal: boolean, campaign: boolean) {
  const world = createScenarioWorld(scenario, { seed, width: 640, height: 360, quick: true,
    reserveEnabled: true, reorganizationEnabled: true, exploitationEnabled: true, pocketReductionEnabled: true });
  Object.assign(world.settings!, { diplomacyEnabled: normal, mobilizationEnabled: normal,
    researchEnabled: normal, armsAidEnabled: normal, tradeEnabled: normal,
    politicalTurbulenceEnabled: normal, warCampaignEnabled: campaign });
  if (normal) world.wars.forEach((war) => { war.isTest = false; });
  const attempts: Attempt[] = [];
  let operationVersion = -1;
  const live = new Set<string>();
  const endTicks = new Map<string, number>();
  const key = (war: WorldWar) => `${war.id}:${war.startedAtFastTick}`;
  type WorldWar = typeof world.wars[number];
  setAmphibiousDiagnosticObserver({
    onOperationConnection(event) {
      if (event.stage !== "operation-creation" || !event.launchFeasibility) return;
      const demand = world.amphibiousOperations.capabilityDemands.find((item) => item.id === event.demandId);
      const war = demand && world.wars.find((item) =>
        [item.nationAId, item.nationBId].includes(demand.nationId) &&
        [item.nationAId, item.nationBId].includes(demand.enemyNationId));
      attempts.push({ demandId: event.demandId, tick: event.tick, forecast: event.launchFeasibility,
        warKey: war ? key(war) : null, observedEndTick: null, created: false,
        launchedAt: null, landedAt: null, outcome: null, cancellation: null });
    },
  });
  try {
    runSimulation(world, { ticks, observe(current) {
      const next = new Set(current.wars.map(key));
      for (const id of live) if (!next.has(id)) endTicks.set(id, current.time.fastTick);
      live.clear();
      next.forEach((id) => live.add(id));
      if (operationVersion === current.amphibiousOperations.version) return;
      operationVersion = current.amphibiousOperations.version;
      const byAttempt = new Map(current.amphibiousOperations.operations.map((item) =>
        [`${item.capabilityDemandId}:${item.preparationLeaseStartedAtTick}`, item]));
      for (const attempt of attempts) {
        const operation = byAttempt.get(`${attempt.demandId}:${attempt.tick}`);
        if (!operation) continue;
        attempt.created = true;
        attempt.launchedAt ??= operation.launchedAtTick;
        if (operation.phase === "landed") attempt.landedAt ??= operation.completedAtTick;
        attempt.outcome = operation.beachheadOutcome;
        attempt.cancellation ??= operation.cancellationReason;
      }
    } });
  } finally { setAmphibiousDiagnosticObserver(null); }
  for (const attempt of attempts) attempt.observedEndTick = endTicks.get(attempt.warKey ?? "") ?? null;
  return { seed, scenario, normal, campaign, settings: world.settings, attempts,
    lifecycle: { opportunities: world.amphibiousOperations.opportunities,
      created: world.amphibiousOperations.operations.length, launched: world.amphibiousOperations.launchedOperations,
      landed: world.amphibiousOperations.completedLandings, failed: world.amphibiousOperations.failedLandings,
      endedWars: endTicks.size, ongoingWars: world.wars.length } };
}
