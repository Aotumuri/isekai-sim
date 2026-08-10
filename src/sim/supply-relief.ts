import { WORLD_BALANCE } from "../data/balance";
import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import type { FrontId } from "./land-fronts";
import type { SupplyComponentId } from "./supply-assessment";
import type { UnitId } from "./unit";
import { getUnitCombatStrength } from "./unit-strength";
import type { WorldState } from "./world-state";
import { getMesoById, getNeighborsById, getOwnerByMesoId } from "./world-cache";

export type SupplyReliefSeverity = "low" | "moderate" | "high" | "critical";
export type SupplyReliefRouteType = "corridor-retake" | "alternate-land-route" | "port-reconnection" | "component-link";
export type SupplyReliefStatus = "identified" | "deferred" | "preparing" | "attacking" | "stable" | "success" | "partial" | "abandoned" | "cancelled";
export type SupplyReliefReason =
  | "major-force-isolated" | "frontline-isolated" | "city-isolated" | "port-isolated"
  | "capital-isolated" | "prolonged-isolation" | "organization-decay-active";

export interface SupplyReliefNeed {
  id: string;
  nationId: NationId;
  isolatedComponentId: SupplyComponentId;
  isolatedSinceTick: number;
  isolatedStrength: number;
  isolatedUnits: number;
  regionIds: MesoRegionId[];
  cities: number;
  ports: number;
  capitalInside: boolean;
  severity: SupplyReliefSeverity;
  reasonFlags: SupplyReliefReason[];
}

export interface SupplyReliefPlan {
  id: string;
  needId: string;
  nationId: NationId;
  enemyNationId: NationId;
  isolatedComponentId: SupplyComponentId;
  isolatedRegionIds: MesoRegionId[];
  sectorId: FrontId;
  objectiveRegionIds: MesoRegionId[];
  primaryReconnectionRegion: MesoRegionId;
  outsideApproachRegionId: MesoRegionId;
  insideApproachRegionId: MesoRegionId | null;
  expectedRestoredStrength: number;
  expectedRestoredUnits: number;
  routeType: SupplyReliefRouteType;
  outsideForceUnitIds: UnitId[];
  insideForceUnitIds: UnitId[];
  score: number;
  status: SupplyReliefStatus;
  createdTick: number;
  startedTick: number | null;
  reconnectedTick: number | null;
  stableSinceTick: number | null;
  actualRestoredStrength: number;
  actualRestoredUnits: number;
  failureReason: string | null;
}

export interface SupplyReliefState {
  needs: SupplyReliefNeed[];
  plans: SupplyReliefPlan[];
  plansById: Map<string, SupplyReliefPlan>;
  version: number;
  meaningfulIsolationEvents: number;
  operationsCreated: number;
  attacksLaunched: number;
  successes: number;
  partials: number;
  abandoned: number;
  naturalReconnections: number;
  stableReconnections: number;
  isolatedStrengthAtCreation: number;
  restoredStrength: number;
  restoredUnits: number;
}

export function createSupplyReliefState(): SupplyReliefState {
  return { needs: [], plans: [], plansById: new Map(), version: 0, meaningfulIsolationEvents: 0,
    operationsCreated: 0, attacksLaunched: 0, successes: 0, partials: 0, abandoned: 0,
    naturalReconnections: 0, stableReconnections: 0, isolatedStrengthAtCreation: 0,
    restoredStrength: 0, restoredUnits: 0 };
}

