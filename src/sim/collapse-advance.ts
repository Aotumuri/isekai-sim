import { WORLD_BALANCE } from "../data/balance";
import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import { getEnemyStrengthByRegion, getFrontDistanceField } from "./ai-geography";
import { getCapitalDefenseAssessment } from "./capital-defense";
import { getFrontlineCoverage } from "./frontline-coverage";
import { getFrontSide, getOpposingFrontSide, type FrontId, type OperationalSector } from "./land-fronts";
import { isNationActive } from "./nation-active";
import { getFrontAllocation } from "./nation-front-allocations";
import { getOffensiveOperations } from "./offensive-operations";
import type { UnitId, UnitState } from "./unit";
import { getUnitCombatStrength } from "./unit-strength";
import type { WorldState } from "./world-state";
import { recordCollapseOpportunityDiagnostic } from "./stalemate-pressure";
import { getMesoById, getNeighborsById, getOwnerByMesoId } from "./world-cache";
import {
  getBattlefieldTopologyAssessment,
  getCollapseOpportunities,
  updateBattlefieldTopology,
  type BattlefieldComponentId,
  type CollapseOpportunity,
  type CollapseTopologyReason,
} from "./battlefield-topology";

export type CollapseAdvancePhase = "forming" | "advancing" | "completed" | "cancelled";
export type CollapseAdvanceReason = "no-valid-frontline-target" | "enemy-defense-collapsed" | "reachable-open-territory";
export type CollapseAdvanceStopReason = "front-reformed" | "capital-emergency" | "retreat-started" | "war-ended" | "nation-inactive" | "timeout" | "depth-limit" | "no-open-target" | "force-depleted" | "normal-operation-available";

export interface CollapseAdvance {
  nationId: NationId;
  enemyNationId: NationId;
  sourceSectorId?: FrontId;
  phase: CollapseAdvancePhase;
  unitIds: UnitId[];
  targetRegionIds: MesoRegionId[];
  currentTargetRegionId: MesoRegionId;
  startedAtTick: number;
  phaseStartedAtTick: number;
  reasonFlags: CollapseAdvanceReason[];
  occupiedTargetCount: number;
  stopReason: CollapseAdvanceStopReason | null;
  topologyComponentId: BattlefieldComponentId;
  topologyScore: number;
  topologyReasonFlags: CollapseTopologyReason[];
}

export interface CollapseAdvanceEvent { tick: number; nationId: NationId; enemyNationId: NationId; type: "created" | "retargeted" | "stopped"; detail: string; }
export interface CollapseAdvanceState {
  enabled: boolean;
  advances: CollapseAdvance[];
  history: CollapseAdvance[];
  advanceByNationId: Map<NationId, CollapseAdvance>;
  advanceNationByUnitId: Map<UnitId, NationId>;
  timeline: CollapseAdvanceEvent[];
  version: number;
  membershipVersion: number;
  opportunitiesDetected: number;
  createdCount: number;
  unitsCommitted: number;
  strengthCommitted: number;
  depthTotal: number;
  targetsOccupied: number;
  citiesOccupied: number;
  capitalsOccupied: number;
  durationTotalTicks: number;
  frontReformationStops: number;
  artificialInactivityResolved: number;
  artificialInactivityRemaining: number;
  stopCounts: Record<CollapseAdvanceStopReason, number>;
}

export function createCollapseAdvanceState(): CollapseAdvanceState {
  return { enabled: true, advances: [], history: [], advanceByNationId: new Map(), advanceNationByUnitId: new Map(), timeline: [], version: 0, membershipVersion: 0, opportunitiesDetected: 0, createdCount: 0, unitsCommitted: 0, strengthCommitted: 0, depthTotal: 0, targetsOccupied: 0, citiesOccupied: 0, capitalsOccupied: 0, durationTotalTicks: 0, frontReformationStops: 0, artificialInactivityResolved: 0, artificialInactivityRemaining: 0, stopCounts: { "front-reformed": 0, "capital-emergency": 0, "retreat-started": 0, "war-ended": 0, "nation-inactive": 0, timeout: 0, "depth-limit": 0, "no-open-target": 0, "force-depleted": 0, "normal-operation-available": 0 } };
}

