import { writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { createScenarioWorld } from "../scenarios";
import { runSimulation } from "../helpers/simulation-driver";
import { withMutedSimulationLogs } from "../helpers/muted-logs";
import { BenchmarkMetrics } from "../benchmark/metrics";
import { getUnitCombatStrength } from "../../src/sim/unit-strength";
import { getMoveMsPerRegion } from "../../src/sim/movement";
import { getOwnerByMesoId } from "../../src/sim/world-cache";
import { getOpposingFrontSide } from "../../src/sim/land-fronts";
import type { WorldState } from "../../src/sim/world-state";
import type { CampaignObjective, WarCampaign } from "../../src/sim/war-campaign/state";
import type { BenchmarkScenarioName } from "../benchmark/types";

// Read-only audit at the exact forecasting stage. Reconstruct the current
// 30-second land projection independently; do not issue or override orders.
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1];
};
const ticks = Number(option("--ticks", "1000"));
const seeds = Number(option("--seeds", "4"));
if (![ticks, seeds].every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error("Invalid count");
if (execFileSync("git", ["diff", "--", "src"], { encoding: "utf8" })) throw new Error("Commit simulation source first");
const results: object[] = [];
for (let i = 0; i < seeds; i++) {
  for (const scenario of ["active-war", "matched-war", "stalemate-breaker", "reorganization-heavy"] as BenchmarkScenarioName[]) {
    results.push(withMutedSimulationLogs(() => audit(1022748319780 + i, scenario)));
  }
}
await writeFile(option("--output", "diagnostics/war-ai-r2-8-force-availability.json.gz"), gzipSync(JSON.stringify({
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), ticks, seeds, results,
})));
console.log(`force availability audit: ${results.length} episodes`);

function audit(seed: number, scenario: BenchmarkScenarioName) {
  const world = createScenarioWorld(scenario, { seed, width: 640, height: 360, quick: true,
    reserveEnabled: true, reorganizationEnabled: true, exploitationEnabled: true, pocketReductionEnabled: true,
    config: { systems: { warCampaignEnabled: true, diplomacyEnabled: true, mobilizationEnabled: true,
      researchEnabled: true, armsAidEnabled: true, tradeEnabled: true, politicalTurbulenceEnabled: true } },
  });
  world.wars.forEach((war) => { war.isTest = false; });
  const samples: ReturnType<typeof sampleGoal>[] = [];
  class AuditMetrics extends BenchmarkMetrics {
    override recordDuration(name: string, ms: number) {
      super.recordDuration(name, ms);
      if (name !== "warCampaign.evaluation") return;
      for (const campaign of world.warCampaigns?.byNationId.values() ?? []) {
        for (const goal of campaign.objectives) samples.push(sampleGoal(world, campaign, goal));
      }
    }
  }
  runSimulation(world, { ticks, metrics: new AuditMetrics() });
  return { seed, scenario, samples };
}

function sampleGoal(world: WorldState, campaign: WarCampaign, goal: CampaignObjective) {
  const distances = goalDistances(world, campaign, goal);
  const ownUnits = world.units.filter((u) => u.domain === "land" && u.nationId === campaign.nationId);
  const projected = ownUnits.filter((u) =>
    (distances.get(u.regionId) ?? Infinity) * getMoveMsPerRegion(u) / 1000 < 30 &&
    !world.retreatPlans.retreatIdByUnitId.has(u.id) && !world.reorganization.planIdByUnitId.has(u.id));
  const unavailable: Record<string, number> = {};
  for (const unit of projected) {
    const operationId = world.offensiveOperations.operationIdByUnitId.get(unit.id);
    const operation = operationId && world.offensiveOperations.operations.find((op) => op.id === operationId);
    const frontId = world.frontAllocations.frontIdByUnitId.get(unit.id);
    const front = frontId && world.landFronts.operationalSectorsById.get(frontId);
    const otherFront = front && getOpposingFrontSide(front, unit.nationId)?.nationId !== goal.opponentId;
    // Reasons are exclusive for accounting. Front assignment alone is not a
    // permanent lease, so report that exposure separately from hard exclusions.
    const reason = world.playerNation?.landOrders.has(unit.id) ? "manual"
      : world.amphibiousOperations.operationByUnitId.has(unit.id) ||
        world.amphibiousOperations.capabilityDemandByUnitId.has(unit.id) ? "amphibious"
      : world.strategicReserves.reserveNationByUnitId.has(unit.id) ? "reserve"
      : operation && operation.enemyNationId !== goal.opponentId ? "otherOperation"
      : otherFront ? "otherFront" : undefined;
    if (reason) unavailable[reason] = (unavailable[reason] ?? 0) + getUnitCombatStrength(unit);
  }
  const owners = getOwnerByMesoId(world);
  const hostileOccupation: Record<string, number> = {};
  for (const region of world.mesoRegions) {
    const occupant = world.occupation.mesoById.get(region.id);
    if (owners.get(region.id) !== campaign.nationId || !occupant || occupant === campaign.nationId) continue;
    hostileOccupation[occupant] = (hostileOccupation[occupant] ?? 0) + 1;
  }
  return { tick: world.time.fastTick, nation: campaign.nationId, opponent: goal.opponentId,
    primary: campaign.primaryOpponentId, mode: campaign.mode,
    militaryMode: campaign.militaryMode, capitalCritical: campaign.constraints.capitalCritical,
    opponents: campaign.objectives.length, hostileOccupation,
    projectedStrength: projected.reduce((sum, u) => sum + getUnitCombatStrength(u), 0), unavailable,
    otherFrontFloor: world.frontlineCoverage.coverages.filter((coverage) => {
      const front = world.landFronts.operationalSectorsById.get(coverage.sectorId);
      return coverage.nationId === campaign.nationId && front &&
        getOpposingFrontSide(front, campaign.nationId)?.nationId !== goal.opponentId;
    })
      .reduce((sum, coverage) => sum + coverage.minimumRequiredStrength, 0),
  };
}

function goalDistances(world: WorldState, campaign: WarCampaign, goal: CampaignObjective) {
  const owners = getOwnerByMesoId(world);
  const regions = new Map(world.mesoRegions.map((r) => [r.id, r]));
  const distance = new Map(goal.regionIds.map((id) => [id, 0]));
  const queue = [...goal.regionIds];
  for (let i = 0; i < queue.length; i++) for (const next of regions.get(queue[i])?.neighbors ?? []) {
    if (regions.get(next.id)?.type === "sea" || distance.has(next.id) ||
      owners.get(next.id) !== campaign.nationId && owners.get(next.id) !== goal.opponentId) continue;
    distance.set(next.id, distance.get(queue[i])! + 1); queue.push(next.id);
  }
  return distance;
}