/** Uses the already-built Supply Assessment; route search is restricted to the component boundary. */
export function updateSupplyRelief(world: WorldState): void {
  const state = world.supplyRelief;
  const startedAt = world.instrumentation ? performance.now() : 0;
  const oldByNeed = new Map(state.plans.map((plan) => [plan.needId, plan]));
  const needs = collectNeeds(world);
  const plans: SupplyReliefPlan[] = [];
  for (const need of needs) {
    const existing = oldByNeed.get(need.id);
    if (existing) {
      refreshPlan(world, existing, need);
      plans.push(existing);
      continue;
    }
    const plan = buildPlan(world, need);
    if (plan) {
      plans.push(plan);
      state.meaningfulIsolationEvents += 1;
      state.isolatedStrengthAtCreation += need.isolatedStrength;
      world.instrumentation?.incrementCounter("supplyRelief.meaningfulIsolationEvents");
      world.instrumentation?.incrementCounter("supplyRelief.isolatedStrengthAtCreation", need.isolatedStrength);
    }
  }
  for (const old of state.plans) {
    if (needs.some((need) => need.id === old.needId)) continue;
    if (old.status === "success" || old.status === "cancelled" || old.status === "abandoned") { plans.push(old); continue; }
    // The assessed component disappeared because it rejoined or was destroyed.  A supplied
    // surviving region is the authoritative distinction; no target capture is assumed.
    const restored = restoredUnits(world, old);
    if (restored.units > 0) {
      old.actualRestoredStrength = restored.strength;
      old.actualRestoredUnits = restored.units;
      old.reconnectedTick ??= world.time.fastTick;
      old.stableSinceTick ??= world.time.fastTick;
      old.status = "stable";
      plans.push(old);
      state.naturalReconnections += 1;
      world.instrumentation?.incrementCounter("supplyRelief.naturalReconnections");
    } else {
      old.status = "abandoned";
      old.failureReason = "isolated-force-destroyed-or-no-longer-meaningful";
      state.abandoned += 1;
      world.instrumentation?.incrementCounter("supplyRelief.abandoned");
    }
  }
  for (const plan of plans) completeStablePlan(world, plan);
  state.needs = needs;
  state.plans = plans.sort((a, b) => b.score - a.score || compareIds(a.id, b.id));
  state.plansById = new Map(state.plans.map((plan) => [plan.id, plan]));
  state.version += 1;
  world.instrumentation?.recordDuration("supplyRelief.evaluation", performance.now() - startedAt);
}

export function getSupplyReliefPlanForFront(world: WorldState, nationId: NationId, frontId: FrontId): SupplyReliefPlan | undefined {
  return world.supplyRelief.plans.filter((plan) => plan.nationId === nationId && plan.sectorId === frontId &&
    (plan.status === "identified" || plan.status === "deferred")).sort((a, b) => b.score - a.score || compareIds(a.id, b.id))[0];
}

export function getSupplyReliefPlan(world: WorldState, id: string | null): SupplyReliefPlan | undefined {
  return id ? world.supplyRelief.plansById.get(id) : undefined;
}

export function markSupplyReliefOperation(world: WorldState, id: string, phase: "preparing" | "attacking", assignedUnitIds?: readonly UnitId[]): void {
  const plan = world.supplyRelief.plansById.get(id);
  if (!plan) return;
  if (plan.status !== phase) {
    plan.status = phase;
    plan.startedTick ??= world.time.fastTick;
    if (phase === "preparing") { world.supplyRelief.operationsCreated += 1; world.instrumentation?.incrementCounter("supplyRelief.operationsCreated"); }
    else { world.supplyRelief.attacksLaunched += 1; world.instrumentation?.incrementCounter("supplyRelief.attacksLaunched"); }
  }
  if (assignedUnitIds) plan.outsideForceUnitIds = assignedUnitIds.filter((unitId) => !plan.insideForceUnitIds.includes(unitId));
}

export function isSupplyReliefStillNeeded(world: WorldState, id: string): boolean {
  const plan = world.supplyRelief.plansById.get(id);
  return !!plan && (plan.status === "preparing" || plan.status === "attacking" || plan.status === "identified" || plan.status === "deferred");
}

