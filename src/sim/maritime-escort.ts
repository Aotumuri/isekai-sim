import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import { getMoveMsPerRegion } from "./movement";
import type { MaritimeSupplyLink } from "./maritime-supply";
import type { SupplyComponentId } from "./supply-assessment";
import type { UnitId, UnitState } from "./unit";
import type { WorldState } from "./world-state";
import { getMesoById, getNeighborsById } from "./world-cache";
import { buildNavalPositioningRoute } from "./naval-pathfinding";

export type EscortAssignmentStatus =
  | "assigned"
  | "moving-to-route"
  | "escorting"
  | "unavailable";

export interface EscortAssignment {
  combatShipId: UnitId;
  maritimeLinkId: string;
  nationId: NationId;
  routeRegionIds: MesoRegionId[];
  status: EscortAssignmentStatus;
  assignedTick: number;
  positioningRouteIds: MesoRegionId[];
}

export type MaritimeProtectionState =
  | "UNPROTECTED"
  | "PARTIALLY_PROTECTED"
  | "PROTECTED";

export type EscortSkippedReason =
  | "no-escort-demand"
  | "no-escort-available"
  | "escort-moving"
  | "link-inactive";

export interface MaritimeLinkProtection {
  linkId: string;
  assignedEscortIds: UnitId[];
  requiredEscortCount: number;
  protectionState: MaritimeProtectionState;
  skippedReason: EscortSkippedReason | null;
}

export interface EscortDemand {
  maritimeLinkId: string;
  nationId: NationId;
  requiredEscortCount: number;
  remoteUnitCount: number;
  remoteStrength: number;
  priority: readonly number[];
  reasons: string[];
}

export interface MaritimeEscortState {
  demands: EscortDemand[];
  assignments: EscortAssignment[];
  assignmentByCombatShipId: Map<UnitId, EscortAssignment>;
  assignmentByLinkId: Map<string, EscortAssignment>;
  protectionByLinkId: Map<string, MaritimeLinkProtection>;
  assignmentChanges: number;
  movementRequests: number;
  totalArrivalLatencyTicks: number;
  completedArrivals: number;
  escortLosses: number;
  assignmentsReleasedAfterLinkRemoval: number;
  combatShipsProducedForEscortDemand: number;
}

interface EscortDemandContext {
  landUnitsByComponentId: Map<SupplyComponentId, UnitState[]>;
  frontlineRegionIds: Set<MesoRegionId>;
  reorganizingUnitIds: Set<UnitId>;
  valuableDownstreamCountByComponentId: Map<SupplyComponentId, number>;
}

export function createMaritimeEscortState(): MaritimeEscortState {
  return {
    demands: [],
    assignments: [],
    assignmentByCombatShipId: new Map(),
    assignmentByLinkId: new Map(),
    protectionByLinkId: new Map(),
    assignmentChanges: 0,
    movementRequests: 0,
    totalArrivalLatencyTicks: 0,
    completedArrivals: 0,
    escortLosses: 0,
    assignmentsReleasedAfterLinkRemoval: 0,
    combatShipsProducedForEscortDemand: 0,
  };
}

export function isOperationalCombatShip(
  unit: UnitState | undefined,
  nationId?: NationId,
): unit is UnitState {
  return !!unit &&
    unit.domain === "naval" &&
    unit.type === "CombatShip" &&
    unit.manpower > 0 &&
    unit.org > 0 &&
    (!nationId || unit.nationId === nationId);
}

export function getEscortAssignment(
  world: WorldState,
  combatShipId: UnitId,
): EscortAssignment | undefined {
  return world.supplyAssessment.maritimeEscorts.assignmentByCombatShipId.get(combatShipId);
}

export function getEscortsForLink(world: WorldState, linkId: string): UnitState[] {
  const ids = world.supplyAssessment.maritimeEscorts.assignments
    .filter((assignment) => assignment.maritimeLinkId === linkId)
    .map((assignment) => assignment.combatShipId);
  return world.units.filter((unit) => ids.includes(unit.id) && isOperationalCombatShip(unit));
}

