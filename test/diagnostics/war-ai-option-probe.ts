import { writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { createScenarioWorld } from "../scenarios";
import { runSimulation } from "../helpers/simulation-driver";
import { withMutedSimulationLogs } from "../helpers/muted-logs";
import { BenchmarkMetrics } from "../benchmark/metrics";
import { getUnitCombatStrength } from "../../src/sim/unit-strength";
import { allFieldUnits } from "../../src/sim/mobilization";
import { updateWarCampaigns } from "../../src/sim/war-campaign/update";
import { campaignCostLimitReached, type CampaignMode } from "../../src/sim/war-campaign/policy";
import { getOwnerByMesoId } from "../../src/sim/world-cache";
import { getWarCasualties } from "../../src/sim/war-state";
import type { BenchmarkScenarioName } from "../benchmark/types";

// Diagnostic counterfactual, not a new production policy. Repeat identical
// openings and force one nation's abstract choice for a 30-second horizon.
// Other nations respond normally. Emergency and exhausted-budget overrides stay.
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1];
};
const count = Number(option("--seeds", "4"));
if (!Number.isSafeInteger(count) || count < 1) throw new Error("Invalid seeds");
const results: object[] = [];
if (execFileSync("git", ["diff", "--", "src"], { encoding: "utf8" })) throw new Error("Commit simulation source first");
for (let i = 0; i < count; i++) {
  for (const scenario of ["matched-war", "stalemate-breaker", "reorganization-heavy", "two-island-amphibious"] as BenchmarkScenarioName[]) {
    for (const mode of ["limited-offensive", "defend", "seek-peace"] as CampaignMode[]) {
      results.push(withMutedSimulationLogs(() => probe(1022748319780 + i, scenario, mode)));
    }
  }
  console.log(`option probe ${i + 1}/${count}`);
}
await writeFile(option("--output", "diagnostics/war-ai-r2-2-option-probe.json.gz"), gzipSync(JSON.stringify({
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  horizonTicks: 300, seeds: count, results,
})));

function probe(seed: number, scenario: BenchmarkScenarioName, mode: CampaignMode) {
  const world = createScenarioWorld(scenario, { seed, width: 640, height: 360, quick: true,
    reserveEnabled: true, reorganizationEnabled: true, exploitationEnabled: true, pocketReductionEnabled: true,
    config: { systems: { warCampaignEnabled: true, diplomacyEnabled: true, mobilizationEnabled: true,
      researchEnabled: true, armsAidEnabled: true, tradeEnabled: true, politicalTurbulenceEnabled: true } },
  });
  world.wars.forEach((war) => { war.isTest = false; });
  const war = world.wars[0], nation = world.nations.find((n) => n.id === war.aggressorId)!;
  updateWarCampaigns(world);
  const campaign = world.warCampaigns!.byNationId.get(nation.id)!;
  const forecast = campaign.alternatives;
  const goal = campaign.objectives.find((g) => g.opponentId === war.defenderId)!;
  const strength = () => allFieldUnits(world).filter((u) => u.domain === "land" && u.nationId === nation.id)
    .reduce((sum, u) => sum + getUnitCombatStrength(u), 0);
  const openingStrength = strength();
  let overrides = 0, emergencies = 0, ticksAtWar = 0, lastTick = 0;
  const postures: Record<string, number> = {};
  class ProbeMetrics extends BenchmarkMetrics {
    override recordDuration(name: string, ms: number) {
      super.recordDuration(name, ms);
      if (name !== "warCampaign.evaluation") return;
      const plan = world.warCampaigns?.byNationId.get(nation.id);
      if (!plan) return;
      if (plan.constraints.capitalCritical || campaignCostLimitReached(plan.constraints)) { emergencies++; return; }
      if (plan.mode !== mode || plan.primaryOpponentId !== war.defenderId) {
        plan.mode = mode; plan.primaryOpponentId = war.defenderId;
        plan.revision++; world.warCampaigns!.version++; overrides++;
      }
    }
  }
  runSimulation(world, { ticks: 300, metrics: new ProbeMetrics(), observe(current) {
    if (current.time.fastTick > 0 && current.wars.includes(war)) ticksAtWar++;
    if (lastTick === current.time.slowTick) return;
    lastTick = current.time.slowTick;
    for (const plan of current.frontPlans.plansByNationId.get(nation.id) ?? []) {
      postures[plan.posture] = (postures[plan.posture] ?? 0) + 1;
    }
  } });
  const owners = getOwnerByMesoId(world);
  return { seed, scenario, mode, nationId: nation.id, forecast, openingStrength,
    strength: strength(), casualties: getWarCasualties(war, nation.id), overrides, emergencies, ticksAtWar, postures,
    objectiveMilitaryHeld: goal.regionIds.every((id) => (world.occupation.mesoById.get(id) ?? owners.get(id)) === nation.id),
    objectiveLegallyOwned: goal.regionIds.every((id) => owners.get(id) === nation.id),
    weapons: nation.resources.weapons, manpower: nation.resources.manpower,
    survived: nation.macroRegionIds.length > 0 };
}
