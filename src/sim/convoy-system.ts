import type { MesoRegionId } from "../worldgen/meso-region";
import { getMoveMsPerRegion } from "./movement";
import type { MaritimeSupplyLink } from "./maritime-supply";
import { isOperationalTransport } from "./maritime-supply";
import { isOperationalCombatShip } from "./maritime-escort";
import type { UnitId, UnitState } from "./unit";
import type { WorldState } from "./world-state";
import { getNeighborsById } from "./world-cache";

export type ConvoyState =
  | "forming"
  | "loading"
  | "outbound"
  | "unloading"
  | "returning"
  | "suspended";

export interface ConvoyMember {
  unitId: UnitId;
  role: "transport" | "escort";
}

export interface ConvoyRoute {
  waypointIds: MesoRegionId[];
  sourcePortId: MesoRegionId;
  destinationPortId: MesoRegionId;
}

export interface Convoy {
  id: string;
  maritimeLinkId: string;
  transportId: UnitId | null;
  lastTransportId: UnitId | null;
  escortIds: UnitId[];
  lastEscortIds: UnitId[];
  members: ConvoyMember[];
  route: ConvoyRoute;
  currentWaypoint: number;
  currentDestinationId: MesoRegionId;
  progress: number;
  direction: 1 | -1;
  state: ConvoyState;
  mission: "maritime-supply";
  createdAtFastTick: number;
  cycleStartedAtFastTick: number;
  completedCycles: number;
}

export interface ConvoySystemState {
  version: number;
  convoys: Convoy[];
  convoyById: Map<string, Convoy>;
  convoyByLinkId: Map<string, Convoy>;
  convoysCreated: number;
  uptimeTicks: number;
  totalTravelDistance: number;
  completedCycleTimeTicks: number;
  completedCycles: number;
  escortLosses: number;
  transportLosses: number;
  raidInterceptions: number;
  successfulDeliveries: number;
  supplyInterruptions: number;
  replacementEscorts: number;
  replacementTransports: number;
  movementCpuMs: number;
  activeInterceptionKeys: Set<string>;
}

export function createConvoySystemState(): ConvoySystemState {
  return {
    version: 0,
    convoys: [],
    convoyById: new Map(),
    convoyByLinkId: new Map(),
    convoysCreated: 0,
    uptimeTicks: 0,
    totalTravelDistance: 0,
    completedCycleTimeTicks: 0,
    completedCycles: 0,
    escortLosses: 0,
    transportLosses: 0,
    raidInterceptions: 0,
    successfulDeliveries: 0,
    supplyInterruptions: 0,
    replacementEscorts: 0,
    replacementTransports: 0,
    movementCpuMs: 0,
    activeInterceptionKeys: new Set(),
  };
}