export function getMaritimeLinkProtection(
  world: WorldState,
  linkId: string,
): MaritimeLinkProtection {
  return world.supplyAssessment.maritimeEscorts.protectionByLinkId.get(linkId) ?? {
    linkId,
    assignedEscortIds: [],
    requiredEscortCount: 0,
    protectionState: "UNPROTECTED",
    skippedReason: "no-escort-demand",
  };
}

export function updateMaritimeEscortAssignments(
  world: WorldState,
  links: MaritimeSupplyLink[],
): void {
  const state = world.supplyAssessment.maritimeEscorts;
  if (links.length === 0 && state.assignments.length === 0 && state.demands.length === 0) {
    state.protectionByLinkId.clear();
    return;
  }
  const startedAt = world.instrumentation ? performance.now() : 0;
  const previous = state.assignments;
  const previousByLinkId = new Map<string, EscortAssignment[]>();
  for (const assignment of previous) {
    const assignments = previousByLinkId.get(assignment.maritimeLinkId);
    if (assignments) assignments.push(assignment);
    else previousByLinkId.set(assignment.maritimeLinkId, [assignment]);
  }
  const unitById = new Map(world.units.map((unit) => [unit.id, unit]));
  const demandContext = createEscortDemandContext(world, links);
  const demands = links
    .map((link) => buildEscortDemand(world, link, demandContext))
    .filter((demand): demand is EscortDemand => !!demand)
    .sort(compareEscortDemand);
  const combatShips = world.units
    .filter((unit) => isOperationalCombatShip(unit))
    .sort((a, b) => compareIds(a.id, b.id));
  const combatShipsByNation = new Map<NationId, UnitState[]>();
  const combatShipsByRegion = new Map<MesoRegionId, UnitState[]>();
  for (const ship of combatShips) {
    const nationShips = combatShipsByNation.get(ship.nationId);
    if (nationShips) nationShips.push(ship);
    else combatShipsByNation.set(ship.nationId, [ship]);
    const regionShips = combatShipsByRegion.get(ship.regionId);
    if (regionShips) regionShips.push(ship);
    else combatShipsByRegion.set(ship.regionId, [ship]);
  }
  const availableIds = new Set(combatShips.map((unit) => unit.id));
  const next: EscortAssignment[] = [];
  const linkById = new Map(links.map((link) => [link.id, link]));
  const neighborsById = getNeighborsById(world);

  for (const demand of demands) {
    const link = linkById.get(demand.maritimeLinkId);
    if (!link) continue;
    const oldAssignments = previousByLinkId.get(link.id) ?? [];
    for (let escortIndex = 0; escortIndex < demand.requiredEscortCount; escortIndex += 1) {
      const old = oldAssignments[escortIndex];
      let ship = old && availableIds.has(old.combatShipId)
        ? unitById.get(old.combatShipId)
        : undefined;
      if (!isOperationalCombatShip(ship, link.nationId)) {
        const atDistance = (regionIds: Iterable<MesoRegionId>): UnitState | undefined =>
          [...new Set(regionIds)].flatMap((regionId) => combatShipsByRegion.get(regionId) ?? [])
            .filter((candidate) =>
              candidate.nationId === link.nationId && availableIds.has(candidate.id)
            ).sort((a, b) => compareIds(a.id, b.id))[0];
        const onRoute = atDistance(link.routeRegionIds);
        const adjacentToRoute = onRoute ? undefined : atDistance(
          link.routeRegionIds.flatMap((regionId) => neighborsById.get(regionId) ?? []),
        );
        ship = onRoute ?? adjacentToRoute ?? combatShipsByNation.get(link.nationId)
          ?.find((candidate) => availableIds.has(candidate.id));
      }
      if (!ship) break;
      availableIds.delete(ship.id);
      next.push(createOrRefreshAssignment(world, link, ship, old));
    }
  }

  reconcileAssignments(world, links, previous, next, unitById);
  state.demands = demands;
  state.assignments = next;
  state.assignmentByCombatShipId = new Map(next.map((assignment) => [assignment.combatShipId, assignment]));
  state.assignmentByLinkId = new Map(next.map((assignment) => [assignment.maritimeLinkId, assignment]));
  rebuildProtectionState(world, links);
  recordEscortMetrics(world, combatShips.length);
  if (world.instrumentation) {
    world.instrumentation.recordDuration("maritimeEscort.evaluation", performance.now() - startedAt);
  }
}

