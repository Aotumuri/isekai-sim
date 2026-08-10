import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import { getMoveMsPerRegion } from "./movement";
import type { MaritimeSupplyLink } from "./maritime-supply";
import { isOperationalCombatShip } from "./maritime-escort";
import { buildNavalPositioningRoute } from "./naval-pathfinding";
import type { UnitId, UnitState } from "./unit";
import type { WorldState } from "./world-state";
import { getMesoById, getNeighborsById } from "./world-cache";
import { buildWarAdjacency, isAtWar } from "./war-state";

export interface TargetPriority {
  remoteSuppliedStrength: number;
  frontlineUnits: number;
  cities: number;
  capitalRelevance: number;
  activeOperations: number;
  reorganization: number;
  supplyCutoffImportance: number;
  routeLength: number;
  protectionState: number;
  total: number;
  reasons: string[];
}

export interface InterdictionAssessment {
  attackerNationId: NationId;
  maritimeLinkId: string;
  defenderNationId: NationId;
  targetPriority: TargetPriority;
  routeRegionIds: MesoRegionId[];
  interdicted: boolean;
  evaluatedAtTick: number;
}

export type RaidAssignmentStatus = "assigned" | "moving-to-route" | "intercepting" | "raiding" | "unavailable";

export interface RaidAssignment {
  combatShipId: UnitId;
  attackerNationId: NationId;
  maritimeLinkId: string;
  defenderNationId: NationId;
  targetScore: number;
  targetReason: string;
  routeRegionIds: MesoRegionId[];
  positioningRouteIds: MesoRegionId[];
  status: RaidAssignmentStatus;
  assignedTick: number;
}

export interface RaidState {
  version: number;
  assessments: InterdictionAssessment[];
  assignments: RaidAssignment[];
  assignmentByCombatShipId: Map<UnitId, RaidAssignment>;
  assignmentsByLinkId: Map<string, RaidAssignment[]>;
  interdictedLinkIds: Set<string>;
  interdictedSinceTickByLinkId: Map<string, number>;
  previousActiveByLinkId: Map<string, boolean>;
  interruptedSinceTickByLinkId: Map<string, number>;
  trackedTransportLinkById: Map<UnitId, string>;
  destroyedTransportIds: Set<UnitId>;
  activeEscortEngagementKeys: Set<string>;
  linksEvaluated: number;
  raidCandidates: number;
  assignmentChanges: number;
  escortEngagements: number;
  transportsDestroyed: number;
  routesInterdicted: number;
  supplyInterruptions: number;
  totalInterruptionDurationTicks: number;
  completedInterruptions: number;
  reconnections: number;
  evaluationCpuMs: number;
  pathfindingCpuMs: number;
}

export function createRaidState(): RaidState {
  return {
    version: 0,
    assessments: [],
    assignments: [],
    assignmentByCombatShipId: new Map(),
    assignmentsByLinkId: new Map(),
    interdictedLinkIds: new Set(),
    interdictedSinceTickByLinkId: new Map(),
    previousActiveByLinkId: new Map(),
    interruptedSinceTickByLinkId: new Map(),
    trackedTransportLinkById: new Map(),
    destroyedTransportIds: new Set(),
    activeEscortEngagementKeys: new Set(),
    linksEvaluated: 0,
    raidCandidates: 0,
    assignmentChanges: 0,
    escortEngagements: 0,
    transportsDestroyed: 0,
    routesInterdicted: 0,
    supplyInterruptions: 0,
    totalInterruptionDurationTicks: 0,
    completedInterruptions: 0,
    reconnections: 0,
    evaluationCpuMs: 0,
    pathfindingCpuMs: 0,
  };
}

