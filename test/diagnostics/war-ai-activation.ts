import { writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { createScenarioWorld } from "../scenarios";
import { runSimulation } from "../helpers/simulation-driver";
import { withMutedSimulationLogs } from "../helpers/muted-logs";
import { getOpposingFrontSide, getFrontSide } from "../../src/sim/land-fronts";
import type { BenchmarkScenarioName } from "../benchmark/types";

if (execFileSync("git", ["diff", "--", "src"], { encoding: "utf8" })) throw new Error("Commit simulation source first");
const results: object[] = [];
for (let i = 0; i < 4; i++) for (const scenario of ["active-war", "matched-war", "stalemate-breaker", "reorganization-heavy"] as BenchmarkScenarioName[]) {
  results.push(withMutedSimulationLogs(() => audit(1022748319780 + i, scenario)));
}
await writeFile("diagnostics/war-ai-r2-5-activation.json.gz", gzipSync(JSON.stringify({
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), ticks: 1000, results,
})));
console.log(`activation audit: ${results.length} episodes`);

function audit(seed: number, scenario: BenchmarkScenarioName) {
  const world = createScenarioWorld(scenario, { seed, width: 640, height: 360, quick: true,
    reserveEnabled: true, reorganizationEnabled: true, exploitationEnabled: true, pocketReductionEnabled: true,
    config: { systems: { warCampaignEnabled: true, diplomacyEnabled: true, mobilizationEnabled: true,
      researchEnabled: true, armsAidEnabled: true, tradeEnabled: true, politicalTurbulenceEnabled: true } },
  });
  world.wars.forEach((war) => { war.isTest = false; });
  let lastSlow = -1, offensiveNationSamples = 0, allHoldWithoutCommitment = 0;
  const examples: object[] = [];
  runSimulation(world, { ticks: 1000, observe(current) {
    if (lastSlow === current.time.slowTick) return;
    lastSlow = current.time.slowTick;
    for (const campaign of current.warCampaigns?.byNationId.values() ?? []) {
      if (campaign.mode !== "limited-offensive" || campaign.constraints.capitalCritical) continue;
      const plans = (current.frontPlans.plansByNationId.get(campaign.nationId) ?? []).filter((plan) => {
        const sector = current.landFronts.operationalSectorsById.get(plan.frontId);
        return sector && getOpposingFrontSide(sector, campaign.nationId)?.nationId === campaign.primaryOpponentId;
      });
      if (!plans.length) continue;
      offensiveNationSamples++;
      const active = current.offensiveOperations.operations.some((op) => op.nationId === campaign.nationId &&
        op.enemyNationId === campaign.primaryOpponentId && op.phase !== "recovering");
      const unmet = campaign.objectives.some((goal) => goal.opponentId === campaign.primaryOpponentId && !goal.achieved);
      if (!active && unmet && plans.every((p) => p.posture === "hold")) {
        allHoldWithoutCommitment++;
        if (examples.length < 30) examples.push({ tick: current.time.fastTick, campaign,
          plans: plans.map((plan) => {
            const sector = current.landFronts.operationalSectorsById.get(plan.frontId)!;
            return { ...plan, localFriendly: getFrontSide(sector, campaign.nationId)?.strength,
              localEnemy: getOpposingFrontSide(sector, campaign.nationId)?.strength,
              allocated: current.frontAllocations.allocationsByFrontNation.get(`${plan.frontId}::${campaign.nationId}`)?.allocatedStrength };
          }), allPlans: current.frontPlans.plansByNationId.get(campaign.nationId) });
      }
    }
  } });
  return { seed, scenario, offensiveNationSamples, allHoldWithoutCommitment, examples };
}