/** Escort-only movement. It never chooses roaming or offensive naval targets. */
export function updateMaritimeEscortMovement(world: WorldState, dtMs: number): void {
  const state = world.supplyAssessment.maritimeEscorts;
  if (state.assignments.length === 0) return;
  const unitById = new Map(world.units.map((unit) => [unit.id, unit]));
  const neighborsById = getNeighborsById(world);
  let protectionDirty = false;
  for (const assignment of state.assignments) {
    const unit = unitById.get(assignment.combatShipId);
    if (!isOperationalCombatShip(unit, assignment.nationId) || assignment.status === "escorting") continue;
    const transport = getAssignedTransport(world, assignment.maritimeLinkId);
    if (transport && unit.regionId === transport.regionId) {
      completeEscortArrival(world, unit, assignment);
      protectionDirty = true;
      continue;
    }
    const currentIndex = assignment.positioningRouteIds.indexOf(unit.regionId);
    const nextId = currentIndex >= 0 ? assignment.positioningRouteIds[currentIndex + 1] : undefined;
    if (!nextId || !(neighborsById.get(unit.regionId) ?? []).includes(nextId)) {
      assignment.status = "unavailable";
      resetMovement(unit);
      protectionDirty = true;
      continue;
    }
    if (unit.moveToId !== nextId) {
      unit.moveFromId = unit.regionId;
      unit.moveToId = nextId;
      unit.moveTargetId = assignment.positioningRouteIds.at(-1) ?? null;
      unit.moveProgressMs = 0;
    }
    unit.moveProgressMs += Math.max(0, dtMs);
    const moveMs = getMoveMsPerRegion(unit);
    if (unit.moveProgressMs < moveMs) continue;
    unit.regionId = nextId;
    unit.moveProgressMs = Math.max(0, unit.moveProgressMs - moveMs);
    unit.moveFromId = null;
    unit.moveToId = null;
    world.instrumentation?.incrementCounter("maritimeEscort.regionArrivals");
    if (transport && unit.regionId === transport.regionId) {
      completeEscortArrival(world, unit, assignment);
      protectionDirty = true;
    }
  }
  if (protectionDirty) rebuildProtectionState(world, world.supplyAssessment.maritimeLinks);
}

function createEscortDemandContext(
  world: WorldState,
  links: MaritimeSupplyLink[],
): EscortDemandContext {
  const landUnitsByComponentId = new Map<SupplyComponentId, UnitState[]>();
  for (const unit of world.units) {
    if (unit.domain !== "land") continue;
    const componentId = world.supplyAssessment.assessmentByNationId.get(unit.nationId)
      ?.componentIdByRegionId.get(unit.regionId);
    if (!componentId) continue;
    const units = landUnitsByComponentId.get(componentId);
    if (units) units.push(unit);
    else landUnitsByComponentId.set(componentId, [unit]);
  }
  const frontlineRegionIds = new Set(world.landFronts.operationalSectors.flatMap((sector) => [
    ...sector.sideA.borderRegionIds,
    ...sector.sideB.borderRegionIds,
  ]));
  const reorganizingUnitIds = new Set(world.reorganization.plans.map((plan) => plan.unitId));
  const valuableDownstreamCountByComponentId = new Map<SupplyComponentId, number>();
  for (const link of links) {
    if (!link.active || !link.sourceLandComponentId || !link.destinationLandComponentId) continue;
    const downstream = world.supplyAssessment.componentById.get(link.destinationLandComponentId);
    if (!downstream) continue;
    const strategicallyValuable = downstream.strength > 0 || downstream.regionIds.some((regionId) => {
      const building = getMesoById(world).get(regionId)?.building;
      return building === "city" || building === "capital";
    });
    if (!strategicallyValuable) continue;
    valuableDownstreamCountByComponentId.set(
      link.sourceLandComponentId,
      (valuableDownstreamCountByComponentId.get(link.sourceLandComponentId) ?? 0) + 1,
    );
  }
  return {
    landUnitsByComponentId,
    frontlineRegionIds,
    reorganizingUnitIds,
    valuableDownstreamCountByComponentId,
  };
}