/** Evaluates only existing enemy MaritimeSupplyLinks; it does not build connectivity. */
export function updateMaritimeInterdictionAssignments(
  world: WorldState,
  links: MaritimeSupplyLink[],
): void {
  const startedAt = world.instrumentation ? performance.now() : 0;
  const state = world.supplyAssessment.maritimeInterdiction;
  updateInterruptionHistory(world, links);
  const warAdjacency = buildWarAdjacency(world.wars);
  const previous = state.assignments;
  const previousByShipId = new Map(previous.map((assignment) => [assignment.combatShipId, assignment]));
  const previousRaidLinkIds = new Set(previous.map((assignment) => assignment.maritimeLinkId));
  const linkById = new Map(links.map((link) => [link.id, link]));
  const escortIds = new Set(world.supplyAssessment.maritimeEscorts.assignments.map((item) => item.combatShipId));
  const ships = world.units
    .filter((unit) => isOperationalCombatShip(unit) && !escortIds.has(unit.id))
    .sort((a, b) => compareIds(a.id, b.id));
  const contexts = createPriorityContext(world, links);
  const assessments: InterdictionAssessment[] = [];
  const assessmentsByAttacker = new Map<NationId, InterdictionAssessment[]>();

  for (const ship of ships) {
    if (assessmentsByAttacker.has(ship.nationId)) continue;
    const nationAssessments = links
      .filter((link) =>
        link.routeRegionIds.some((regionId) => getMesoById(world).get(regionId)?.type === "sea") &&
        link.reason !== "port-lost" && link.reason !== "route-invalid" &&
        isAtWar(ship.nationId, link.nationId, warAdjacency) &&
        (link.active || previousRaidLinkIds.has(link.id))
      )
      .map((link): InterdictionAssessment => ({
        attackerNationId: ship.nationId,
        maritimeLinkId: link.id,
        defenderNationId: link.nationId,
        targetPriority: scoreTarget(world, link, contexts),
        routeRegionIds: [...link.routeRegionIds],
        interdicted: state.interdictedLinkIds.has(link.id),
        evaluatedAtTick: world.time.fastTick,
      }))
      .sort((a, b) => b.targetPriority.total - a.targetPriority.total || compareIds(a.maritimeLinkId, b.maritimeLinkId));
    assessmentsByAttacker.set(ship.nationId, nationAssessments);
    assessments.push(...nationAssessments);
  }

  const next: RaidAssignment[] = [];
  for (const ship of ships) {
    const candidates = assessmentsByAttacker.get(ship.nationId) ?? [];
    const old = previousByShipId.get(ship.id);
    const existing = old && candidates.find((item) => item.maritimeLinkId === old.maritimeLinkId);
    const selected = existing ?? [...candidates].sort((a, b) =>
      distanceToRouteSquared(world, ship, a.routeRegionIds) - distanceToRouteSquared(world, ship, b.routeRegionIds) ||
      b.targetPriority.total - a.targetPriority.total ||
      compareIds(a.maritimeLinkId, b.maritimeLinkId)
    )[0];
    if (!selected) continue;
    const link = linkById.get(selected.maritimeLinkId);
    if (!link) continue;
    next.push(createOrRefreshRaidAssignment(world, ship, selected, old));
  }

  const nextKeys = new Set(next.map(assignmentKey));
  const previousKeys = new Set(previous.map(assignmentKey));
  for (const key of nextKeys) if (!previousKeys.has(key)) state.assignmentChanges += 1;
  for (const key of previousKeys) if (!nextKeys.has(key)) state.assignmentChanges += 1;
  for (const assignment of previous) {
    if (next.some((item) => item.combatShipId === assignment.combatShipId)) continue;
    const ship = world.units.find((unit) => unit.id === assignment.combatShipId);
    if (ship && !escortIds.has(ship.id)) resetMovement(ship);
  }

  state.assessments = assessments;
  state.assignments = next;
  state.assignmentByCombatShipId = new Map(next.map((assignment) => [assignment.combatShipId, assignment]));
  state.assignmentsByLinkId = groupAssignmentsByLink(next);
  state.version += 1;
  state.linksEvaluated += assessments.length;
  state.raidCandidates += assessments.length;
  state.trackedTransportLinkById = new Map(
    links.flatMap((link) => link.assignedTransportIds.map((id) => [id, link.id] as const)),
  );
  updateMaritimeInterdictionState(world);
  recordMetrics(world);
  if (world.instrumentation) {
    const elapsed = performance.now() - startedAt;
    state.evaluationCpuMs += elapsed;
    world.instrumentation.recordDuration("maritimeInterdiction.evaluation", elapsed);
  }
}