/** Reconciles persistent convoy identities with the assignment systems. */
export function updateConvoyAssignments(world: WorldState, links: MaritimeSupplyLink[]): void {
  const system = world.supplyAssessment.convoys;
  const previousByLinkId = system.convoyByLinkId;
  const unitById = new Map(world.units.map((unit) => [unit.id, unit]));
  const next: Convoy[] = [];

  for (const link of links) {
    const previous = previousByLinkId.get(link.id);
    const transportId = link.assignedTransportIds[0] ?? null;
    const escortIds = world.supplyAssessment.maritimeEscorts.assignments
      .filter((assignment) => assignment.maritimeLinkId === link.id)
      .map((assignment) => assignment.combatShipId)
      .sort(compareIds);
    const route = [...link.routeRegionIds];
    const transport = transportId ? unitById.get(transportId) : undefined;
    const waypoint = transport ? route.indexOf(transport.regionId) : -1;
    const routeChanged = !previous || !arraysEqual(previous.route.waypointIds, route);
    const direction = previous?.direction ?? 1;
    const currentWaypoint = routeChanged
      ? Math.max(0, waypoint)
      : waypoint >= 0 ? waypoint : previous.currentWaypoint;
    const destinationIndex = clampWaypoint(currentWaypoint + direction, route.length);
    const convoy: Convoy = previous ?? {
      id: `convoy:${link.id}`,
      maritimeLinkId: link.id,
      transportId: null,
      lastTransportId: null,
      escortIds: [],
      lastEscortIds: [],
      members: [],
      route: {
        waypointIds: route,
        sourcePortId: link.sourcePortId,
        destinationPortId: link.destinationPortId,
      },
      currentWaypoint,
      currentDestinationId: route[destinationIndex] ?? link.destinationPortId,
      progress: 0,
      direction,
      state: "forming",
      mission: "maritime-supply",
      createdAtFastTick: world.time.fastTick,
      cycleStartedAtFastTick: world.time.fastTick,
      completedCycles: 0,
    };
    if (!previous) {
      system.convoysCreated += 1;
      world.instrumentation?.incrementCounter("convoy.created");
    } else {
      if (previous.transportId && !unitById.has(previous.transportId)) {
        system.transportLosses += 1;
        system.supplyInterruptions += 1;
      }
      for (const escortId of previous.escortIds) {
        if (!unitById.has(escortId)) system.escortLosses += 1;
      }
      if (previous.lastTransportId && transportId && previous.lastTransportId !== transportId) {
        system.replacementTransports += 1;
        world.instrumentation?.incrementCounter("convoy.replacementTransports");
      }
      for (const escortId of escortIds) {
        if (previous.lastEscortIds.length > 0 && !previous.lastEscortIds.includes(escortId)) {
          system.replacementEscorts += 1;
          world.instrumentation?.incrementCounter("convoy.replacementEscorts");
        }
      }
    }
    convoy.transportId = transportId;
    if (transportId) convoy.lastTransportId = transportId;
    convoy.escortIds = escortIds;
    if (escortIds.length > 0) convoy.lastEscortIds = [...escortIds];
    convoy.members = [
      ...(transportId ? [{ unitId: transportId, role: "transport" as const }] : []),
      ...escortIds.map((unitId) => ({ unitId, role: "escort" as const })),
    ];
    convoy.route = {
      waypointIds: route,
      sourcePortId: link.sourcePortId,
      destinationPortId: link.destinationPortId,
    };
    convoy.currentWaypoint = currentWaypoint;
    convoy.currentDestinationId = route[destinationIndex] ?? link.destinationPortId;
    if (!transportId || link.reason === "port-lost" || link.reason === "route-invalid") {
      convoy.state = "suspended";
      convoy.progress = 0;
    } else if (convoy.state === "suspended") {
      convoy.state = escortsFormed(convoy, unitById, transport) ? stateForDirection(convoy) : "forming";
    }
    next.push(convoy);
  }
  next.sort((a, b) => compareIds(a.id, b.id));
  system.convoys = next;
  system.convoyById = new Map(next.map((convoy) => [convoy.id, convoy]));
  system.convoyByLinkId = new Map(next.map((convoy) => [convoy.maritimeLinkId, convoy]));
  system.version += 1;
}

/** Moves a transport leader and its formed escorts as one logistics-only formation. */
export function updateConvoyMovement(world: WorldState, dtMs: number): void {
  const system = world.supplyAssessment.convoys;
  if (system.convoys.length === 0) return;
  system.version += 1;
  const startedAt = world.instrumentation ? performance.now() : 0;
  const unitById = new Map(world.units.map((unit) => [unit.id, unit]));
  const neighborsById = getNeighborsById(world);

  for (const convoy of system.convoys) {
    const transport = convoy.transportId ? unitById.get(convoy.transportId) : undefined;
    if (!isOperationalTransport(transport) || convoy.route.waypointIds.length < 2) {
      convoy.state = "suspended";
      continue;
    }
    if (!escortsFormed(convoy, unitById, transport)) {
      convoy.state = "forming";
      resetMovement(transport);
      continue;
    }
    system.uptimeTicks += 1;
    world.instrumentation?.incrementCounter("convoy.uptimeTicks");
    const route = convoy.route.waypointIds;
    let currentIndex = route.indexOf(transport.regionId);
    if (currentIndex < 0) {
      convoy.state = "forming";
      const assignment = world.supplyAssessment.maritimeLogistics.assignmentByTransportId
        .get(transport.id);
      const positioningRoute = assignment?.positioningRouteIds ?? [];
      const positioningIndex = positioningRoute.indexOf(transport.regionId);
      const nextId = positioningIndex >= 0 ? positioningRoute[positioningIndex + 1] : undefined;
      if (!nextId || !(neighborsById.get(transport.regionId) ?? []).includes(nextId)) {
        resetFormation(convoy, unitById);
        continue;
      }
      convoy.currentDestinationId = nextId;
      if (transport.moveToId !== nextId) {
        transport.moveFromId = transport.regionId;
        transport.moveToId = nextId;
        transport.moveTargetId = positioningRoute.at(-1) ?? null;
        transport.moveProgressMs = 0;
      }
      transport.moveProgressMs += Math.max(0, dtMs);
      const moveMs = getMoveMsPerRegion(transport);
      convoy.progress = moveMs > 0 ? Math.min(1, transport.moveProgressMs / moveMs) : 1;
      mirrorFormationMovement(convoy, unitById, transport);
      if (transport.moveProgressMs >= moveMs) {
        completeFormationStep(world, convoy, unitById, transport, nextId, system);
      }
      continue;
    }
    convoy.currentWaypoint = currentIndex;
    if (currentIndex === route.length - 1 && convoy.direction === 1) {
      convoy.state = "unloading";
      convoy.direction = -1;
      convoy.currentDestinationId = route[currentIndex - 1];
      convoy.progress = 0;
      system.successfulDeliveries += 1;
      world.instrumentation?.incrementCounter("convoy.successfulDeliveries");
      resetFormation(convoy, unitById);
      continue;
    }
    if (currentIndex === 0 && convoy.direction === -1) {
      convoy.state = "loading";
      convoy.direction = 1;
      convoy.currentDestinationId = route[1];
      convoy.progress = 0;
      convoy.completedCycles += 1;
      system.completedCycles += 1;
      system.completedCycleTimeTicks += Math.max(0, world.time.fastTick - convoy.cycleStartedAtFastTick);
      convoy.cycleStartedAtFastTick = world.time.fastTick;
      world.instrumentation?.incrementCounter("convoy.completedCycles");
      resetFormation(convoy, unitById);
      continue;
    }

    const nextIndex = currentIndex + convoy.direction;
    const nextId = route[nextIndex];
    if (!nextId || !(neighborsById.get(transport.regionId) ?? []).includes(nextId)) {
      convoy.state = "suspended";
      resetFormation(convoy, unitById);
      continue;
    }
    convoy.state = stateForDirection(convoy);
    convoy.currentDestinationId = nextId;
    if (transport.moveToId !== nextId) {
      transport.moveFromId = transport.regionId;
      transport.moveToId = nextId;
      transport.moveTargetId = convoy.direction === 1
        ? convoy.route.destinationPortId
        : convoy.route.sourcePortId;
      transport.moveProgressMs = 0;
    }
    transport.moveProgressMs += Math.max(0, dtMs);
    const moveMs = getMoveMsPerRegion(transport);
    convoy.progress = moveMs > 0 ? Math.min(1, transport.moveProgressMs / moveMs) : 1;
    mirrorFormationMovement(convoy, unitById, transport);
    if (transport.moveProgressMs < moveMs) continue;

    completeFormationStep(world, convoy, unitById, transport, nextId, system);
    convoy.currentWaypoint = nextIndex;
  }
  if (world.instrumentation) {
    const elapsed = performance.now() - startedAt;
    system.movementCpuMs += elapsed;
    world.instrumentation.recordDuration("convoy.movement", elapsed);
  }
}