export function getCollapseAdvanceForUnit(world: WorldState, unitId: UnitId): CollapseAdvance | undefined {
  const nationId = world.collapseAdvances.advanceNationByUnitId.get(unitId);
  return nationId ? world.collapseAdvances.advanceByNationId.get(nationId) : undefined;
}

export function updateCollapseAdvances(world: WorldState): void {
  const started = world.instrumentation ? performance.now() : 0;
  const state = world.collapseAdvances;
  if (!state.enabled) return;
  if (world.battlefieldTopology.version === 0 ||
      world.battlefieldTopology.territoryVersion !== world.territoryVersion ||
      world.battlefieldTopology.occupationVersion !== world.occupation.version ||
      world.battlefieldTopology.landFrontVersion !== world.landFronts.version) {
    updateBattlefieldTopology(world);
  }
  const previousMembership = new Map(state.advanceNationByUnitId);
  const retained: CollapseAdvance[] = [];
  const stoppedNationIds = new Set<NationId>();
  for (const advance of state.advances) {
    const stop = getStopReason(world, advance);
    if (stop) { finish(world, advance, stop); stoppedNationIds.add(advance.nationId); continue; }
    advance.unitIds = advance.unitIds.filter((id) => world.units.some((unit) => unit.id === id && unit.nationId === advance.nationId));
    if (advance.unitIds.length === 0) { finish(world, advance, "force-depleted"); continue; }
    if (controlledBy(world, advance.currentTargetRegionId) === advance.nationId) {
      recordOccupation(world, advance);
      if (advance.targetRegionIds.length >= WORLD_BALANCE.war.landFront.collapseAdvance.maximumTargets) { finish(world, advance, "depth-limit"); continue; }
      const opportunity = matchingOpportunity(world, advance);
      const next = selectTarget(world, advance.nationId, advance.enemyNationId, sectorsFor(world, advance.nationId, advance.enemyNationId), advance.currentTargetRegionId, new Set(advance.targetRegionIds), opportunity);
      if (!next) { finish(world, advance, "no-open-target"); continue; }
      advance.currentTargetRegionId = next.regionId;
      advance.targetRegionIds.push(next.regionId);
      advance.phase = "advancing";
      state.timeline.push({ tick: world.time.fastTick, nationId: advance.nationId, enemyNationId: advance.enemyNationId, type: "retargeted", detail: `${next.regionId}:depth-${advance.targetRegionIds.length}` });
      state.version += 1;
    }
    retained.push(advance);
  }
  state.advances = retained;
  rebuildIndexes(state);

  // Topology is the behavior trigger. Stalemate Pressure remains a diagnostic
  // consumer so existing inactivity reports can explain why the advance began.
  const opportunities = [...getCollapseOpportunities(world)].sort((a, b) =>
    b.score - a.score || compareIds(a.attackerNationId, b.attackerNationId) || compareIds(a.enemyNationId, b.enemyNationId)
  );
  for (const topologyOpportunity of opportunities) {
    const nationId = topologyOpportunity.attackerNationId;
    const enemyNationId = topologyOpportunity.enemyNationId;
    if (stoppedNationIds.has(nationId) || state.advanceByNationId.has(nationId) || getOffensiveOperations(world, nationId).some((op) => op.phase !== "recovering")) {
      recordIgnoredOpportunity(world, topologyOpportunity);
      continue;
    }
    const opportunity = assessOpportunity(world, topologyOpportunity);
    if (!opportunity) { state.artificialInactivityRemaining += 1; world.instrumentation?.incrementCounter("collapseAdvance.artificialInactivityRemaining"); recordIgnoredOpportunity(world, topologyOpportunity); continue; }
    recordCollapseOpportunityDiagnostic(world, nationId, enemyNationId);
    state.opportunitiesDetected += 1;
    world.instrumentation?.incrementCounter("collapseAdvance.opportunities");
    const units = selectUnits(opportunity.units);
    if (units.length === 0) { state.artificialInactivityRemaining += 1; recordIgnoredOpportunity(world, topologyOpportunity); continue; }
    const advance: CollapseAdvance = { nationId, enemyNationId, sourceSectorId: opportunity.sector.id, phase: "forming", unitIds: units.map((unit) => unit.id), targetRegionIds: [opportunity.target.regionId], currentTargetRegionId: opportunity.target.regionId, startedAtTick: world.time.fastTick, phaseStartedAtTick: world.time.fastTick, reasonFlags: ["no-valid-frontline-target", "enemy-defense-collapsed", "reachable-open-territory"], occupiedTargetCount: 0, stopReason: null, topologyComponentId: topologyOpportunity.componentId, topologyScore: topologyOpportunity.score, topologyReasonFlags: [...topologyOpportunity.reasonFlags] };
    state.advances.push(advance); state.createdCount += 1; state.unitsCommitted += units.length; const strength = units.reduce((sum, unit) => sum + finiteStrength(unit), 0); state.strengthCommitted += strength; state.artificialInactivityResolved += 1;
    state.timeline.push({ tick: world.time.fastTick, nationId: advance.nationId, enemyNationId: advance.enemyNationId, type: "created", detail: `${advance.currentTargetRegionId}:${units.length}-units` });
    world.instrumentation?.incrementCounter("collapseAdvance.created"); world.instrumentation?.incrementCounter("collapseAdvance.unitsCommitted", units.length); world.instrumentation?.incrementCounter("collapseAdvance.strengthCommitted", strength); world.instrumentation?.incrementCounter("collapseAdvance.artificialInactivityResolved");
    rebuildIndexes(state); state.version += 1;
  }
  rebuildIndexes(state);
  if (!mapsEqual(previousMembership, state.advanceNationByUnitId)) state.membershipVersion += 1;
  if (world.instrumentation) world.instrumentation.recordDuration("collapseAdvance.evaluation", performance.now() - started);
}

