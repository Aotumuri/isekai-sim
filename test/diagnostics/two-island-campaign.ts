import { WORLD_BALANCE } from "../../src/data/balance";
import type { AmphibiousOperation } from "../../src/sim/amphibious";
import { getUnitCombatStrength } from "../../src/sim/unit-strength";
import type { UnitId, UnitState } from "../../src/sim/unit";
import { FAST_TICK_MS, SLOW_TICK_MS } from "../../src/sim/time";
import { stepFastTick, stepSlowTick } from "../../src/sim/update";
import type { WorldState } from "../../src/sim/world-state";
import type { MesoRegionId } from "../../src/worldgen/meso-region";
import type { NationId } from "../../src/worldgen/nation";
import { BenchmarkMetrics } from "../benchmark/metrics";
import { createScenarioWorld } from "../scenarios";

const DEFAULT_SEED = 695_919_685_365;
const DEFAULT_TICKS = 12_000;
const MINIMUM_OBSERVATION_TICKS = 10_000;

type FailureReason = "insufficient landing force" | "enemy reaction" | "poor landing site" |
  "insufficient reinforcement" | "transport loss" | "escort loss" | "supply collapse" |
  "war ended" | "other";

interface UnitSnapshot { regionId: MesoRegionId; strength: number; nationId: NationId }

interface LandingRecord {
  operation: AmphibiousOperation;
  createdTick: number;
  launchTick: number | null;
  landingTick: number | null;
  outcomeTick: number | null;
  actualImmediateStrength: number;
  actualReactionStrength: number;
  reactionUnitIds: Set<UnitId>;
  initialDefenderIds: Set<UnitId>;
  friendlyAlreadyPresentIds: Set<UnitId>;
  reinforcementIds: Set<UnitId>;
  reinforcementStrength: number;
  reinforcementFirstTick: number | null;
  reinforcementChangedOutcome: boolean;
  sawSupplyCollapse: boolean;
  maxTerritory: number;
  maxCities: number;
  maxPorts: number;
  maxInlandExpansion: number;
  cityTick: number | null;
  portTick: number | null;
  capitalTick: number | null;
  forceExtinctTick: number | null;
  cargoCount: number;
  cargoCapacity: number;
  failureReason: FailureReason | null;
}

interface TimelineEvent { tick: number; event: string; detail: string }

const ticks = readNumber("--ticks", DEFAULT_TICKS);
const seed = readNumber("--seed", DEFAULT_SEED);
const world = createScenarioWorld("two-island-amphibious", {
  seed, width: 640, height: 360, quick: true,
  reserveEnabled: true, reorganizationEnabled: true,
  exploitationEnabled: true, pocketReductionEnabled: true,
});
const metrics = new BenchmarkMetrics();
world.instrumentation = metrics;
const originalOwner = new Map<MesoRegionId, NationId>();
for (const macro of world.macroRegions) for (const id of macro.mesoRegionIds) originalOwner.set(id, macro.nationId);
const mesoById = new Map(world.mesoRegions.map((region) => [region.id, region]));
const islandIdsByNation = new Map(world.nations.map((nation) => [
  nation.id,
  new Set(world.macroRegions.filter((macro) => macro.nationId === nation.id).flatMap((macro) => macro.mesoRegionIds)),
]));
const records = new Map<string, LandingRecord>();
const seenDemandIds = new Set<string>();
const demandStateById = new Map<string, string>();
const timeline: TimelineEvent[] = [{ tick: 0, event: "war", detail: `${world.wars[0]?.nationAId} vs ${world.wars[0]?.nationBId}` }];
let transportAssetTicks = 0;
let transportAssignedTicks = 0;
let escortAssetTicks = 0;
let escortAssignedTicks = 0;
let warEndedAt: number | null = null;
let previous = snapshotUnits(world.units);
const cpuStart = process.cpuUsage();
const wallStart = performance.now();
const originalInfo = console.info;
console.info = () => undefined;
try {
  for (let index = 0; index < ticks; index += 1) {
    stepFastTick(world, FAST_TICK_MS);
    const dueSlowTicks = Math.floor(world.time.elapsedMs / SLOW_TICK_MS);
    while (world.time.slowTick < dueSlowTicks) stepSlowTick(world, SLOW_TICK_MS);
    observeCampaign(world, previous);
    previous = snapshotUnits(world.units);
    if (world.wars.length === 0 && warEndedAt === null) {
      warEndedAt = world.time.fastTick;
      const winner = world.nations.find((nation) => nation.macroRegionIds.length > 0)?.id ?? "none";
      timeline.push({ tick: world.time.fastTick, event: "war ended", detail: `winner ${winner}` });
    }
    if (warEndedAt !== null && world.time.fastTick >= MINIMUM_OBSERVATION_TICKS) break;
  }
} finally {
  console.info = originalInfo;
}
finalizeRecords(world);
const cpu = process.cpuUsage(cpuStart);
const wallMs = performance.now() - wallStart;
console.log(formatReport(world, wallMs, (cpu.user + cpu.system) / 1_000));

