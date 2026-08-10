import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import type { SupplyComponentId } from "./supply-assessment";
import type { UnitId, UnitState } from "./unit";
import { getMoveMsPerRegion } from "./movement";
import type { WorldState } from "./world-state";
import { getMesoById, getNeighborsById, getOwnerByMesoId } from "./world-cache";
import { getMaritimeLinkProtection } from "./maritime-escort";

export type MaritimeSupplyInactiveReason =
  | "no-transport"
  | "port-lost"
  | "route-invalid"
  | "source-unsupplied";

export interface MaritimeSupplyLink {
  id: string;
  nationId: NationId;
  sourcePortId: MesoRegionId;
  destinationPortId: MesoRegionId;
  sourceLandComponentId: SupplyComponentId | null;
  destinationLandComponentId: SupplyComponentId | null;
  /** @deprecated Use assignedTransportIds. Kept for debug/save compatibility. */
  transportSupport: string[];
  assignedTransportIds: UnitId[];
  requiredTransportCount: number;
  routeRegionIds: MesoRegionId[];
  active: boolean;
  reason: MaritimeSupplyInactiveReason | null;
}

export type TransportAssignmentStatus =
  | "assigned"
  | "moving-to-source"
  | "loading/ready"
  | "transit"
  | "stationed"
  | "unavailable";

export interface TransportAssignment {
  transportId: UnitId;
  maritimeLinkId: string;
  sourcePortId: MesoRegionId;
  destinationPortId: MesoRegionId;
  status: TransportAssignmentStatus;
  assignedAtFastTick: number;
  routeRegionIds: MesoRegionId[];
  positioningRouteIds: MesoRegionId[];
}

export interface MaritimeLogisticsState {
  assignments: TransportAssignment[];
  assignmentByTransportId: Map<UnitId, TransportAssignment>;
  assignmentChanges: number;
  transportLosses: number;
  linksBrokenByTransportLoss: number;
  linksRestoredByReplacement: number;
  totalArrivalLatencyTicks: number;
  completedArrivals: number;
}

export function createMaritimeLogisticsState(): MaritimeLogisticsState {
  return {
    assignments: [],
    assignmentByTransportId: new Map(),
    assignmentChanges: 0,
    transportLosses: 0,
    linksBrokenByTransportLoss: 0,
    linksRestoredByReplacement: 0,
    totalArrivalLatencyTicks: 0,
    completedArrivals: 0,
  };
}

export interface MaritimeConnectivityCache {
  mapVersion: number;
  seaComponentByRegionId: Map<MesoRegionId, number>;
  parentByRegionId: Map<MesoRegionId, MesoRegionId | null>;
  depthByRegionId: Map<MesoRegionId, number>;
  routeByPortPair: Map<string, MesoRegionId[] | null>;
  rebuildCount: number;
  hitCount: number;
}

export function createMaritimeConnectivityCache(): MaritimeConnectivityCache {
  return {
    mapVersion: -1,
    seaComponentByRegionId: new Map(),
    parentByRegionId: new Map(),
    depthByRegionId: new Map(),
    routeByPortPair: new Map(),
    rebuildCount: 0,
    hitCount: 0,
  };
}

export function isOperationalTransport(
  unit: UnitState | undefined,
  nationId?: NationId,
): unit is UnitState {
  return !!unit &&
    unit.domain === "naval" &&
    unit.type === "TransportShip" &&
    unit.manpower > 0 &&
    unit.org > 0 &&
    (!nationId || unit.nationId === nationId);
}

export function getTransportAssignment(
  world: WorldState,
  transportId: UnitId,
): TransportAssignment | undefined {
  return world.supplyAssessment.maritimeLogistics.assignmentByTransportId.get(transportId);
}

export function getTransportsForLink(
  world: WorldState,
  linkId: string,
): UnitState[] {
  const unitById = new Map(world.units.map((unit) => [unit.id, unit]));
  return world.supplyAssessment.maritimeLogistics.assignments
    .filter((assignment) => assignment.maritimeLinkId === linkId)
    .map((assignment) => unitById.get(assignment.transportId))
    .filter((unit): unit is UnitState => isOperationalTransport(unit));
}