/** Raid-only movement toward the assigned route. No fallback roaming is permitted. */
export function updateMaritimeInterdictionMovement(world: WorldState, dtMs: number): void {
  const state = world.supplyAssessment.maritimeInterdiction;
  if (state.assignments.length === 0) return;
  const unitById = new Map(world.units.map((unit) => [unit.id, unit]));
  const neighborsById = getNeighborsById(world);
  for (const assignment of state.assignments) {
    const unit = unitById.get(assignment.combatShipId);
    if (!isOperationalCombatShip(unit, assignment.attackerNationId)) continue;
    const convoy = world.supplyAssessment.convoys.convoyByLinkId.get(assignment.maritimeLinkId);
    const transport = convoy?.transportId ? unitById.get(convoy.transportId) : undefined;
    if (transport && unit.regionId === transport.regionId) {
      assignment.status = "raiding";
      resetMovement(unit);
      continue;
    }
    const routeIndex = assignment.routeRegionIds.indexOf(unit.regionId);
    if (routeIndex >= 0 && getMesoById(world).get(unit.regionId)?.type === "sea") {
      const transportIndex = transport ? assignment.routeRegionIds.indexOf(transport.regionId) : -1;
      const targetIndex = transportIndex <= 0 ? 1
        : transportIndex >= assignment.routeRegionIds.length - 1
          ? assignment.routeRegionIds.length - 2
          : transportIndex;
      const nextIndex = routeIndex === targetIndex ? routeIndex : routeIndex + Math.sign(targetIndex - routeIndex);
      const nextId = assignment.routeRegionIds[nextIndex];
      assignment.status = "intercepting";
      if (nextId === unit.regionId || !(neighborsById.get(unit.regionId) ?? []).includes(nextId)) {
        resetMovement(unit);
        continue;
      }
      moveRaiderOneStep(world, unit, nextId, dtMs);
      if (transport && unit.regionId === transport.regionId) assignment.status = "raiding";
      continue;
    }
    const currentIndex = assignment.positioningRouteIds.indexOf(unit.regionId);
    const nextId = currentIndex >= 0 ? assignment.positioningRouteIds[currentIndex + 1] : undefined;
    if (!nextId || !(neighborsById.get(unit.regionId) ?? []).includes(nextId)) {
      assignment.status = "unavailable";
      resetMovement(unit);
      continue;
    }
    if (unit.moveToId !== nextId) {
      unit.moveFromId = unit.regionId;
      unit.moveToId = nextId;
      unit.moveTargetId = assignment.positioningRouteIds.at(-1) ?? null;
      unit.moveProgressMs = 0;
    }
    moveRaiderOneStep(world, unit, nextId, dtMs);
    if (isOnSeaRoute(world, unit.regionId, assignment.routeRegionIds)) {
      assignment.status = "intercepting";
      resetMovement(unit);
    }
  }
  updateMaritimeInterdictionState(world);
}

export function updateMaritimeInterdictionState(world: WorldState): void {
  const state = world.supplyAssessment.maritimeInterdiction;
  const unitById = new Map(world.units.map((unit) => [unit.id, unit]));
  const next = new Set<string>();
  for (const assignment of state.assignments) {
    const ship = unitById.get(assignment.combatShipId);
    const convoy = world.supplyAssessment.convoys.convoyByLinkId.get(assignment.maritimeLinkId);
    const transport = convoy?.transportId ? unitById.get(convoy.transportId) : undefined;
    if (isOperationalCombatShip(ship, assignment.attackerNationId) &&
      !!transport && ship.regionId === transport.regionId) {
      next.add(assignment.maritimeLinkId);
    }
  }
  const changed = next.size !== state.interdictedLinkIds.size ||
    [...next].some((linkId) => !state.interdictedLinkIds.has(linkId));
  for (const linkId of next) {
    if (state.interdictedLinkIds.has(linkId)) continue;
    state.routesInterdicted += 1;
    state.interdictedSinceTickByLinkId.set(linkId, world.time.fastTick);
    world.instrumentation?.incrementCounter("maritimeInterdiction.routesInterdicted");
  }
  for (const linkId of state.interdictedLinkIds) {
    if (!next.has(linkId)) state.interdictedSinceTickByLinkId.delete(linkId);
  }
  state.interdictedLinkIds = next;
  if (changed) state.version += 1;
  for (const assessment of state.assessments) {
    assessment.interdicted = next.has(assessment.maritimeLinkId);
  }
}