function observeCampaign(current: WorldState, before: Map<UnitId, UnitSnapshot>): void {
  const activeAssigned = new Set<UnitId>();
  for (const demand of current.amphibiousOperations.capabilityDemands) {
    if (!seenDemandIds.has(demand.id)) {
      seenDemandIds.add(demand.id);
      timeline.push({ tick: demand.createdAtTick, event: "capability demand", detail: `${demand.nationId} -> ${demand.destinationPortId}` });
    }
    const priorState = demandStateById.get(demand.id);
    if (priorState && priorState !== demand.state && (demand.state === "expired" || demand.state === "cancelled")) {
      timeline.push({ tick: demand.lastValidatedAtTick, event: `demand ${demand.state}`, detail: `${demand.id}: ${demand.waitingReason ?? "opportunity invalidated"}` });
    }
    demandStateById.set(demand.id, demand.state);
    if (["expired", "cancelled"].includes(demand.state)) continue;
    for (const id of [...demand.assignedTransportIds, ...demand.assignedEscortIds]) activeAssigned.add(id);
  }
  for (const operation of current.amphibiousOperations.operations) {
    if (operation.phase !== "landed" && operation.phase !== "cancelled") {
      for (const id of [...operation.transportIds, ...operation.escortIds]) activeAssigned.add(id);
    }
    let record = records.get(operation.id);
    if (!record) {
      record = createRecord(operation);
      records.set(operation.id, record);
      timeline.push({ tick: operation.preparationLeaseStartedAtTick, event: "operation", detail: `${operation.nationId} ${operation.id}` });
    }
    if (record.launchTick === null && operation.launchedAtTick !== null) {
      record.launchTick = operation.launchedAtTick;
      const transports = current.units.filter((unit) => operation.transportIds.includes(unit.id));
      record.cargoCount = transports.reduce((sum, unit) => sum + unit.cargoUnits.length, 0);
      record.cargoCapacity = transports.length * Math.max(1, WORLD_BALANCE.unit.navalTransportCapacity ?? 10);
      timeline.push({ tick: operation.launchedAtTick, event: "launch", detail: `${operation.nationId}, ${record.cargoCount}/${record.cargoCapacity} cargo` });
    }
    if (record.landingTick === null && operation.completedAtTick !== null && operation.phase === "landed") {
      record.landingTick = operation.completedAtTick;
      captureLandingSnapshot(current, record, before);
      timeline.push({ tick: operation.completedAtTick, event: "landing", detail: `${operation.nationId} at ${operation.destinationPortId}` });
    }
    if (operation.phase === "cancelled" && record.failureReason === null) {
      record.outcomeTick = operation.completedAtTick;
      record.failureReason = classifyCancellation(operation.cancellationReason);
      timeline.push({ tick: operation.completedAtTick ?? current.time.fastTick, event: "failed", detail: `${operation.id}: ${record.failureReason}` });
    }
    if (record.landingTick !== null) updateLandingRecord(current, record);
    if (record.outcomeTick === null && operation.beachheadEvaluatedAtTick !== null) {
      record.outcomeTick = operation.beachheadEvaluatedAtTick;
      if (operation.beachheadOutcome === "failure") record.failureReason = classifyBeachheadFailure(record);
      timeline.push({
        tick: operation.beachheadEvaluatedAtTick,
        event: operation.beachheadOutcome === "success" ? "beachhead held" : "failed",
        detail: operation.beachheadOutcome === "success" ? operation.id : `${operation.id}: ${record.failureReason}`,
      });
    }
  }
  for (const unit of current.units) {
    if (unit.type === "TransportShip") {
      transportAssetTicks += 1;
      if (activeAssigned.has(unit.id)) transportAssignedTicks += 1;
    } else if (unit.type === "CombatShip") {
      escortAssetTicks += 1;
      if (activeAssigned.has(unit.id)) escortAssignedTicks += 1;
    }
  }
}