function collectNeeds(world: WorldState): SupplyReliefNeed[] {
  const meso = getMesoById(world);
  const result: SupplyReliefNeed[] = [];
  for (const assessment of world.supplyAssessment.assessments) for (const component of assessment.components) {
    if (!component.isolated) continue;
    const units = world.units.filter((unit) => unit.domain === "land" && unit.nationId === assessment.nationId && component.regionIds.includes(unit.regionId));
    const strength = units.reduce((sum, unit) => sum + getUnitCombatStrength(unit), 0);
    const cities = component.regionIds.filter((id) => meso.get(id)?.building === "city").length;
    const ports = component.regionIds.filter((id) => meso.get(id)?.building === "port").length;
    const capitalInside = component.regionIds.some((id) => meso.get(id)?.building === "capital");
    const age = component.isolatedDuration;
    const meaningful = strength >= WORLD_BALANCE.war.landFront.supplyCutoff.minimumMeaningfulStrength || units.length >= WORLD_BALANCE.war.landFront.supplyCutoff.minimumMeaningfulUnits || cities > 0 || ports > 0 || capitalInside;
    if (!meaningful) continue;
    const flags: SupplyReliefReason[] = [];
    if (strength >= WORLD_BALANCE.war.landFront.supplyCutoff.majorStrengthThreshold) flags.push("major-force-isolated");
    if (units.some((unit) => unit.org < 0.55)) flags.push("organization-decay-active");
    if (cities) flags.push("city-isolated"); if (ports) flags.push("port-isolated"); if (capitalInside) flags.push("capital-isolated");
    if (age >= 30) flags.push("prolonged-isolation");
    if (units.some((unit) => world.landFronts.operationalSectors.some((front) => front.nationAId === unit.nationId || front.nationBId === unit.nationId))) flags.push("frontline-isolated");
    const severity: SupplyReliefSeverity = capitalInside || strength >= 8_000 || (strength >= 5_000 && age >= 30) ? "critical" : strength >= 3_000 || cities + ports > 0 ? "high" : strength >= 1_000 || units.length >= 3 ? "moderate" : "low";
    result.push({ id: `${assessment.nationId}::${component.id}`, nationId: assessment.nationId, isolatedComponentId: component.id,
      isolatedSinceTick: component.isolatedSinceTick ?? world.time.fastTick, isolatedStrength: strength, isolatedUnits: units.length,
      regionIds: [...component.regionIds], cities, ports, capitalInside, severity, reasonFlags: flags });
  }
  return result.sort((a, b) => severityScore(b.severity) - severityScore(a.severity) || b.isolatedStrength - a.isolatedStrength || compareIds(a.id, b.id));
}

function buildPlan(world: WorldState, need: SupplyReliefNeed): SupplyReliefPlan | undefined {
  const neighbors = getNeighborsById(world); const meso = getMesoById(world); const owners = getOwnerByMesoId(world);
  const isolated = new Set(need.regionIds); const assessment = world.supplyAssessment.assessmentByNationId.get(need.nationId);
  const candidates: Array<{ target: MesoRegionId; outer: MesoRegionId; inner: MesoRegionId; enemy: NationId; sector: FrontId; score: number }> = [];
  for (const inner of need.regionIds) for (const target of neighbors.get(inner) ?? []) {
    const enemy = effectiveOwner(world, owners, target); if (!enemy || enemy === need.nationId || meso.get(target)?.type === "sea") continue;
    const outer = (neighbors.get(target) ?? []).find((id) => !isolated.has(id) && effectiveOwner(world, owners, id) === need.nationId && assessment?.componentById.get(assessment.componentIdByRegionId.get(id) ?? ("" as SupplyComponentId))?.supplied);
    if (!outer) continue;
    const sector = world.landFronts.operationalSectors.find((front) =>
      ((front.nationAId === need.nationId && front.nationBId === enemy) || (front.nationBId === need.nationId && front.nationAId === enemy)) &&
      front.borderEdges.some((edge) => edge.regionAId === target || edge.regionBId === target),
    );
    if (!sector) continue;
    const defender = world.units.filter((unit) => unit.domain === "land" && unit.nationId === enemy && unit.regionId === target).reduce((sum, unit) => sum + getUnitCombatStrength(unit), 0);
    const score = need.isolatedStrength / 100 + severityScore(need.severity) * 12 + need.cities * 12 + need.ports * 14 - defender / 150;
    candidates.push({ target, outer, inner, enemy, sector: sector.id, score });
  }
  const best = candidates.sort((a, b) => b.score - a.score || compareIds(a.target, b.target))[0];
  if (!best) return undefined;
  const insideForceUnitIds = eligibleInsideUnits(world, need, best.target);
  return { id: `relief-${need.id}`, needId: need.id, nationId: need.nationId, enemyNationId: best.enemy, isolatedComponentId: need.isolatedComponentId,
    sectorId: best.sector, isolatedRegionIds: [...need.regionIds], objectiveRegionIds: [best.target], primaryReconnectionRegion: best.target, outsideApproachRegionId: best.outer, insideApproachRegionId: best.inner,
    expectedRestoredStrength: need.isolatedStrength, expectedRestoredUnits: need.isolatedUnits,
    routeType: need.ports > 0 ? "port-reconnection" : "corridor-retake", outsideForceUnitIds: [], insideForceUnitIds, score: best.score,
    status: "identified", createdTick: world.time.fastTick, startedTick: null, reconnectedTick: null, stableSinceTick: null, actualRestoredStrength: 0, actualRestoredUnits: 0, failureReason: null };
}