/** Records outcomes produced by the existing naval combat resolver. */
export function recordMaritimeInterdictionCombat(world: WorldState): void {
  const state = world.supplyAssessment.maritimeInterdiction;
  const aliveIds = new Set(world.units.map((unit) => unit.id));
  for (const [transportId, linkId] of state.trackedTransportLinkById) {
    if (aliveIds.has(transportId) || state.destroyedTransportIds.has(transportId)) continue;
    if (!state.interdictedLinkIds.has(linkId) && !state.assignmentsByLinkId.has(linkId)) continue;
    state.destroyedTransportIds.add(transportId);
    state.transportsDestroyed += 1;
    world.instrumentation?.incrementCounter("maritimeInterdiction.transportsDestroyed");
  }

  const unitById = new Map(world.units.map((unit) => [unit.id, unit]));
  const escortByLink = world.supplyAssessment.maritimeEscorts.assignmentByLinkId;
  const engagementKeys = new Set<string>();
  for (const raid of state.assignments) {
    const raider = unitById.get(raid.combatShipId);
    const escortAssignment = escortByLink.get(raid.maritimeLinkId);
    const escort = escortAssignment ? unitById.get(escortAssignment.combatShipId) : undefined;
    if (!raider || !escort || raider.regionId !== escort.regionId) continue;
    const key = `${raid.combatShipId}:${escort.id}:${raid.maritimeLinkId}`;
    engagementKeys.add(key);
    if (!state.activeEscortEngagementKeys.has(key)) {
      state.escortEngagements += 1;
      world.instrumentation?.incrementCounter("maritimeInterdiction.escortEngagements");
    }
  }
  state.activeEscortEngagementKeys = engagementKeys;
  const interceptionKeys = new Set<string>();
  for (const raid of state.assignments) {
    const raider = unitById.get(raid.combatShipId);
    const convoy = world.supplyAssessment.convoys.convoyByLinkId.get(raid.maritimeLinkId);
    const transport = convoy?.transportId ? unitById.get(convoy.transportId) : undefined;
    if (!raider || !transport || raider.regionId !== transport.regionId) continue;
    const key = `${raid.combatShipId}:${convoy?.id ?? raid.maritimeLinkId}`;
    interceptionKeys.add(key);
    if (!world.supplyAssessment.convoys.activeInterceptionKeys.has(key)) {
      world.supplyAssessment.convoys.raidInterceptions += 1;
    }
  }
  world.supplyAssessment.convoys.activeInterceptionKeys = interceptionKeys;
  updateMaritimeInterdictionState(world);
}

export function getMaritimeMissionUnitIds(world: WorldState): Set<UnitId> {
  return new Set([
    ...world.supplyAssessment.maritimeLogistics.assignments.map((item) => item.transportId),
    ...world.supplyAssessment.maritimeEscorts.assignments.map((item) => item.combatShipId),
    ...world.supplyAssessment.maritimeInterdiction.assignments.map((item) => item.combatShipId),
  ]);
}

function createPriorityContext(world: WorldState, links: MaritimeSupplyLink[]) {
  const frontlineIds = new Set(world.landFronts.operationalSectors.flatMap((sector) => [
    ...sector.sideA.borderRegionIds, ...sector.sideB.borderRegionIds,
  ]));
  const reorganizingIds = new Set(world.reorganization.plans.map((plan) => plan.unitId));
  const incomingCount = new Map<string, number>();
  for (const link of links) {
    if (!link.destinationLandComponentId) continue;
    incomingCount.set(link.destinationLandComponentId, (incomingCount.get(link.destinationLandComponentId) ?? 0) + 1);
  }
  return { frontlineIds, reorganizingIds, incomingCount };
}