function createRecord(operation: AmphibiousOperation): LandingRecord {
  return {
    operation, createdTick: operation.preparationLeaseStartedAtTick, launchTick: null,
    landingTick: null, outcomeTick: null, actualImmediateStrength: 0,
    actualReactionStrength: 0, reactionUnitIds: new Set(), initialDefenderIds: new Set(),
    friendlyAlreadyPresentIds: new Set(), reinforcementIds: new Set(), reinforcementStrength: 0,
    reinforcementFirstTick: null, reinforcementChangedOutcome: false, sawSupplyCollapse: false,
    maxTerritory: 0, maxCities: 0, maxPorts: 0, maxInlandExpansion: 0,
    cityTick: null, portTick: null, capitalTick: null, forceExtinctTick: null,
    cargoCount: 0, cargoCapacity: 0, failureReason: null,
  };
}

function captureLandingSnapshot(current: WorldState, record: LandingRecord, before: Map<UnitId, UnitSnapshot>): void {
  const op = record.operation;
  const enemyIsland = islandIdsByNation.get(op.enemyNationId) ?? new Set<MesoRegionId>();
  for (const [id, unit] of before) {
    if (unit.nationId === op.enemyNationId && unit.regionId === op.destinationPortId) {
      record.initialDefenderIds.add(id);
      record.actualImmediateStrength += unit.strength;
    }
    if (unit.nationId === op.nationId && enemyIsland.has(unit.regionId)) record.friendlyAlreadyPresentIds.add(id);
  }
}

function updateLandingRecord(current: WorldState, record: LandingRecord): void {
  const op = record.operation;
  const enemyIsland = islandIdsByNation.get(op.enemyNationId) ?? new Set<MesoRegionId>();
  const beachhead = new Set([op.destinationPortId, ...(mesoById.get(op.destinationPortId)?.neighbors ?? [])
    .map((neighbor) => neighbor.id).filter((id) => mesoById.get(id)?.type !== "sea")]);
  const live = new Map(current.units.map((unit) => [unit.id, unit]));
  for (const unit of current.units) {
    if (unit.domain !== "land") continue;
    if (current.time.fastTick - record.landingTick! <= WORLD_BALANCE.unit.amphibiousAssault.beachheadSurvivalTicks &&
      unit.nationId === op.enemyNationId && beachhead.has(unit.regionId) &&
      !record.initialDefenderIds.has(unit.id) && !record.reactionUnitIds.has(unit.id)) {
      record.reactionUnitIds.add(unit.id);
      const delay = current.time.fastTick - record.landingTick!;
      const shortWindow = WORLD_BALANCE.unit.amphibiousAssault.beachheadSurvivalTicks *
        WORLD_BALANCE.unit.amphibiousAssault.reactionShortWindowFraction;
      const weight = delay <= shortWindow
        ? WORLD_BALANCE.unit.amphibiousAssault.reactionShortWeight
        : WORLD_BALANCE.unit.amphibiousAssault.reactionMediumWeight;
      record.actualReactionStrength += getUnitCombatStrength(unit) * weight;
    }
    if (unit.nationId === op.nationId && enemyIsland.has(unit.regionId) &&
      !op.assignedUnitIds.includes(unit.id) && !record.friendlyAlreadyPresentIds.has(unit.id) &&
      !record.reinforcementIds.has(unit.id)) {
      const friendlyBefore = localStrength(current.units, op.nationId, enemyIsland);
      const enemyBefore = localStrength(current.units, op.enemyNationId, enemyIsland);
      record.reinforcementIds.add(unit.id);
      const strength = getUnitCombatStrength(unit);
      record.reinforcementStrength += strength;
      record.reinforcementFirstTick ??= current.time.fastTick;
      if (friendlyBefore - strength < enemyBefore && friendlyBefore >= enemyBefore) {
        record.reinforcementChangedOutcome = true;
      }
    }
  }
  if (op.assignedUnitIds.some((id) => current.isolationEffects.previouslyDecayingUnitIds.has(id))) {
    record.sawSupplyCollapse = true;
  }
  const captured = [...current.occupation.mesoById.entries()].filter(([id, occupier]) =>
    occupier === op.nationId && originalOwner.get(id) === op.enemyNationId);
  record.maxTerritory = Math.max(record.maxTerritory, captured.length);
  let cities = 0;
  let ports = 0;
  let maxDepth = 0;
  const distances = landDistances(op.destinationPortId, enemyIsland);
  for (const [id] of captured) {
    const building = mesoById.get(id)?.building;
    if (building === "city" || building === "capital") cities += 1;
    if (building === "port") ports += 1;
    if (building === "capital") record.capitalTick ??= current.time.fastTick;
    if (building === "city" || building === "capital") record.cityTick ??= current.time.fastTick;
    if (building === "port") record.portTick ??= current.time.fastTick;
    maxDepth = Math.max(maxDepth, distances.get(id) ?? 0);
  }
  record.maxCities = Math.max(record.maxCities, cities);
  record.maxPorts = Math.max(record.maxPorts, ports);
  record.maxInlandExpansion = Math.max(record.maxInlandExpansion, maxDepth);
  if (record.forceExtinctTick === null && op.assignedUnitIds.every((id) => !live.has(id))) {
    record.forceExtinctTick = current.time.fastTick;
  }
}