function assessOpportunity(world: WorldState, topology: CollapseOpportunity) {
  const nationId = topology.attackerNationId;
  const enemyNationId = topology.enemyNationId;
  if (getCapitalDefenseAssessment(world, nationId)?.threatLevel === "critical") return null;
  if (world.retreatPlans.plansByNationId.get(nationId)?.some((p) => sectorsFor(world, nationId, enemyNationId).some((s) => s.id === p.frontId))) return null;
  const sectors = sectorsFor(world, nationId, enemyNationId);
  const selectedSector = sectors.find((sector) => sector.id === topology.sectorId);
  if (!selectedSector) return null;
  const candidates = [{ sector: selectedSector, target: selectTarget(world, nationId, enemyNationId, [selectedSector], undefined, new Set(), topology) }].filter((item): item is { sector: OperationalSector; target: NonNullable<ReturnType<typeof selectTarget>> } => !!item.target);
  const selected = candidates[0]; if (!selected) return null;
  const units = eligibleUnits(world, selected.sector, nationId);
  if (units.length === 0) return null;
  return { ...selected, units };
}

function eligibleUnits(world: WorldState, sector: OperationalSector, nationId: NationId): UnitState[] {
  const allocation = getFrontAllocation(world, sector.id, nationId); if (!allocation) return [];
  const protectedIds = new Set(getFrontlineCoverage(world, sector.id, nationId)?.positions.flatMap((p) => p.defenderUnitIds) ?? []);
  for (const id of world.strategicReserves.reserveNationByUnitId.keys()) protectedIds.add(id);
  for (const id of world.reorganization.planIdByUnitId.keys()) protectedIds.add(id);
  for (const plan of world.retreatPlans.plans) for (const id of [...plan.rearguardUnitIds, ...plan.retreatingUnitIds]) protectedIds.add(id);
  for (const id of world.offensiveOperations.operationIdByUnitId.keys()) protectedIds.add(id);
  const byId = new Map(world.units.map((unit) => [unit.id, unit]));
  return allocation.unitIds.map((id) => byId.get(id)).filter((unit): unit is UnitState => !!unit && unit.nationId === nationId && unit.domain === "land" && unit.org > 0 && finiteStrength(unit) > 0 && !protectedIds.has(unit.id)).sort((a, b) => finiteStrength(b) - finiteStrength(a) || compareIds(a.id, b.id));
}