function buildEscortDemand(
  world: WorldState,
  link: MaritimeSupplyLink,
  context: EscortDemandContext,
): EscortDemand | null {
  if (link.reason === "port-lost" || link.reason === "route-invalid" || link.routeRegionIds.length === 0) {
    return null;
  }
  if (
    link.reason === "source-unsupplied" &&
    !world.supplyAssessment.maritimeEscorts.assignmentByLinkId.has(link.id)
  ) return null;
  const component = link.destinationLandComponentId
    ? world.supplyAssessment.componentById.get(link.destinationLandComponentId)
    : undefined;
  if (!component) return null;
  const landUnits = context.landUnitsByComponentId.get(component.id) ?? [];
  const frontlineUnitCount = landUnits.filter((unit) =>
    context.frontlineRegionIds.has(unit.regionId)
  ).length;
  const recentlyReconnected = component.reconnectedTick !== null &&
    world.time.fastTick - component.reconnectedTick <= 200;
  const importantCityCount = component.regionIds.filter((regionId) => {
    const building = getMesoById(world).get(regionId)?.building;
    return building === "city" || building === "capital";
  }).length;
  const reorganizingCount = landUnits.filter((unit) =>
    context.reorganizingUnitIds.has(unit.id)
  ).length;
  const downstreamCount = context.valuableDownstreamCountByComponentId.get(component.id) ?? 0;
  const remoteStrength = component.strength;
  const reasons: string[] = [];
  if (landUnits.length > 0) reasons.push("friendly-land-force");
  if (frontlineUnitCount > 0) reasons.push("active-frontline");
  if (landUnits.length > 0 && (component.isolated || recentlyReconnected)) {
    reasons.push("isolated-or-reconnected");
  }
  if (importantCityCount > 0) reasons.push("important-city");
  if (reorganizingCount > 0) reasons.push("reorganization");
  if (downstreamCount > 0) reasons.push("downstream-supply");
  if (reasons.length === 0) return null;
  const assignedRaidCount = world.supplyAssessment.maritimeInterdiction.assignmentsByLinkId
    .get(link.id)?.length ?? 0;
  return {
    maritimeLinkId: link.id,
    nationId: link.nationId,
    requiredEscortCount: Math.max(1, assignedRaidCount),
    remoteUnitCount: landUnits.length,
    remoteStrength,
    priority: [
      landUnits.length > 0 ? 1 : 0,
      remoteStrength,
      frontlineUnitCount,
      landUnits.length > 0 && (component.isolated || recentlyReconnected) ? 1 : 0,
      importantCityCount,
      reorganizingCount,
      downstreamCount,
    ],
    reasons,
  };
}