function finalizeRecords(current: WorldState): void {
  for (const record of records.values()) {
    if (record.failureReason === null && record.operation.beachheadOutcome === "failure") {
      record.failureReason = classifyBeachheadFailure(record);
    }
  }
}

function classifyCancellation(reason: AmphibiousOperation["cancellationReason"]): FailureReason {
  if (reason === "transport-lost" || reason === "convoy-lost") return "transport loss";
  if (reason === "escort-lost") return "escort loss";
  if (reason === "war-ended") return "war ended";
  if (reason === "force-lost") return "insufficient landing force";
  if (reason === "target-invalid" || reason === "route-invalid" || reason === "departure-port-lost") return "poor landing site";
  return "other";
}

function classifyBeachheadFailure(record: LandingRecord): FailureReason {
  const op = record.operation;
  if (record.actualImmediateStrength > Math.max(1, op.immediateDefenderStrength) * 1.5 ||
    record.actualReactionStrength > Math.max(1, op.reactionStrength) * 1.5) return "poor landing site";
  if (op.assignedStrength < record.actualImmediateStrength + record.actualReactionStrength) return "insufficient landing force";
  if (record.sawSupplyCollapse) return "supply collapse";
  if (record.actualReactionStrength > 0) return "enemy reaction";
  if (record.reinforcementIds.size === 0) return "insufficient reinforcement";
  return "other";
}