export function getMaritimeLinkProtectionState(
  world: WorldState,
  linkId: string,
): ReturnType<typeof getMaritimeLinkProtection> {
  return getMaritimeLinkProtection(world, linkId);
}

/** Logistics-only movement. General naval roaming, combat, and amphibious AI stay disabled. */
export function updateMaritimeLogisticsMovement(world: WorldState, dtMs: number): void {
  const logistics = world.supplyAssessment.maritimeLogistics;
  if (logistics.assignments.length === 0) return;
  const unitById = new Map(world.units.map((unit) => [unit.id, unit]));
  const neighborsById = getNeighborsById(world);
  for (const assignment of logistics.assignments) {
    const unit = unitById.get(assignment.transportId);
    if (!isOperationalTransport(unit) || assignment.status === "stationed") continue;
    if (isOnSeaRoute(world, unit.regionId, assignment.routeRegionIds)) {
      completeTransportArrival(world, unit, assignment);
      continue;
    }
    const currentIndex = assignment.positioningRouteIds.indexOf(unit.regionId);
    const nextId = currentIndex >= 0
      ? assignment.positioningRouteIds[currentIndex + 1]
      : undefined;
    if (!nextId || !(neighborsById.get(unit.regionId) ?? []).includes(nextId)) {
      assignment.status = "unavailable";
      resetTransportMovement(unit);
      continue;
    }
    if (unit.moveToId !== nextId) {
      unit.moveFromId = unit.regionId;
      unit.moveToId = nextId;
      unit.moveTargetId = assignment.sourcePortId;
      unit.moveProgressMs = 0;
    }
    unit.moveProgressMs += Math.max(0, dtMs);
    const moveMs = getMoveMsPerRegion(unit);
    if (unit.moveProgressMs < moveMs) continue;
    unit.regionId = nextId;
    unit.moveProgressMs = Math.max(0, unit.moveProgressMs - moveMs);
    unit.moveFromId = null;
    unit.moveToId = null;
    world.instrumentation?.incrementCounter("maritimeLogistics.regionArrivals");
    if (isOnSeaRoute(world, unit.regionId, assignment.routeRegionIds)) {
      completeTransportArrival(world, unit, assignment);
    }
  }
}

function completeTransportArrival(
  world: WorldState,
  unit: UnitState,
  assignment: TransportAssignment,
): void {
  assignment.status = "stationed";
  resetTransportMovement(unit);
  const logistics = world.supplyAssessment.maritimeLogistics;
  logistics.completedArrivals += 1;
  logistics.totalArrivalLatencyTicks += Math.max(
    0,
    world.time.fastTick - assignment.assignedAtFastTick,
  );
  world.instrumentation?.incrementCounter("maritimeLogistics.completedArrivals");
}

function resetTransportMovement(unit: UnitState): void {
  unit.moveTargetId = null;
  unit.moveFromId = null;
  unit.moveToId = null;
  unit.moveProgressMs = 0;
}

function isOnSeaRoute(
  world: WorldState,
  regionId: MesoRegionId,
  route: readonly MesoRegionId[],
): boolean {
  return route.includes(regionId) && getMesoById(world).get(regionId)?.type === "sea";
}

export function getCachedMaritimeRoute(
  world: WorldState,
  cache: MaritimeConnectivityCache,
  sourcePortId: MesoRegionId,
  destinationPortId: MesoRegionId,
): MesoRegionId[] | null {
  ensureSeaConnectivity(world, cache);
  const key = portPairKey(sourcePortId, destinationPortId);
  if (cache.routeByPortPair.has(key)) {
    cache.hitCount += 1;
    world.instrumentation?.incrementCounter("maritimeSupply.cacheHits");
    return cache.routeByPortPair.get(key) ?? null;
  }

  const route = buildRouteFromSeaForest(world, cache, sourcePortId, destinationPortId);
  cache.routeByPortPair.set(key, route);
  return route;
}