function scoreTarget(
  world: WorldState,
  link: MaritimeSupplyLink,
  context: ReturnType<typeof createPriorityContext>,
): TargetPriority {
  const component = link.destinationLandComponentId
    ? world.supplyAssessment.componentById.get(link.destinationLandComponentId)
    : undefined;
  const regionIds = new Set(component?.regionIds ?? []);
  const units = world.units.filter((unit) => unit.domain === "land" && unit.nationId === link.nationId && regionIds.has(unit.regionId));
  const remoteSuppliedStrength = Math.round((component?.strength ?? 0) * 10) / 10;
  const frontlineUnits = units.filter((unit) => context.frontlineIds.has(unit.regionId)).length;
  const cities = [...regionIds].filter((id) => getMesoById(world).get(id)?.building === "city").length;
  const capitalRelevance = [...regionIds].some((id) => getMesoById(world).get(id)?.building === "capital") ? 1 : 0;
  const activeOperations = world.offensiveOperations.operations.filter((operation) =>
    operation.nationId === link.nationId && operation.assignedUnitIds.some((id) => units.some((unit) => unit.id === id))
  ).length;
  const reorganization = units.filter((unit) => context.reorganizingIds.has(unit.id)).length;
  const supplyCutoffImportance = link.destinationLandComponentId &&
    (context.incomingCount.get(link.destinationLandComponentId) ?? 0) === 1 ? 1 : 0;
  const routeLength = Math.max(0, link.routeRegionIds.length - 1);
  const protection = world.supplyAssessment.maritimeEscorts.protectionByLinkId.get(link.id)?.protectionState ?? "UNPROTECTED";
  const protectionState = protection === "UNPROTECTED" ? 2 : protection === "PARTIALLY_PROTECTED" ? 1 : 0;
  const total = remoteSuppliedStrength * 0.02 + frontlineUnits * 30 + cities * 20 +
    capitalRelevance * 80 + activeOperations * 35 + reorganization * 12 +
    supplyCutoffImportance * 45 + routeLength * 2 + protectionState * 15;
  const reasons = [
    remoteSuppliedStrength > 0 && `remote strength ${remoteSuppliedStrength.toFixed(1)}×0.02`,
    frontlineUnits > 0 && `frontline ${frontlineUnits}×30`,
    cities > 0 && `cities ${cities}×20`,
    capitalRelevance > 0 && "capital ×80",
    activeOperations > 0 && `operations ${activeOperations}×35`,
    reorganization > 0 && `reorganization ${reorganization}×12`,
    supplyCutoffImportance > 0 && "sole supply entry ×45",
    routeLength > 0 && `route ${routeLength}×2`,
    `${protection.toLowerCase()} ×${protectionState * 15}`,
  ].filter((reason): reason is string => !!reason);
  return { remoteSuppliedStrength, frontlineUnits, cities, capitalRelevance, activeOperations,
    reorganization, supplyCutoffImportance, routeLength, protectionState, total, reasons };
}

function createOrRefreshRaidAssignment(
  world: WorldState,
  ship: UnitState,
  assessment: InterdictionAssessment,
  old: RaidAssignment | undefined,
): RaidAssignment {
  const same = old?.maritimeLinkId === assessment.maritimeLinkId;
  const convoy = world.supplyAssessment.convoys.convoyByLinkId.get(assessment.maritimeLinkId);
  const transport = convoy?.transportId
    ? world.units.find((unit) => unit.id === convoy.transportId)
    : undefined;
  const onRoute = isOnSeaRoute(world, ship.regionId, assessment.routeRegionIds);
  const intercepting = !!transport && ship.regionId === transport.regionId;
  let positioningRouteIds = same ? old.positioningRouteIds : [];
  if (!onRoute && (!same || positioningRouteIds.length === 0 || !positioningRouteIds.includes(ship.regionId))) {
    const startedAt = world.instrumentation ? performance.now() : 0;
    positioningRouteIds = buildNavalPositioningRoute(world, ship.regionId, assessment.routeRegionIds, true);
    world.instrumentation?.incrementCounter("maritimeInterdiction.pathfindingRequests");
    if (world.instrumentation) {
      const elapsed = performance.now() - startedAt;
      world.supplyAssessment.maritimeInterdiction.pathfindingCpuMs += elapsed;
      world.instrumentation.recordDuration("maritimeInterdiction.pathfinding", elapsed);
    }
  }
  return {
    combatShipId: ship.id,
    attackerNationId: ship.nationId,
    maritimeLinkId: assessment.maritimeLinkId,
    defenderNationId: assessment.defenderNationId,
    targetScore: assessment.targetPriority.total,
    targetReason: assessment.targetPriority.reasons.join("; "),
    routeRegionIds: [...assessment.routeRegionIds],
    positioningRouteIds,
    status: intercepting ? "raiding" : onRoute ? "intercepting" : positioningRouteIds.length > 1 ? "moving-to-route" : "unavailable",
    assignedTick: same ? old.assignedTick : world.time.fastTick,
  };
}