function formatReport(current: WorldState, wallMs: number, cpuMs: number): string {
  const all = [...records.values()].sort((a, b) => a.createdTick - b.createdTick);
  const launches = all.filter((record) => record.launchTick !== null);
  const landings = all.filter((record) => record.landingTick !== null);
  const successes = landings.filter((record) => record.operation.beachheadOutcome === "success");
  const failures = all.filter((record) => record.failureReason !== null);
  const winner = current.nations.find((nation) => nation.macroRegionIds.length > 0 &&
    current.nations.some((other) => other.id !== nation.id && other.macroRegionIds.length === 0))?.id ?? "none";
  const launchTicks = launches.map((record) => record.launchTick!).sort((a, b) => a - b);
  const survival = landings.map((record) =>
    (record.forceExtinctTick ?? warEndedAt ?? current.time.fastTick) - record.landingTick!);
  const metric = metrics.getMetricSummaries();
  const lines = [
    "Two-Island Amphibious Campaign Diagnostic",
    `seed ${seed}; ${current.time.fastTick} fast ticks; wall ${fixed(wallMs)} ms; CPU ${fixed(cpuMs)} ms`,
    `scenario: 2 nations, ${countLandComponents(current)} islands, 0 land borders, 2 ports/nation, equal initial force/resources`,
    "",
    "Campaign summary",
    table([
      ["capability demands", current.amphibiousOperations.capabilityDemandsCreated],
      ["operations", current.amphibiousOperations.landingPlans],
      ["launches", current.amphibiousOperations.launchedOperations],
      ["landings", current.amphibiousOperations.completedLandings],
      ["successful beachheads", current.amphibiousOperations.successfulBeachheads],
      ["failed beachheads/operations", failures.length],
      ["average landing units", average(landings.map((record) => record.operation.assignedUnitIds.length))],
      ["average landing force", average(landings.map((record) => record.operation.assignedStrength))],
      ["average actual defender", average(landings.map((record) => record.actualImmediateStrength))],
      ["average actual reaction", average(landings.map((record) => record.actualReactionStrength))],
      ["time to first launch", launchTicks[0] ?? "none"],
      ["average time between launches", average(differences(launchTicks))],
      ["war duration", warEndedAt ?? current.time.fastTick],
      ["winner", winner],
    ]),
    "",
    "Timeline",
    ...timeline.sort((a, b) => a.tick - b.tick).map((event) => `${String(event.tick).padStart(6)}  ${event.event.padEnd(18)} ${event.detail}`),
    "",
    "Beachheads",
    row(["op", "side", "land", "survive", "territory", "cities", "ports", "depth", "reinforced", "outcome"]),
    ...all.map((record) => row([
      record.operation.id.replace("amphibious-operation-", "op-"), record.operation.nationId,
      record.landingTick ?? "-", record.landingTick === null ? "-" :
        (record.forceExtinctTick ?? warEndedAt ?? current.time.fastTick) - record.landingTick,
      record.maxTerritory, record.maxCities, record.maxPorts, record.maxInlandExpansion,
      record.reinforcementIds.size > 0 ? `yes(${record.reinforcementIds.size})` : "no",
      record.failureReason ?? record.operation.beachheadOutcome,
    ])),
    `average beachhead survival: ${fixed(average(survival))} ticks`,
    `reinforcement changed outcome: ${all.filter((record) => record.reinforcementChangedOutcome).length}/${all.length}`,
    "",
    "Immediate-defender estimate validation",
    row(["op", "estimated", "actual", "error", "absolute error %"]),
    ...landings.map((record) => {
      const estimated = record.operation.immediateDefenderStrength;
      const error = record.actualImmediateStrength - estimated;
      return row([record.operation.id.replace("amphibious-operation-", "op-"), fixed(estimated),
        fixed(record.actualImmediateStrength), fixed(error), relativeError(estimated, error)]);
    }),
    `mean absolute defender error: ${fixed(average(landings.map((record) => Math.abs(record.actualImmediateStrength - record.operation.immediateDefenderStrength))))}`,
    "",
    "Reaction estimate validation",
    row(["op", "estimated", "actual", "error", "absolute error %"]),
    ...landings.map((record) => {
      const estimated = record.operation.reactionStrength;
      const error = record.actualReactionStrength - estimated;
      return row([record.operation.id.replace("amphibious-operation-", "op-"), fixed(estimated),
        fixed(record.actualReactionStrength), fixed(error), percent(Math.abs(error) / Math.max(1, estimated))]);
    }),
    `mean absolute reaction error: ${fixed(average(landings.map((record) => Math.abs(record.actualReactionStrength - record.operation.reactionStrength))))}`,
    "",
    "Successful invasions",
    row(["op", "force", "reaction", "location", "city", "port", "capital", "survivors"]),
    ...(successes.length ? successes.map((record) => row([
      record.operation.id.replace("amphibious-operation-", "op-"), fixed(record.operation.assignedStrength),
      fixed(record.actualReactionStrength), record.operation.destinationPortId,
      elapsed(record, record.cityTick), elapsed(record, record.portTick), elapsed(record, record.capitalTick),
      record.operation.assignedUnitIds.filter((id) => current.units.some((unit) => unit.id === id)).length,
    ])) : ["none"]),
    "",
    "Primary failure reasons",
    ...(failures.length ? rankedFailures(failures).map(([reason, count]) => `${String(count).padStart(4)}  ${reason}`) : ["   0  no failed operation or beachhead"]),
    "",
    "Capability pipeline root causes",
    ...capabilityRootCauses(current),
    "",
    "Transport and escort validation",
    table([
      ["transport asset utilization", percent(transportAssignedTicks / Math.max(1, transportAssetTicks))],
      ["escort asset utilization", percent(escortAssignedTicks / Math.max(1, escortAssetTicks))],
      ["transport idle asset-ticks", transportAssetTicks - transportAssignedTicks],
      ["escort idle asset-ticks", escortAssetTicks - escortAssignedTicks],
      ["average cargo fill", percent(average(launches.map((record) => record.cargoCount / Math.max(1, record.cargoCapacity))))],
      ["unused transport capacity", launches.reduce((sum, record) => sum + record.cargoCapacity - record.cargoCount, 0)],
    ]),
    "",
    "CPU",
    row(["system", "total ms", "calls", "average ms"]),
    ...[
      ["Amphibious planning", "amphibious.planning"],
      ["Fleet assembly", "amphibious.fleetAssembly"],
      ["Landing-site evaluation", "amphibious.landingSiteEvaluation"],
      ["Convoy movement", "convoy.movement"],
    ].map(([label, name]) => row([label, fixed(metric[name]?.totalMs ?? 0), metric[name]?.count ?? 0, fixed(metric[name]?.averageMs ?? 0)])),
  ];
  return lines.join("\n");
}