function completeFormationStep(
  world: WorldState,
  convoy: Convoy,
  unitById: Map<UnitId, UnitState>,
  transport: UnitState,
  nextId: MesoRegionId,
  system: ConvoySystemState,
): void {
  transport.regionId = nextId;
  transport.moveProgressMs = 0;
  transport.moveFromId = null;
  transport.moveToId = null;
  convoy.progress = 0;
  system.totalTravelDistance += 1;
  world.instrumentation?.incrementCounter("convoy.travelDistance");
  for (const escortId of convoy.escortIds) {
    const escort = unitById.get(escortId);
    if (!isOperationalCombatShip(escort, transport.nationId)) continue;
    escort.regionId = nextId;
    escort.moveProgressMs = 0;
    escort.moveFromId = null;
    escort.moveToId = null;
    escort.moveTargetId = transport.moveTargetId;
  }
}

function escortsFormed(
  convoy: Convoy,
  unitById: Map<UnitId, UnitState>,
  transport: UnitState | undefined,
): boolean {
  if (!transport) return false;
  return convoy.escortIds.every((id) => {
    const escort = unitById.get(id);
    return isOperationalCombatShip(escort, transport.nationId) && escort.regionId === transport.regionId;
  });
}

function mirrorFormationMovement(
  convoy: Convoy,
  unitById: Map<UnitId, UnitState>,
  transport: UnitState,
): void {
  for (const escortId of convoy.escortIds) {
    const escort = unitById.get(escortId);
    if (!isOperationalCombatShip(escort, transport.nationId) || escort.regionId !== transport.regionId) continue;
    escort.moveFromId = transport.moveFromId;
    escort.moveToId = transport.moveToId;
    escort.moveTargetId = transport.moveTargetId;
    escort.moveProgressMs = transport.moveProgressMs;
  }
}

function resetFormation(convoy: Convoy, unitById: Map<UnitId, UnitState>): void {
  if (convoy.transportId) {
    const transport = unitById.get(convoy.transportId);
    if (transport) resetMovement(transport);
  }
  for (const escortId of convoy.escortIds) {
    const escort = unitById.get(escortId);
    if (escort) resetMovement(escort);
  }
}

function resetMovement(unit: UnitState): void {
  unit.moveTargetId = null;
  unit.moveFromId = null;
  unit.moveToId = null;
  unit.moveProgressMs = 0;
}

function stateForDirection(convoy: Convoy): ConvoyState {
  return convoy.direction === 1 ? "outbound" : "returning";
}

function clampWaypoint(index: number, length: number): number {
  return Math.max(0, Math.min(Math.max(0, length - 1), index));
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