function compareEscortDemand(a: EscortDemand, b: EscortDemand): number {
  for (let index = 0; index < Math.max(a.priority.length, b.priority.length); index += 1) {
    const difference = (b.priority[index] ?? 0) - (a.priority[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return compareIds(a.maritimeLinkId, b.maritimeLinkId);
}

function createOrRefreshAssignment(
  world: WorldState,
  link: MaritimeSupplyLink,
  ship: UnitState,
  previous: EscortAssignment | undefined,
): EscortAssignment {
  const transport = getAssignedTransport(world, link.id);
  const positioned = !!transport && ship.regionId === transport.regionId;
  const sameRoute = previous && arraysEqual(previous.routeRegionIds, link.routeRegionIds);
  let positioningRouteIds: MesoRegionId[] = [];
  if (!positioned) {
    positioningRouteIds = sameRoute && previous.positioningRouteIds.includes(ship.regionId) &&
        previous.positioningRouteIds.at(-1) === transport?.regionId
      ? previous.positioningRouteIds
      : buildEscortPositioningRoute(world, ship.regionId, transport ? [transport.regionId] : link.routeRegionIds);
  }
  const isNew = previous?.combatShipId !== ship.id;
  if (isNew || (!sameRoute && !positioned)) {
    world.supplyAssessment.maritimeEscorts.movementRequests += 1;
    world.instrumentation?.incrementCounter("maritimeEscort.movementRequests");
  }
  return {
    combatShipId: ship.id,
    maritimeLinkId: link.id,
    nationId: link.nationId,
    routeRegionIds: [...link.routeRegionIds],
    status: positioned ? "escorting" : positioningRouteIds.length > 1 ? "moving-to-route" : "unavailable",
    assignedTick: isNew ? world.time.fastTick : previous.assignedTick,
    positioningRouteIds,
  };
}

function buildEscortPositioningRoute(
  world: WorldState,
  startId: MesoRegionId,
  routeIds: MesoRegionId[],
): MesoRegionId[] {
  const startedAt = world.instrumentation ? performance.now() : 0;
  const path = buildNavalPositioningRoute(world, startId, routeIds, true);
  world.instrumentation?.incrementCounter("maritimeEscort.pathfindingRequests");
  if (world.instrumentation) {
    world.instrumentation.recordDuration("maritimeEscort.pathfinding", performance.now() - startedAt);
  }
  return path;
}

function reconcileAssignments(
  world: WorldState,
  links: MaritimeSupplyLink[],
  previous: EscortAssignment[],
  next: EscortAssignment[],
  unitById: Map<UnitId, UnitState>,
): void {
  const state = world.supplyAssessment.maritimeEscorts;
  const nextByShipId = new Map(next.map((assignment) => [assignment.combatShipId, assignment]));
  const linkIds = new Set(links.map((link) => link.id));
  const linkById = new Map(links.map((link) => [link.id, link]));
  let changes = 0;
  for (const assignment of previous) {
    const replacement = nextByShipId.get(assignment.combatShipId);
    if (replacement?.maritimeLinkId !== assignment.maritimeLinkId) changes += 1;
    const unit = unitById.get(assignment.combatShipId);
    if (!isOperationalCombatShip(unit)) {
      state.escortLosses += 1;
      world.instrumentation?.incrementCounter("maritimeEscort.losses");
    }
    if (!replacement && unit) resetMovement(unit);
    const oldLink = linkById.get(assignment.maritimeLinkId);
    if (
      !linkIds.has(assignment.maritimeLinkId) ||
      oldLink?.reason === "port-lost" || oldLink?.reason === "route-invalid"
    ) {
      state.assignmentsReleasedAfterLinkRemoval += 1;
      world.instrumentation?.incrementCounter("maritimeEscort.released.linkRemoval");
    }
  }
  const previousShipIds = new Set(previous.map((assignment) => assignment.combatShipId));
  for (const assignment of next) if (!previousShipIds.has(assignment.combatShipId)) changes += 1;
  state.assignmentChanges += changes;
  world.instrumentation?.incrementCounter("maritimeEscort.assignmentChanges", changes);
}

function rebuildProtectionState(world: WorldState, links: MaritimeSupplyLink[]): void {
  const state = world.supplyAssessment.maritimeEscorts;
  const demandByLinkId = new Map(state.demands.map((demand) => [demand.maritimeLinkId, demand]));
  const protectionByLinkId = new Map<string, MaritimeLinkProtection>();
  for (const link of links) {
    const demand = demandByLinkId.get(link.id);
    const assignments = state.assignments.filter((assignment) => assignment.maritimeLinkId === link.id);
    const effectiveEscortCount = assignments.filter((assignment) => assignment.status === "escorting").length;
    const required = demand?.requiredEscortCount ?? 0;
    const protectionState: MaritimeProtectionState = required > 0 && effectiveEscortCount >= required
      ? "PROTECTED"
      : effectiveEscortCount > 0
        ? "PARTIALLY_PROTECTED"
        : "UNPROTECTED";
    const skippedReason: EscortSkippedReason | null = !demand
      ? link.reason === "port-lost" || link.reason === "route-invalid" ? "link-inactive" : "no-escort-demand"
      : assignments.length === 0 ? "no-escort-available"
      : effectiveEscortCount < required ? "escort-moving"
      : null;
    protectionByLinkId.set(link.id, {
      linkId: link.id,
      assignedEscortIds: assignments.map((assignment) => assignment.combatShipId),
      requiredEscortCount: required,
      protectionState,
      skippedReason,
    });
  }
  state.protectionByLinkId = protectionByLinkId;
}

function recordEscortMetrics(world: WorldState, combatShipCount: number): void {
  const state = world.supplyAssessment.maritimeEscorts;
  const protectedIds = new Set([...state.protectionByLinkId.values()]
    .filter((item) => item.protectionState === "PROTECTED").map((item) => item.linkId));
  const partialIds = new Set([...state.protectionByLinkId.values()]
    .filter((item) => item.protectionState === "PARTIALLY_PROTECTED").map((item) => item.linkId));
  const demandedIds = new Set(state.demands.map((demand) => demand.maritimeLinkId));
  let protectedStrength = 0;
  let unprotectedStrength = 0;
  for (const demand of state.demands) {
    if (protectedIds.has(demand.maritimeLinkId)) protectedStrength += demand.remoteStrength;
    else unprotectedStrength += demand.remoteStrength;
  }
  world.instrumentation?.incrementCounter("maritimeEscort.demands", state.demands.length);
  world.instrumentation?.incrementCounter("maritimeEscort.assignments", state.assignments.length);
  world.instrumentation?.incrementCounter("maritimeEscort.idleCombatShips", combatShipCount - state.assignments.length);
  world.instrumentation?.incrementCounter("maritimeEscort.assignedCombatShips", state.assignments.length);
  world.instrumentation?.incrementCounter("maritimeEscort.links.protected", protectedIds.size);
  world.instrumentation?.incrementCounter("maritimeEscort.links.unprotected", [...demandedIds].filter((id) => !protectedIds.has(id) && !partialIds.has(id)).length);
  world.instrumentation?.incrementCounter("maritimeEscort.links.partiallyProtected", partialIds.size);
  world.instrumentation?.incrementCounter("maritimeEscort.remoteStrength.protected", protectedStrength);
  world.instrumentation?.incrementCounter("maritimeEscort.remoteStrength.unprotected", unprotectedStrength);
}

function completeEscortArrival(
  world: WorldState,
  unit: UnitState,
  assignment: EscortAssignment,
): void {
  if (assignment.status !== "escorting") {
    const state = world.supplyAssessment.maritimeEscorts;
    state.completedArrivals += 1;
    state.totalArrivalLatencyTicks += Math.max(0, world.time.fastTick - assignment.assignedTick);
    world.instrumentation?.incrementCounter("maritimeEscort.completedArrivals");
  }
  assignment.status = "escorting";
  resetMovement(unit);
}

function isOnSeaRoute(world: WorldState, regionId: MesoRegionId, route: MesoRegionId[]): boolean {
  return route.includes(regionId) && getMesoById(world).get(regionId)?.type === "sea";
}

function getAssignedTransport(world: WorldState, linkId: string): UnitState | undefined {
  const transportId = world.supplyAssessment.maritimeLogistics.assignments
    .find((assignment) => assignment.maritimeLinkId === linkId)?.transportId;
  return transportId ? world.units.find((unit) => unit.id === transportId) : undefined;
}

function resetMovement(unit: UnitState): void {
  unit.moveTargetId = null;
  unit.moveFromId = null;
  unit.moveToId = null;
  unit.moveProgressMs = 0;
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