function selectUnits(units: UnitState[]): UnitState[] { const s = WORLD_BALANCE.war.landFront.collapseAdvance; const count = Math.min(s.maximumUnits, units.length, Math.max(s.minimumUnits, Math.ceil(units.length * s.forceFraction))); return units.slice(0, count); }
function selectTarget(world: WorldState, nationId: NationId, enemyNationId: NationId, sectors: OperationalSector[], origin?: MesoRegionId, excluded = new Set<MesoRegionId>(), opportunity?: CollapseOpportunity) {
  const settings = WORLD_BALANCE.war.landFront.collapseAdvance; const mesoById = getMesoById(world); const localEnemy = getEnemyStrengthByRegion(world, nationId); const neighbors = getNeighborsById(world);
  const distances = new Map<MesoRegionId, number>();
  if (origin) { distances.set(origin, 0); const queue = [origin]; for (let h = 0; h < queue.length; h += 1) { const current = queue[h]; const d = distances.get(current)!; if (d >= settings.maximumTargetDistance) continue; for (const next of neighbors.get(current) ?? []) { const controller = controlledBy(world, next); if (!distances.has(next) && mesoById.get(next)?.type !== "sea" && (controller === nationId || controller === enemyNationId)) { distances.set(next, d + 1); queue.push(next); } } } }
  else for (const sector of sectors) { const field = getFrontDistanceField(world, sector.id, nationId); for (const [id, d] of field?.distanceByRegionId ?? []) { const before = distances.get(id); if (before === undefined || d < before) distances.set(id, d); } }
  const assessment = getBattlefieldTopologyAssessment(world, nationId, enemyNationId);
  const componentIds = new Set(assessment?.enemyComponents.find((component) => component.id === opportunity?.componentId)?.regionIds ?? []);
  return [...distances.entries()].filter(([id, d]) => d > 0 && d <= settings.maximumTargetDistance && !excluded.has(id) && controlledBy(world, id) === enemyNationId && mesoById.get(id)?.type !== "sea" && nearbyStrength(id, localEnemy, neighbors, settings.localDefenseRadius) <= settings.collapsedDefenseStrength).map(([regionId, distance]) => { const building = mesoById.get(regionId)?.building; const bonus = building === "capital" && distance <= settings.capitalPreferenceDistance ? 260 : building === "city" && distance <= settings.cityPreferenceDistance ? 150 : 0; const topologyBonus = regionId === opportunity?.targetRegionId ? 500 : componentIds.has(regionId) ? 120 : 0; return { regionId, distance, score: bonus + topologyBonus - distance * 100 }; }).sort((a, b) => b.score - a.score || a.distance - b.distance || compareIds(a.regionId, b.regionId))[0] ?? null;
}
function getStopReason(world: WorldState, advance: CollapseAdvance): CollapseAdvanceStopReason | null { const nation = world.nations.find((n) => n.id === advance.nationId); if (!nation || !isNationActive(nation)) return "nation-inactive"; if (!world.wars.some((w) => (w.nationAId === advance.nationId && w.nationBId === advance.enemyNationId) || (w.nationBId === advance.nationId && w.nationAId === advance.enemyNationId))) return "war-ended"; if (getCapitalDefenseAssessment(world, advance.nationId)?.threatLevel === "critical") return "capital-emergency"; if (world.retreatPlans.plansByNationId.get(advance.nationId)?.length) return "retreat-started"; if (getOffensiveOperations(world, advance.nationId).some((op) => op.phase !== "recovering")) return "normal-operation-available"; if (world.time.fastTick - advance.startedAtTick >= WORLD_BALANCE.war.landFront.collapseAdvance.timeoutTicks) return "timeout"; const settings = WORLD_BALANCE.war.landFront.collapseAdvance; const opportunity = matchingOpportunity(world, advance); const localDefense = nearbyStrength(advance.currentTargetRegionId, getEnemyStrengthByRegion(world, advance.nationId), getNeighborsById(world), settings.localDefenseRadius); return !opportunity || localDefense >= settings.reformedDefenseStrength ? "front-reformed" : null; }
function finish(world: WorldState, advance: CollapseAdvance, reason: CollapseAdvanceStopReason) { const state = world.collapseAdvances; advance.phase = reason === "depth-limit" || reason === "no-open-target" ? "completed" : "cancelled"; advance.stopReason = reason; state.history.push(advance); state.depthTotal += advance.targetRegionIds.length; state.durationTotalTicks += world.time.fastTick - advance.startedAtTick; state.stopCounts[reason] += 1; if (reason === "front-reformed") { state.frontReformationStops += 1; world.instrumentation?.incrementCounter("collapseAdvance.frontReformationStops"); } state.timeline.push({ tick: world.time.fastTick, nationId: advance.nationId, enemyNationId: advance.enemyNationId, type: "stopped", detail: reason }); state.version += 1; }
function recordOccupation(world: WorldState, advance: CollapseAdvance) { const meso = getMesoById(world).get(advance.currentTargetRegionId); advance.occupiedTargetCount += 1; world.collapseAdvances.targetsOccupied += 1; if (meso?.building === "city") world.collapseAdvances.citiesOccupied += 1; if (meso?.building === "capital") world.collapseAdvances.capitalsOccupied += 1; world.instrumentation?.incrementCounter("collapseAdvance.targetsOccupied"); if (meso?.building === "city") world.instrumentation?.incrementCounter("collapseAdvance.citiesOccupied"); if (meso?.building === "capital") world.instrumentation?.incrementCounter("collapseAdvance.capitalsOccupied"); }
function sectorsFor(world: WorldState, nationId: NationId, enemyNationId: NationId) { return world.landFronts.operationalSectors.filter((sector) => (sector.nationAId === nationId && sector.nationBId === enemyNationId) || (sector.nationBId === nationId && sector.nationAId === enemyNationId)); }
function controlledBy(world: WorldState, id: MesoRegionId) { return world.occupation.mesoById.get(id) ?? getOwnerByMesoId(world).get(id); }
function nearbyStrength(id: MesoRegionId, strengths: ReadonlyMap<MesoRegionId, number>, neighbors: Map<MesoRegionId, MesoRegionId[]>, radius: number) { let total = strengths.get(id) ?? 0; if (radius > 0) for (const n of neighbors.get(id) ?? []) total += strengths.get(n) ?? 0; return total; }
function finiteStrength(unit: UnitState) { const value = getUnitCombatStrength(unit); return Number.isFinite(value) ? value : 0; }
function rebuildIndexes(state: CollapseAdvanceState) { state.advanceByNationId = new Map(state.advances.map((a) => [a.nationId, a])); state.advanceNationByUnitId.clear(); for (const a of state.advances) for (const id of a.unitIds) state.advanceNationByUnitId.set(id, a.nationId); if (state.history.length > 256) state.history.splice(0, state.history.length - 256); if (state.timeline.length > WORLD_BALANCE.war.landFront.collapseAdvance.timelineLimit) state.timeline.splice(0, state.timeline.length - WORLD_BALANCE.war.landFront.collapseAdvance.timelineLimit); }
function mapsEqual(a: Map<UnitId, NationId>, b: Map<UnitId, NationId>) { if (a.size !== b.size) return false; for (const [id, nation] of a) if (b.get(id) !== nation) return false; return true; }
function compareIds(a: string, b: string) { return a.localeCompare(b, undefined, { numeric: true }); }

function matchingOpportunity(world: WorldState, advance: CollapseAdvance): CollapseOpportunity | undefined {
  const opportunities = getBattlefieldTopologyAssessment(world, advance.nationId, advance.enemyNationId)?.collapseOpportunities ?? [];
  return opportunities.find((item) => item.componentId === advance.topologyComponentId) ??
    opportunities.find((item) => item.sectorId === advance.sourceSectorId) ?? opportunities[0];
}

function recordIgnoredOpportunity(world: WorldState, opportunity: CollapseOpportunity): void {
  const key = `${opportunity.attackerNationId}|${opportunity.enemyNationId}|${opportunity.sectorId}|${opportunity.componentId}|${opportunity.detectedAtTick}`;
  if (world.battlefieldTopology.ignoredCollapseOpportunityKeys.has(key)) return;
  world.battlefieldTopology.ignoredCollapseOpportunityKeys.add(key);
  world.battlefieldTopology.ignoredCollapseOpportunityCount += 1;
  world.instrumentation?.incrementCounter("battlefieldTopology.collapseOpportunitiesIgnored");
}