function ensureSeaConnectivity(
  world: WorldState,
  cache: MaritimeConnectivityCache,
): void {
  if (cache.mapVersion === world.mapVersion) return;
  const mesoById = getMesoById(world);
  const neighborsById = getNeighborsById(world);
  const seaIds = [...mesoById.values()]
    .filter((region) => region.type === "sea")
    .map((region) => region.id)
    .sort(compareIds);
  const seaComponentByRegionId = new Map<MesoRegionId, number>();
  const parentByRegionId = new Map<MesoRegionId, MesoRegionId | null>();
  const depthByRegionId = new Map<MesoRegionId, number>();
  let componentId = 0;

  for (const root of seaIds) {
    if (seaComponentByRegionId.has(root)) continue;
    seaComponentByRegionId.set(root, componentId);
    parentByRegionId.set(root, null);
    depthByRegionId.set(root, 0);
    const queue = [root];
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index];
      const depth = depthByRegionId.get(current) ?? 0;
      const neighbors = [...(neighborsById.get(current) ?? [])].sort(compareIds);
      for (const neighborId of neighbors) {
        if (mesoById.get(neighborId)?.type !== "sea") continue;
        if (seaComponentByRegionId.has(neighborId)) continue;
        seaComponentByRegionId.set(neighborId, componentId);
        parentByRegionId.set(neighborId, current);
        depthByRegionId.set(neighborId, depth + 1);
        queue.push(neighborId);
      }
    }
    componentId += 1;
  }

  cache.mapVersion = world.mapVersion;
  cache.seaComponentByRegionId = seaComponentByRegionId;
  cache.parentByRegionId = parentByRegionId;
  cache.depthByRegionId = depthByRegionId;
  cache.routeByPortPair.clear();
  cache.rebuildCount += 1;
  world.instrumentation?.incrementCounter("maritimeSupply.cacheRebuilds");
}

function buildRouteFromSeaForest(
  world: WorldState,
  cache: MaritimeConnectivityCache,
  sourcePortId: MesoRegionId,
  destinationPortId: MesoRegionId,
): MesoRegionId[] | null {
  const sourceSeaId = getPortSeaEntrance(world, sourcePortId);
  const destinationSeaId = getPortSeaEntrance(world, destinationPortId);
  if (!sourceSeaId || !destinationSeaId) return null;
  if (
    cache.seaComponentByRegionId.get(sourceSeaId) !==
    cache.seaComponentByRegionId.get(destinationSeaId)
  ) return null;

  const sourceAncestors = new Map<MesoRegionId, number>();
  const sourcePath: MesoRegionId[] = [];
  let current: MesoRegionId | null = sourceSeaId;
  while (current) {
    sourceAncestors.set(current, sourcePath.length);
    sourcePath.push(current);
    current = cache.parentByRegionId.get(current) ?? null;
  }
  const destinationPath: MesoRegionId[] = [];
  current = destinationSeaId;
  while (current && !sourceAncestors.has(current)) {
    destinationPath.push(current);
    current = cache.parentByRegionId.get(current) ?? null;
  }
  if (!current) return null;
  const commonIndex = sourceAncestors.get(current);
  if (commonIndex === undefined) return null;
  const seaRoute = [
    ...sourcePath.slice(0, commonIndex + 1),
    ...destinationPath.reverse(),
  ];
  return [sourcePortId, ...seaRoute, destinationPortId];
}

function getPortSeaEntrance(
  world: WorldState,
  portId: MesoRegionId,
): MesoRegionId | null {
  const mesoById = getMesoById(world);
  return [...(getNeighborsById(world).get(portId) ?? [])]
    .filter((id) => mesoById.get(id)?.type === "sea")
    .sort(compareIds)[0] ?? null;
}

function portPairKey(a: MesoRegionId, b: MesoRegionId): string {
  return `${a}->${b}`;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isEffectivelyControlledPort(
  world: WorldState,
  nationId: NationId,
  portId: MesoRegionId,
): boolean {
  const region = getMesoById(world).get(portId);
  if (!region || region.type === "sea" || region.building !== "port") return false;
  if (getOwnerByMesoId(world).get(portId) !== nationId) return false;
  const occupier = world.occupation.mesoById.get(portId);
  return !occupier || occupier === nationId;
}
