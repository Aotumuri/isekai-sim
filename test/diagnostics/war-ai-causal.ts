import { writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { createScenarioWorld } from "../scenarios";
import { runSimulation } from "../helpers/simulation-driver";
import { withMutedSimulationLogs } from "../helpers/muted-logs";
import { summarizeWorld } from "../helpers/world-summary";
import { BenchmarkMetrics } from "../benchmark/metrics";
import type { BenchmarkScenarioName } from "../benchmark/types";
import type { WorldState } from "../../src/sim/world-state";
import type { UnitState } from "../../src/sim/unit";

// Read-only causal trace: no lazy game getters, commands or random calls.
const args = process.argv.slice(2);
function option(name: string, fallback: string): string {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1] ?? "";
}
const ticks = Number(option("--ticks", "10000"));
const seed = Number(option("--seed", "822748319784"));
const scenario = option("--scenario", "stalemate-breaker") as BenchmarkScenarioName;
const campaign = args.includes("--campaign");
if (![ticks, seed].every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error("Invalid integers");
const world = withMutedSimulationLogs(() => createScenarioWorld(scenario, {
  seed, width: 640, height: 360, quick: true, reserveEnabled: true,
  reorganizationEnabled: true, exploitationEnabled: true, pocketReductionEnabled: true,
  config: { systems: { warCampaignEnabled: campaign, diplomacyEnabled: true,
    mobilizationEnabled: true, researchEnabled: true, armsAidEnabled: true,
    tradeEnabled: true, politicalTurbulenceEnabled: true } },
}));
world.wars.forEach((war) => { war.isTest = false; });
const events: object[] = [];
const counts: Record<string, number> = {};
function count(key: string, amount = 1) { counts[key] = (counts[key] ?? 0) + amount; }
function context(unit: UnitState) {
  return {
    region: unit.regionId, from: unit.moveFromId, to: unit.moveToId,
    progress: unit.moveProgressMs, target: unit.moveTargetId,
    front: world.frontAllocations.frontIdByUnitId.get(unit.id),
    reserve: world.strategicReserves.reserveNationByUnitId.get(unit.id),
    recovery: world.reorganization.planIdByUnitId.get(unit.id),
    retreat: world.retreatPlans.retreatIdByUnitId.get(unit.id),
    operation: world.offensiveOperations.operationIdByUnitId.get(unit.id),
    campaign: world.warCampaigns?.byNationId.get(unit.nationId)?.revision,
    occupation: world.occupation.version, territory: world.territoryVersion,
  };
}
let movement = new Map<string, ReturnType<typeof context>>();
function observeMovement(current: WorldState) {
  const next = new Map<string, ReturnType<typeof context>>();
  for (const unit of current.units) {
    if (unit.domain !== "land") continue;
    const before = movement.get(unit.id);
    const after = context(unit);
    next.set(unit.id, after);
    // A completed edge has region == old destination. Count only lost progress
    // on an edge interrupted before arrival, not ordinary target changes.
    if (!before?.to || before.progress <= 0 || after.region !== before.region ||
      after.region === before.to || before.to === after.to && after.progress >= before.progress) continue;
    count("interruptedEdges");
    count("discardedProgressMs", before.progress);
    count(before.to === after.to && before.target !== after.target
      ? "sameEdgeRetargetResets" : before.to === after.to && before.target === after.target
        ? "sameOrderResetsPossiblyBlocked" : "changedEdgeResets");
    const causes = ["front", "reserve", "recovery", "retreat", "operation", "campaign", "occupation", "territory"]
      .filter((key) => before[key as keyof typeof before] !== after[key as keyof typeof after]);
    for (const cause of causes) count(`interruptionContext.${cause}`);
    events.push({ type: "interrupted-edge", tick: current.time.fastTick, unit: unit.id,
      nation: unit.nationId, causes, before, after });
  }
  movement = next;
}
type Geometry = WorldState["frontAllocations"]["frontGeometryById"];
let assignments = new Map<string, string>();
let geometry: Geometry = new Map();
let plans = "";
function mappedFront(old: string): string {
  if (world.landFronts.operationalSectorsById.has(old as never)) return old;
  const previous = geometry.get(old as never);
  if (!previous) return old;
  const candidates = world.landFronts.operationalSectors.filter((f) =>
    f.nationAId === previous.nationAId && f.nationBId === previous.nationBId);
  const ranked = candidates.map((f) => ({ id: f.id, overlap: [...new Set([
    ...f.sideA.borderRegionIds, ...f.sideB.borderRegionIds,
    ...f.sideA.influenceRegionIds, ...f.sideB.influenceRegionIds,
  ])].filter((id) => previous.regionIds.has(id)).length }))
    .sort((a, b) => b.overlap - a.overlap || a.id.localeCompare(b.id));
  return ranked[0]?.overlap > 0 || candidates.length === 1 ? ranked[0].id : old;
}
function observeAllocations() {
  const state = world.frontAllocations;
  const nextPlans = JSON.stringify(world.frontPlans.plans.map((p) => ({
    front: p.frontId, nation: p.nationId, posture: p.posture,
    priority: p.priority, desired: p.desiredStrength, reasons: p.reasonFlags,
  })));
  const changes: object[] = [];
  let transfers = 0;
  for (const [id, front] of state.frontIdByUnitId) {
    const old = assignments.get(id);
    if (!old || mappedFront(old) === front) continue;
    transfers++;
    const unit = world.units.find((u) => u.id === id);
    changes.push({ unit: id, old, mapped: mappedFront(old), front,
      context: unit && context(unit) });
    count(world.landFronts.operationalSectorsById.has(mappedFront(old) as never)
      ? "transferBetweenLiveFronts" : "transferFromDisappearedFront");
  }
  if (transfers !== state.lastFrontTransferCount) throw new Error(`Transfer mismatch ${transfers}/${state.lastFrontTransferCount}`);
  if (transfers) events.push({ type: "allocation", tick: world.time.fastTick,
    transfers, plansChanged: plans !== nextPlans, plans: JSON.parse(nextPlans), changes });
  count("frontTransfers", transfers);
  assignments = new Map(state.frontIdByUnitId);
  geometry = new Map(state.frontGeometryById);
  plans = nextPlans;
}
class CausalMetrics extends BenchmarkMetrics {
  override recordDuration(name: string, ms: number) {
    super.recordDuration(name, ms);
    if (name === "landFront.allocation") observeAllocations();
  }
}
const metrics = new CausalMetrics();
withMutedSimulationLogs(() => runSimulation(world, { ticks, metrics, observe: observeMovement }));
const report = { revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  seed, scenario, campaign, ticks, counts, endWorld: summarizeWorld(world),
  counters: metrics.getCounters(), metrics: metrics.getMetricSummaries(), events };
const output = option("--output", "diagnostics/war-ai-r2-causal.json.gz");
await writeFile(output, gzipSync(JSON.stringify(report)));
console.log(JSON.stringify({ output, counts }));