function snapshotUnits(units: UnitState[]): Map<UnitId, UnitSnapshot> {
  const result = new Map<UnitId, UnitSnapshot>();
  for (const unit of units) result.set(unit.id, { regionId: unit.regionId, strength: getUnitCombatStrength(unit), nationId: unit.nationId });
  for (const transport of units) for (const unit of transport.cargoUnits) {
    result.set(unit.id, { regionId: transport.regionId, strength: getUnitCombatStrength(unit), nationId: unit.nationId });
  }
  return result;
}

function landDistances(start: MesoRegionId, allowed: Set<MesoRegionId>): Map<MesoRegionId, number> {
  const distance = new Map<MesoRegionId, number>([[start, 0]]);
  const queue = [start];
  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head]!;
    for (const neighbor of mesoById.get(id)?.neighbors ?? []) {
      if (!allowed.has(neighbor.id) || distance.has(neighbor.id)) continue;
      distance.set(neighbor.id, (distance.get(id) ?? 0) + 1);
      queue.push(neighbor.id);
    }
  }
  return distance;
}

function localStrength(units: UnitState[], nationId: NationId, regions: Set<MesoRegionId>): number {
  return units.filter((unit) => unit.domain === "land" && unit.nationId === nationId && regions.has(unit.regionId))
    .reduce((sum, unit) => sum + getUnitCombatStrength(unit), 0);
}

function countLandComponents(current: WorldState): number {
  const seen = new Set<MesoRegionId>();
  let count = 0;
  for (const region of current.mesoRegions) {
    if (region.type === "sea" || seen.has(region.id)) continue;
    count += 1;
    const queue = [region.id];
    seen.add(region.id);
    for (let head = 0; head < queue.length; head += 1) for (const neighbor of mesoById.get(queue[head]!)?.neighbors ?? []) {
      if (mesoById.get(neighbor.id)?.type === "sea" || seen.has(neighbor.id)) continue;
      seen.add(neighbor.id);
      queue.push(neighbor.id);
    }
  }
  return count;
}

function rankedFailures(failures: LandingRecord[]): Array<[FailureReason, number]> {
  const counts = new Map<FailureReason, number>();
  for (const record of failures) counts.set(record.failureReason!, (counts.get(record.failureReason!) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function capabilityRootCauses(current: WorldState): string[] {
  const counts = new Map<string, number>();
  for (const demand of current.amphibiousOperations.capabilityDemands) {
    if (demand.state !== "expired" && demand.state !== "cancelled") continue;
    const reason = demand.waitingReason ?? "opportunity/target invalidated";
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return ranked.length ? ranked.map(([reason, count]) => `${String(count).padStart(4)}  ${reason}`) : ["   0  none"];
}

function elapsed(record: LandingRecord, tick: number | null): number | string {
  return tick === null || record.landingTick === null ? "-" : tick - record.landingTick;
}
function differences(values: number[]): number[] { return values.slice(1).map((value, index) => value - values[index]!); }
function average(values: number[]): number { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function fixed(value: number): string { return Number.isFinite(value) ? value.toFixed(2) : "0.00"; }
function percent(value: number): string { return `${fixed(value * 100)}%`; }
function relativeError(estimated: number, error: number): string {
  return estimated > 0 ? percent(Math.abs(error) / estimated) : error === 0 ? "0.00%" : "unbounded";
}
function table(rows: Array<[string, string | number]>): string { return rows.map(([name, value]) => `${name.padEnd(32)} ${typeof value === "number" ? fixed(value) : value}`).join("\n"); }
function row(values: Array<string | number>): string { return values.map((value) => String(value).padEnd(15)).join(" ").trimEnd(); }
function readNumber(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} requires a non-negative finite number`);
  return Math.floor(value);
}