function updateInterruptionHistory(world: WorldState, links: MaritimeSupplyLink[]): void {
  const state = world.supplyAssessment.maritimeInterdiction;
  const currentIds = new Set(links.map((link) => link.id));
  for (const link of links) {
    const previousActive = state.previousActiveByLinkId.get(link.id);
    if (previousActive === true && !link.active && link.reason === "no-transport" &&
      (state.interdictedLinkIds.has(link.id) || state.assignmentsByLinkId.has(link.id))) {
      state.supplyInterruptions += 1;
      state.interruptedSinceTickByLinkId.set(link.id, world.time.fastTick);
      world.instrumentation?.incrementCounter("maritimeInterdiction.supplyInterruptions");
    } else if (previousActive === false && link.active && state.interruptedSinceTickByLinkId.has(link.id)) {
      const started = state.interruptedSinceTickByLinkId.get(link.id) ?? world.time.fastTick;
      state.totalInterruptionDurationTicks += Math.max(0, world.time.fastTick - started);
      state.completedInterruptions += 1;
      state.reconnections += 1;
      state.interruptedSinceTickByLinkId.delete(link.id);
      world.instrumentation?.incrementCounter("maritimeInterdiction.reconnections");
    }
    state.previousActiveByLinkId.set(link.id, link.active);
  }
  for (const linkId of [...state.previousActiveByLinkId.keys()]) {
    if (!currentIds.has(linkId)) state.previousActiveByLinkId.delete(linkId);
  }
}

function recordMetrics(world: WorldState): void {
  const state = world.supplyAssessment.maritimeInterdiction;
  world.instrumentation?.incrementCounter("maritimeInterdiction.linksEvaluated", state.assessments.length);
  world.instrumentation?.incrementCounter("maritimeInterdiction.raidCandidates", state.assessments.length);
  world.instrumentation?.incrementCounter("maritimeInterdiction.raidAssignments", state.assignments.length);
  world.instrumentation?.incrementCounter("maritimeInterdiction.routesCurrentlyInterdicted", state.interdictedLinkIds.size);
}

function moveRaiderOneStep(
  world: WorldState,
  unit: UnitState,
  nextId: MesoRegionId,
  dtMs: number,
): void {
  if (unit.moveToId !== nextId) {
    unit.moveFromId = unit.regionId;
    unit.moveToId = nextId;
    unit.moveTargetId = nextId;
    unit.moveProgressMs = 0;
  }
  unit.moveProgressMs += Math.max(0, dtMs);
  if (unit.moveProgressMs < getMoveMsPerRegion(unit)) return;
  unit.regionId = nextId;
  unit.moveProgressMs = 0;
  unit.moveFromId = null;
  unit.moveToId = null;
  world.instrumentation?.incrementCounter("maritimeInterdiction.regionArrivals");
}

function groupAssignmentsByLink(assignments: RaidAssignment[]): Map<string, RaidAssignment[]> {
  const result = new Map<string, RaidAssignment[]>();
  for (const assignment of assignments) {
    const current = result.get(assignment.maritimeLinkId);
    if (current) current.push(assignment);
    else result.set(assignment.maritimeLinkId, [assignment]);
  }
  return result;
}

function distanceToRouteSquared(world: WorldState, ship: UnitState, route: readonly MesoRegionId[]): number {
  const start = getMesoById(world).get(ship.regionId)?.center;
  if (!start) return Number.MAX_SAFE_INTEGER;
  let best = Number.MAX_SAFE_INTEGER;
  for (const id of route) {
    const region = getMesoById(world).get(id);
    if (region?.type !== "sea") continue;
    const dx = start.x - region.center.x;
    const dy = start.y - region.center.y;
    best = Math.min(best, dx * dx + dy * dy);
  }
  return best;
}

function isOnSeaRoute(world: WorldState, regionId: MesoRegionId, route: readonly MesoRegionId[]): boolean {
  return route.includes(regionId) && getMesoById(world).get(regionId)?.type === "sea";
}

function resetMovement(unit: UnitState): void {
  unit.moveTargetId = null;
  unit.moveFromId = null;
  unit.moveToId = null;
  unit.moveProgressMs = 0;
}

function assignmentKey(assignment: RaidAssignment): string {
  return `${assignment.combatShipId}:${assignment.maritimeLinkId}`;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
