import { writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { createScenarioWorld } from "../scenarios";
import { runSimulation } from "../helpers/simulation-driver";
import { withMutedSimulationLogs } from "../helpers/muted-logs";
import { getOwnerByMesoId } from "../../src/sim/world-cache";
import { getNationalTerritorialValue, getTerritorialValue } from "../../src/sim/territorial-value";
import type { BenchmarkScenarioName } from "../benchmark/types";

const scenarios: BenchmarkScenarioName[] = ["active-war", "matched-war", "stalemate-breaker", "reorganization-heavy", "two-island-amphibious"];
const results: object[] = [];
if (execFileSync("git", ["diff", "--", "src"], { encoding: "utf8" })) throw new Error("Commit simulation source first");
for (let i = 0; i < 20; i++) for (const scenario of scenarios) {
  results.push(withMutedSimulationLogs(() => audit(822748319780 + i, scenario)));
}
await writeFile("diagnostics/war-ai-r2-4-opening-values.json.gz", gzipSync(JSON.stringify({
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  note: "First real slow-tick adoption, not a changed evaluation seed or a forced political objective.", results,
})));
console.log(`opening values: ${results.length} episodes`);

function audit(seed: number, scenario: BenchmarkScenarioName) {
  const world = createScenarioWorld(scenario, { seed, width: 640, height: 360, quick: true,
    reserveEnabled: true, reorganizationEnabled: true, exploitationEnabled: true, pocketReductionEnabled: true,
    config: { systems: { warCampaignEnabled: true, diplomacyEnabled: true, mobilizationEnabled: true,
      researchEnabled: true, armsAidEnabled: true, tradeEnabled: true, politicalTurbulenceEnabled: true } },
  });
  world.wars.forEach((war) => { war.isTest = false; });
  const wars = [...world.wars];
  runSimulation(world, { ticks: 10 });
  const owners = getOwnerByMesoId(world);
  return { seed, scenario, goals: wars.flatMap((war) => {
    const nation = war.aggressorId;
    const plan = world.warCampaigns?.byNationId.get(nation);
    const goal = plan?.objectives.find((g) => g.opponentId === war.defenderId);
    if (!goal) return [];
    const enemy = world.nations.find((n) => n.id === goal.opponentId)!;
    const enemyLand = world.mesoRegions.filter((r) => owners.get(r.id) === enemy.id).map((r) => r.id);
    return [{ nation, opponent: enemy.id, cause: war.cause, regionIds: goal.regionIds,
      rationale: goal.rationale, purpose: goal.political, mode: plan!.mode,
      capitalTarget: goal.regionIds.includes(enemy.capitalMesoId), enemyRegions: enemyLand.length,
      targetRelativeValue: getTerritorialValue(world, nation, goal.regionIds) / getNationalTerritorialValue(world, nation),
      enemyRelativeValue: getTerritorialValue(world, nation, enemyLand) / getNationalTerritorialValue(world, nation),
      alternatives: plan!.alternatives }];
  }) };
}