function eligibleInsideUnits(world: WorldState, need: SupplyReliefNeed, target: MesoRegionId): UnitId[] {
  const adjacent = new Set(getNeighborsById(world).get(target) ?? []);
  return world.units.filter((unit) => unit.domain === "land" && unit.nationId === need.nationId && need.regionIds.includes(unit.regionId) && adjacent.has(unit.regionId) && unit.org >= 0.35 && !world.retreatPlans.retreatIdByUnitId.has(unit.id) && !world.reorganization.planIdByUnitId.has(unit.id) && !world.offensiveOperations.operationIdByUnitId.has(unit.id)).sort((a, b) => getUnitCombatStrength(b) - getUnitCombatStrength(a) || compareIds(a.id, b.id)).slice(0, 4).map((unit) => unit.id);
}

function refreshPlan(world: WorldState, plan: SupplyReliefPlan, need: SupplyReliefNeed): void {
  const component = world.supplyAssessment.componentById.get(plan.isolatedComponentId);
  if (component?.supplied) { plan.reconnectedTick ??= world.time.fastTick; plan.stableSinceTick ??= world.time.fastTick; plan.status = "stable"; }
  if (plan.status === "identified" || plan.status === "deferred") { plan.expectedRestoredStrength = need.isolatedStrength; plan.expectedRestoredUnits = need.isolatedUnits; }
}

function completeStablePlan(world: WorldState, plan: SupplyReliefPlan): void {
  if (plan.status !== "stable" || plan.stableSinceTick === null) return;
  if (world.time.fastTick - plan.stableSinceTick < WORLD_BALANCE.war.landFront.supplyCutoff.sustainedTicks) return;
  plan.status = "success"; world.supplyRelief.successes += 1; world.supplyRelief.stableReconnections += 1;
  world.supplyRelief.restoredStrength += plan.actualRestoredStrength || plan.expectedRestoredStrength;
  world.supplyRelief.restoredUnits += plan.actualRestoredUnits || plan.expectedRestoredUnits;
  world.instrumentation?.incrementCounter("supplyRelief.success"); world.instrumentation?.incrementCounter("supplyRelief.stableReconnections");
}

function restoredUnits(world: WorldState, plan: SupplyReliefPlan): { strength: number; units: number } {
  const units = world.units.filter((unit) => unit.domain === "land" && unit.nationId === plan.nationId && world.supplyAssessment.assessmentByNationId.get(plan.nationId)?.componentById.get(world.supplyAssessment.assessmentByNationId.get(plan.nationId)?.componentIdByRegionId.get(unit.regionId) ?? ("" as SupplyComponentId))?.supplied);
  const initialRegions = new Set(plan.isolatedRegionIds);
  const relevant = units.filter((unit) => initialRegions.has(unit.regionId) || plan.insideForceUnitIds.includes(unit.id));
  return { units: relevant.length, strength: relevant.reduce((sum, unit) => sum + getUnitCombatStrength(unit), 0) };
}
function severityScore(value: SupplyReliefSeverity): number { return value === "critical" ? 4 : value === "high" ? 3 : value === "moderate" ? 2 : 1; }
function effectiveOwner(world: WorldState, owners: ReadonlyMap<MesoRegionId, NationId>, regionId: MesoRegionId): NationId | undefined {
  return world.occupation.mesoById.get(regionId) ?? owners.get(regionId);
}
function compareIds(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
