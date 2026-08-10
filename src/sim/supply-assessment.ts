import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import { getControlledTopology } from "./ai-geography";
import { isNationActive } from "./nation-active";
import { getUnitCombatStrength } from "./unit-strength";
import type { WorldState } from "./world-state";
import {
  createMaritimeLogisticsState,
  createMaritimeConnectivityCache,
  getCachedMaritimeRoute,
  isEffectivelyControlledPort,
  isOperationalTransport,
  type MaritimeConnectivityCache,
  type MaritimeLogisticsState,
  type MaritimeSupplyInactiveReason,
  type MaritimeSupplyLink,
  type TransportAssignment,
} from "./maritime-supply";
import type { UnitId, UnitState } from "./unit";
import { getMesoById, getNeighborsById, getOwnerByMesoId } from "./world-cache";
import {
  createMaritimeEscortState,
  updateMaritimeEscortAssignments,
  type MaritimeEscortState,
} from "./maritime-escort";
import { buildNavalPositioningRoute } from "./naval-pathfinding";

export type SupplyComponentId = string & { __brand: "SupplyComponentId" };

export type SupplyStateReason =
  | "active-capital-component"
  | "maritime-connected"
  | "maritime-port-lost"
  | "maritime-route-invalid"
  | "maritime-no-transport"
  | "maritime-source-unsupplied"
  | "capital-outside-component"
  | "no-active-supply-source";

export interface SupplyComponentState {
  id: SupplyComponentId;
  nationId: NationId;
  topologyComponentId: number;
  regionIds: MesoRegionId[];
  supplied: boolean;
  isolated: boolean;
  isolatedSinceTick: number | null;
  reconnectedTick: number | null;
  suppliedDuration: number;
  isolatedDuration: number;
  lastDurationTick: number;
  reason: SupplyStateReason;
  strength: number;
}

export interface NationSupplyAssessment {
  nationId: NationId;
  supplySourceRegionIds: MesoRegionId[];
  components: SupplyComponentState[];
  componentById: Map<SupplyComponentId, SupplyComponentState>;
  componentIdByRegionId: Map<MesoRegionId, SupplyComponentId>;
  suppliedComponentCount: number;
  isolatedComponentCount: number;
  largestIsolatedStrength: number;
  evaluatedAtTick: number;
}

export interface SupplyAssessmentState {
  assessments: NationSupplyAssessment[];
  assessmentByNationId: Map<NationId, NationSupplyAssessment>;
  componentById: Map<SupplyComponentId, SupplyComponentState>;
  componentIdByRegionId: Map<MesoRegionId, SupplyComponentId>;
  territoryVersion: number;
  occupationVersion: number;
  capitalSourceSignature: string;
  version: number;
  rebuildCount: number;
  cacheHitCount: number;
  largestIsolatedStrength: number;
  longestIsolationDuration: number;
  nextComponentNumber: number;
  buildingVersion: number;
  mapVersion: number;
  maritimeLinks: MaritimeSupplyLink[];
  maritimeConnectivity: MaritimeConnectivityCache;
  maritimeLogistics: MaritimeLogisticsState;
  maritimeEscorts: MaritimeEscortState;
  maritimeLinksEvaluated: number;
  activeMaritimeLinkCount: number;
  inactiveMaritimeLinkCount: number;
  remoteComponentsSupplied: number;
  remoteComponentsIsolated: number;
  maritimeSupplyLossesDueToTransport: number;
  maritimeSupplyLossesDueToPortCapture: number;
  maritimeReconnections: number;
  multiHopSupplyPropagations: number;
  remoteStrengthSupplied: number;
  remoteStrengthIsolatedDueToMissingTransport: number;
}

export function createSupplyAssessmentState(): SupplyAssessmentState {
  return {
    assessments: [],
    assessmentByNationId: new Map(),
    componentById: new Map(),
    componentIdByRegionId: new Map(),
    territoryVersion: -1,
    occupationVersion: -1,
    capitalSourceSignature: "",
    version: 0,
    rebuildCount: 0,
    cacheHitCount: 0,
    largestIsolatedStrength: 0,
    longestIsolationDuration: 0,
    nextComponentNumber: 0,
    buildingVersion: -1,
    mapVersion: -1,
    maritimeLinks: [],
    maritimeConnectivity: createMaritimeConnectivityCache(),
    maritimeLogistics: createMaritimeLogisticsState(),
    maritimeEscorts: createMaritimeEscortState(),
    maritimeLinksEvaluated: 0,
    activeMaritimeLinkCount: 0,
    inactiveMaritimeLinkCount: 0,
    remoteComponentsSupplied: 0,
    remoteComponentsIsolated: 0,
    maritimeSupplyLossesDueToTransport: 0,
    maritimeSupplyLossesDueToPortCapture: 0,
    maritimeReconnections: 0,
    multiHopSupplyPropagations: 0,
    remoteStrengthSupplied: 0,
    remoteStrengthIsolatedDueToMissingTransport: 0,
  };
}

/** The source list is intentionally plural so ports and depots can be added later. */
export function getSupplySources(
  world: WorldState,
  nationId: NationId,
): MesoRegionId[] {
  const nation = world.nations.find((candidate) => candidate.id === nationId);
  return nation && isNationActive(nation) ? [nation.capitalMesoId] : [];
}

export function updateSupplyAssessment(world: WorldState): void {
  const state = world.supplyAssessment;
  const startedAt = world.instrumentation ? performance.now() : 0;
  advanceDurations(state, world.time.fastTick);
  const previousComponentByCurrentId = new Map(
    [...state.componentById.entries()].map(([id, component]) => [id, { ...component }]),
  );
  const capitalSourceSignature = buildCapitalSourceSignature(world);
  const dirty =
    state.territoryVersion !== world.territoryVersion ||
    state.occupationVersion !== world.occupation.version ||
    state.buildingVersion !== world.buildingVersion ||
    state.mapVersion !== world.mapVersion ||
    state.capitalSourceSignature !== capitalSourceSignature;

  if (dirty) {
    const rebuildStartedAt = world.instrumentation ? performance.now() : 0;
    rebuildSupplyAssessment(world, capitalSourceSignature, previousComponentByCurrentId);
    state.rebuildCount += 1;
    world.instrumentation?.incrementCounter("supplyAssessment.rebuilds");
    if (world.instrumentation) {
      const duration = performance.now() - rebuildStartedAt;
      world.instrumentation.recordDuration("supplyAssessment.rebuild", duration);
    }
  } else {
    state.cacheHitCount += 1;
    world.instrumentation?.incrementCounter("supplyAssessment.cacheHits");
  }

  refreshStrengthDiagnostics(world);
  propagateMaritimeSupply(
    world,
    previousComponentByCurrentId,
    dirty,
  );
  refreshStrengthDiagnostics(world);
  state.version += 1;
  if (world.instrumentation) {
    world.instrumentation.recordDuration(
      "supplyAssessment.evaluation",
      performance.now() - startedAt,
    );
  }
}

export function isComponentSupplied(
  world: WorldState,
  componentId: SupplyComponentId,
): boolean {
  return world.supplyAssessment.componentById.get(componentId)?.supplied ?? false;
}

export function isRegionSupplied(
  world: WorldState,
  regionId: MesoRegionId,
): boolean {
  world.instrumentation?.incrementCounter("supplyAssessment.regionQueries");
  const componentId = world.supplyAssessment.componentIdByRegionId.get(regionId);
  return componentId ? isComponentSupplied(world, componentId) : false;
}

export function isNationRegionSupplied(
  world: WorldState,
  nationId: NationId,
  regionId: MesoRegionId,
): boolean {
  world.instrumentation?.incrementCounter("supplyAssessment.regionQueries");
  const componentId = world.supplyAssessment.assessmentByNationId
    .get(nationId)
    ?.componentIdByRegionId.get(regionId);
  return componentId ? isComponentSupplied(world, componentId) : false;
}

export function getComponentSupplyState(
  world: WorldState,
  componentId: SupplyComponentId,
): SupplyComponentState | undefined {
  return world.supplyAssessment.componentById.get(componentId);
}

export function getNationSupplyAssessment(
  world: WorldState,
  nationId: NationId,
): NationSupplyAssessment | undefined {
  return world.supplyAssessment.assessmentByNationId.get(nationId);
}

function rebuildSupplyAssessment(
  world: WorldState,
  capitalSourceSignature: string,
  previousComponentByCurrentId: Map<SupplyComponentId, SupplyComponentState>,
): void {
  const state = world.supplyAssessment;
  const previousByNationId = state.assessmentByNationId;
  const assessments: NationSupplyAssessment[] = [];
  const componentById = new Map<SupplyComponentId, SupplyComponentState>();
  const globalComponentIdByRegionId = new Map<MesoRegionId, SupplyComponentId>();

  for (const nation of [...world.nations].sort((a, b) => compareIds(a.id, b.id))) {
    if (!isNationActive(nation)) continue;
    const topology = getControlledTopology(world, nation.id);
    const supplySourceRegionIds = getSupplySources(world, nation.id);
    const suppliedTopologyIds = new Set<number>();
    for (const sourceRegionId of supplySourceRegionIds) {
      const topologyId = topology.componentByRegionId.get(sourceRegionId);
      if (topologyId !== undefined) suppliedTopologyIds.add(topologyId);
    }

    const previous = previousByNationId.get(nation.id)?.components ?? [];
    const currentTopologyComponents = [...topology.regionIdsByComponent]
      .sort(([a], [b]) => a - b)
      .map(([topologyComponentId, topologyRegionIds]) => ({
        topologyComponentId,
        regionIds: [...topologyRegionIds].sort(compareIds),
      }));
    const previousByTopologyId = matchComponentsByOverlap(
      previous,
      currentTopologyComponents,
    );
    const components: SupplyComponentState[] = [];
    const componentIdByRegionId = new Map<MesoRegionId, SupplyComponentId>();
    for (const { topologyComponentId, regionIds } of currentTopologyComponents) {
      const matched = previousByTopologyId.get(topologyComponentId);
      const supplied = suppliedTopologyIds.has(topologyComponentId);
      const component = reconcileComponent(
        state,
        nation.id,
        topologyComponentId,
        regionIds,
        supplied,
        supplySourceRegionIds.length > 0,
        matched,
        world.time.fastTick,
      );
      components.push(component);
      if (matched && !previousComponentByCurrentId.has(component.id)) {
        previousComponentByCurrentId.set(component.id, { ...matched });
      }
      componentById.set(component.id, component);
      for (const regionId of regionIds) {
        componentIdByRegionId.set(regionId, component.id);
        globalComponentIdByRegionId.set(regionId, component.id);
      }
    }

    const assessment: NationSupplyAssessment = {
      nationId: nation.id,
      supplySourceRegionIds,
      components,
      componentById: new Map(components.map((component) => [component.id, component])),
      componentIdByRegionId,
      suppliedComponentCount: components.filter((component) => component.supplied).length,
      isolatedComponentCount: components.filter((component) => component.isolated).length,
      largestIsolatedStrength: 0,
      evaluatedAtTick: world.time.fastTick,
    };
    assessments.push(assessment);
  }

  state.assessments = assessments;
  state.assessmentByNationId = new Map(
    assessments.map((assessment) => [assessment.nationId, assessment]),
  );
  state.componentById = componentById;
  state.componentIdByRegionId = globalComponentIdByRegionId;
  state.territoryVersion = world.territoryVersion;
  state.occupationVersion = world.occupation.version;
  state.buildingVersion = world.buildingVersion;
  state.mapVersion = world.mapVersion;
  state.capitalSourceSignature = capitalSourceSignature;
}

function reconcileComponent(
  state: SupplyAssessmentState,
  nationId: NationId,
  topologyComponentId: number,
  regionIds: MesoRegionId[],
  supplied: boolean,
  hasSource: boolean,
  previous: SupplyComponentState | undefined,
  tick: number,
): SupplyComponentState {
  const id = previous?.id ??
    (`supply-component-${state.nextComponentNumber++}` as SupplyComponentId);
  const wasSupplied = previous?.supplied;
  return {
    id,
    nationId,
    topologyComponentId,
    regionIds,
    supplied,
    isolated: !supplied,
    isolatedSinceTick: supplied
      ? previous?.isolatedSinceTick ?? null
      : wasSupplied === false ? previous?.isolatedSinceTick ?? tick : tick,
    reconnectedTick: supplied && wasSupplied === false
      ? tick
      : previous?.reconnectedTick ?? null,
    suppliedDuration: previous?.suppliedDuration ?? 0,
    isolatedDuration: previous?.isolatedDuration ?? 0,
    lastDurationTick: tick,
    reason: supplied
      ? "active-capital-component"
      : hasSource ? "capital-outside-component" : "no-active-supply-source",
    strength: 0,
  };
}

function matchComponentsByOverlap(
  previous: readonly SupplyComponentState[],
  current: readonly { topologyComponentId: number; regionIds: MesoRegionId[] }[],
): Map<number, SupplyComponentState> {
  const candidates: Array<{
    topologyComponentId: number;
    previous: SupplyComponentState;
    overlap: number;
  }> = [];
  for (const component of current) {
    const regionSet = new Set(component.regionIds);
    for (const oldComponent of previous) {
      let overlap = 0;
      for (const regionId of oldComponent.regionIds) {
        if (regionSet.has(regionId)) overlap += 1;
      }
      if (overlap > 0) {
        candidates.push({
          topologyComponentId: component.topologyComponentId,
          previous: oldComponent,
          overlap,
        });
      }
    }
  }
  candidates.sort((a, b) =>
    b.overlap - a.overlap ||
    compareIds(a.previous.id, b.previous.id) ||
    a.topologyComponentId - b.topologyComponentId
  );
  const result = new Map<number, SupplyComponentState>();
  const usedPreviousIds = new Set<SupplyComponentId>();
  for (const candidate of candidates) {
    if (
      result.has(candidate.topologyComponentId) ||
      usedPreviousIds.has(candidate.previous.id)
    ) continue;
    result.set(candidate.topologyComponentId, candidate.previous);
    usedPreviousIds.add(candidate.previous.id);
  }
  return result;
}

function propagateMaritimeSupply(
  world: WorldState,
  previousComponentByCurrentId: ReadonlyMap<SupplyComponentId, SupplyComponentState>,
  rebuildCandidates: boolean,
): void {
  const state = world.supplyAssessment;
  const startedAt = world.instrumentation ? performance.now() : 0;
  const ownerByRegionId = getOwnerByMesoId(world);
  const bestLinkByComponentPair = new Map<string, MaritimeSupplyLink>();

  if (!rebuildCandidates) {
    for (const previous of state.maritimeLinks) {
      const structuralReason = previous.reason === "port-lost" || previous.reason === "route-invalid"
        ? previous.reason
        : null;
      const link: MaritimeSupplyLink = {
        ...previous,
        transportSupport: [],
        assignedTransportIds: [],
        active: false,
        reason: structuralReason,
      };
      const componentPair = `${link.nationId}:${link.sourceLandComponentId}->${link.destinationLandComponentId}`;
      bestLinkByComponentPair.set(componentPair, link);
    }
    world.instrumentation?.incrementCounter("maritimeLogistics.candidateCacheHits");
  }

  for (const assessment of rebuildCandidates ? state.assessments : []) {
    const ports = world.mesoRegions
      .filter((region) =>
        region.type !== "sea" &&
        region.building === "port" &&
        ownerByRegionId.get(region.id) === assessment.nationId
      )
      .map((region) => region.id)
      .sort(compareIds);
    for (const sourcePortId of ports) {
      for (const destinationPortId of ports) {
        if (sourcePortId === destinationPortId) continue;
        const sourceLandComponentId = resolvePortComponentId(
          world,
          assessment,
          sourcePortId,
        );
        const destinationLandComponentId = resolvePortComponentId(
          world,
          assessment,
          destinationPortId,
        );
        if (
          sourceLandComponentId &&
          sourceLandComponentId === destinationLandComponentId
        ) continue;
        const sourceControlled = isEffectivelyControlledPort(
          world,
          assessment.nationId,
          sourcePortId,
        );
        const destinationControlled = isEffectivelyControlledPort(
          world,
          assessment.nationId,
          destinationPortId,
        );
        const route = getCachedMaritimeRoute(
          world,
          state.maritimeConnectivity,
          sourcePortId,
          destinationPortId,
        );
        let reason: MaritimeSupplyInactiveReason | null = null;
        if (!sourceControlled || !destinationControlled) reason = "port-lost";
        else if (!route) reason = "route-invalid";
        const link: MaritimeSupplyLink = {
          id: `${assessment.nationId}:${sourcePortId}->${destinationPortId}`,
          nationId: assessment.nationId,
          sourcePortId,
          destinationPortId,
          sourceLandComponentId,
          destinationLandComponentId,
          transportSupport: [],
          assignedTransportIds: [],
          requiredTransportCount: 1,
          routeRegionIds: route ?? [],
          active: false,
          reason,
        };
        if (!sourceLandComponentId || !destinationLandComponentId) continue;
        const componentPair = `${assessment.nationId}:${sourceLandComponentId}->${destinationLandComponentId}`;
        const current = bestLinkByComponentPair.get(componentPair);
        if (!current || compareLinkRouteQuality(link, current) < 0) {
          bestLinkByComponentPair.set(componentPair, link);
        }
      }
    }
  }
  const links = [...bestLinkByComponentPair.values()];
  links.sort((a, b) => compareIds(a.id, b.id));
  const assignmentStartedAt = world.instrumentation ? performance.now() : 0;

  const previousLinksById = new Map(state.maritimeLinks.map((link) => [link.id, link]));
  const previousAssignments = state.maritimeLogistics.assignments;
  const previousAssignmentByLinkId = new Map(
    previousAssignments.map((assignment) => [assignment.maritimeLinkId, assignment]),
  );
  const unitById = new Map(world.units.map((unit) => [unit.id, unit]));
  const availableTransports = world.units
    .filter((unit) => isOperationalTransport(unit))
    .sort((a, b) => compareIds(a.id, b.id));
  const availableTransportIds = new Set(availableTransports.map((unit) => unit.id));
  const nextAssignments: TransportAssignment[] = [];

  const reached = new Set<SupplyComponentId>();
  const depthByComponentId = new Map<SupplyComponentId, number>();
  const incomingReasonByComponentId = new Map<
    SupplyComponentId,
    MaritimeSupplyInactiveReason
  >();
  for (const component of state.componentById.values()) {
    if (component.reason !== "active-capital-component") continue;
    reached.add(component.id);
    depthByComponentId.set(component.id, 0);
  }
  const outgoingByComponentId = new Map<SupplyComponentId, MaritimeSupplyLink[]>();
  for (const link of links) {
    if (!link.sourceLandComponentId || !link.destinationLandComponentId) continue;
    const outgoing = outgoingByComponentId.get(link.sourceLandComponentId);
    if (outgoing) outgoing.push(link);
    else outgoingByComponentId.set(link.sourceLandComponentId, [link]);
  }
  const queue = [...reached].sort(compareIds);
  for (let index = 0; index < queue.length; index += 1) {
    const sourceComponentId = queue[index];
    const sourceDepth = depthByComponentId.get(sourceComponentId) ?? 0;
    const candidates = (outgoingByComponentId.get(sourceComponentId) ?? [])
      .filter((link) => !!link.destinationLandComponentId && !reached.has(link.destinationLandComponentId))
      .sort((a, b) => compareMaritimeDemand(world, a, b));
    for (const link of candidates) {
      const destinationId = link.destinationLandComponentId;
      if (!destinationId || reached.has(destinationId)) continue;
      if (link.reason) {
        recordIncomingReason(incomingReasonByComponentId, destinationId, link.reason);
        continue;
      }
      const assignment = assignTransportForLink(
        world,
        link,
        availableTransports,
        availableTransportIds,
        previousAssignmentByLinkId.get(link.id),
      );
      if (!assignment) {
        link.reason = "no-transport";
        recordIncomingReason(incomingReasonByComponentId, destinationId, link.reason);
        continue;
      }
      nextAssignments.push(assignment);
      link.assignedTransportIds = [assignment.transportId];
      link.transportSupport = [assignment.transportId];
      const transport = unitById.get(assignment.transportId);
      if (!transport || !link.routeRegionIds.includes(transport.regionId)) {
        link.reason = "no-transport";
        recordIncomingReason(incomingReasonByComponentId, destinationId, link.reason);
        continue;
      }
      link.active = true;
      link.reason = null;
      reached.add(destinationId);
      depthByComponentId.set(destinationId, sourceDepth + 1);
      queue.push(destinationId);
    }
  }
  for (const link of links) {
    if (!link.active && !link.reason) link.reason = "source-unsupplied";
    if (link.destinationLandComponentId && link.reason) {
      recordIncomingReason(incomingReasonByComponentId, link.destinationLandComponentId, link.reason);
    }
  }

  reconcileTransportAssignments(
    world,
    previousAssignments,
    nextAssignments,
    previousLinksById,
    links,
    unitById,
  );
  if (world.instrumentation) {
    world.instrumentation.recordDuration(
      "maritimeLogistics.assignmentEvaluation",
      performance.now() - assignmentStartedAt,
    );
  }

  let remoteSupplied = 0;
  let remoteIsolated = 0;
  let reconnections = 0;
  let lossesDueToTransport = 0;
  let lossesDueToPortCapture = 0;
  let multiHop = 0;
  let remoteStrengthSupplied = 0;
  let remoteStrengthIsolatedDueToMissingTransport = 0;
  const maritimeComponentIds = new Set<SupplyComponentId>();
  for (const link of links) {
    if (link.sourceLandComponentId) maritimeComponentIds.add(link.sourceLandComponentId);
    if (link.destinationLandComponentId) maritimeComponentIds.add(link.destinationLandComponentId);
  }
  for (const component of state.componentById.values()) {
    const baseSupplied = component.reason === "active-capital-component";
    const supplied = reached.has(component.id);
    const previous = previousComponentByCurrentId.get(component.id);
    const maritimeReason = incomingReasonByComponentId.get(component.id);
    component.supplied = supplied;
    component.isolated = !supplied;
    component.isolatedSinceTick = supplied
      ? previous?.isolatedSinceTick ?? null
      : previous?.supplied === false ? previous.isolatedSinceTick ?? world.time.fastTick : world.time.fastTick;
    component.reconnectedTick = supplied && previous?.supplied === false
      ? world.time.fastTick
      : previous?.reconnectedTick ?? null;
    component.reason = baseSupplied
      ? "active-capital-component"
      : supplied
        ? "maritime-connected"
        : supplyReasonFromMaritime(maritimeReason, component.reason);
    if (!baseSupplied && maritimeComponentIds.has(component.id)) {
      if (supplied) {
        remoteSupplied += 1;
        remoteStrengthSupplied += component.strength;
      } else {
        remoteIsolated += 1;
        if (maritimeReason === "no-transport") {
          remoteStrengthIsolatedDueToMissingTransport += component.strength;
        }
      }
    }
    if (supplied && previous?.supplied === false && component.reason === "maritime-connected") {
      reconnections += 1;
    }
    if (!supplied && previous?.supplied === true) {
      if (maritimeReason === "port-lost") lossesDueToPortCapture += 1;
      if (maritimeReason === "no-transport") lossesDueToTransport += 1;
    }
    if ((depthByComponentId.get(component.id) ?? 0) >= 2) multiHop += 1;
  }

  for (const assessment of state.assessments) {
    assessment.suppliedComponentCount = assessment.components.filter((component) => component.supplied).length;
    assessment.isolatedComponentCount = assessment.components.filter((component) => component.isolated).length;
  }
  state.maritimeLinks = links;
  state.maritimeLinksEvaluated += links.length;
  state.activeMaritimeLinkCount = links.filter((link) => link.active).length;
  state.inactiveMaritimeLinkCount = links.length - state.activeMaritimeLinkCount;
  state.remoteComponentsSupplied = remoteSupplied;
  state.remoteComponentsIsolated = remoteIsolated;
  state.maritimeSupplyLossesDueToTransport += lossesDueToTransport;
  state.maritimeSupplyLossesDueToPortCapture += lossesDueToPortCapture;
  state.maritimeReconnections += reconnections;
  state.multiHopSupplyPropagations += multiHop;
  state.remoteStrengthSupplied = remoteStrengthSupplied;
  state.remoteStrengthIsolatedDueToMissingTransport = remoteStrengthIsolatedDueToMissingTransport;
  updateMaritimeEscortAssignments(world, links);
  const transportCount = availableTransports.length;
  const assignedCount = state.maritimeLogistics.assignments.length;
  world.instrumentation?.incrementCounter("maritimeLogistics.availableTransports", transportCount);
  world.instrumentation?.incrementCounter("maritimeLogistics.assignedTransports", assignedCount);
  world.instrumentation?.incrementCounter("maritimeLogistics.idleTransports", transportCount - assignedCount);
  world.instrumentation?.incrementCounter("maritimeLogistics.linksRequiringTransport", links.length);
  world.instrumentation?.incrementCounter("maritimeLogistics.linksFullySupported", state.activeMaritimeLinkCount);
  world.instrumentation?.incrementCounter(
    "maritimeLogistics.linksUnderSupported",
    links.filter((link) => link.reason === "no-transport").length,
  );
  world.instrumentation?.incrementCounter(
    "maritimeLogistics.transportRouteDistance",
    links.reduce((sum, link) => sum + Math.max(0, link.routeRegionIds.length - 1), 0),
  );
  world.instrumentation?.incrementCounter("maritimeSupply.linksEvaluated", links.length);
  world.instrumentation?.incrementCounter("maritimeSupply.activeLinks", state.activeMaritimeLinkCount);
  world.instrumentation?.incrementCounter("maritimeSupply.inactiveLinks", state.inactiveMaritimeLinkCount);
  world.instrumentation?.incrementCounter("maritimeSupply.remoteComponentsSupplied", remoteSupplied);
  world.instrumentation?.incrementCounter("maritimeSupply.remoteComponentsIsolated", remoteIsolated);
  world.instrumentation?.incrementCounter("maritimeSupply.losses.transport", lossesDueToTransport);
  world.instrumentation?.incrementCounter("maritimeSupply.losses.portCapture", lossesDueToPortCapture);
  world.instrumentation?.incrementCounter("maritimeSupply.reconnections", reconnections);
  world.instrumentation?.incrementCounter("maritimeSupply.multiHopPropagations", multiHop);
  if (world.instrumentation) {
    world.instrumentation.recordDuration(
      "maritimeSupply.evaluation",
      performance.now() - startedAt,
    );
  }
}

function compareLinkRouteQuality(a: MaritimeSupplyLink, b: MaritimeSupplyLink): number {
  const quality = (link: MaritimeSupplyLink): number =>
    link.reason === null ? 0 : link.reason === "port-lost" ? 1 : 2;
  const aInvalid = quality(a);
  const bInvalid = quality(b);
  return aInvalid - bInvalid ||
    a.routeRegionIds.length - b.routeRegionIds.length ||
    compareIds(a.id, b.id);
}

function compareMaritimeDemand(
  world: WorldState,
  a: MaritimeSupplyLink,
  b: MaritimeSupplyLink,
): number {
  const aPriority = maritimeDemandPriority(world, a);
  const bPriority = maritimeDemandPriority(world, b);
  for (let index = 0; index < aPriority.length; index += 1) {
    if (aPriority[index] !== bPriority[index]) return bPriority[index] - aPriority[index];
  }
  return compareIds(a.id, b.id);
}

function maritimeDemandPriority(world: WorldState, link: MaritimeSupplyLink): number[] {
  const component = link.destinationLandComponentId
    ? world.supplyAssessment.componentById.get(link.destinationLandComponentId)
    : undefined;
  if (!component) return [0, 0, 0, 0, 0];
  const regionIds = new Set(component.regionIds);
  const landUnits = world.units.filter((unit) =>
    unit.domain === "land" && unit.nationId === link.nationId && regionIds.has(unit.regionId)
  );
  const frontlineRegions = new Set(
    world.landFronts.operationalSectors.flatMap((sector) => [
      ...sector.sideA.borderRegionIds,
      ...sector.sideB.borderRegionIds,
    ]),
  );
  const hasFrontline = landUnits.some((unit) => frontlineRegions.has(unit.regionId)) ? 1 : 0;
  const important = component.regionIds.some((regionId) => {
    const building = getMesoById(world).get(regionId)?.building;
    return building === "city" || building === "capital" || building === "port";
  }) ? 1 : 0;
  const reorganizing = world.reorganization.plans.some((plan) =>
    plan.nationId === link.nationId && landUnits.some((unit) => unit.id === plan.unitId)
  ) ? 1 : 0;
  return [landUnits.length > 0 ? 1 : 0, hasFrontline, important, reorganizing, component.regionIds.length];
}

function assignTransportForLink(
  world: WorldState,
  link: MaritimeSupplyLink,
  transports: UnitState[],
  availableIds: Set<UnitId>,
  previous: TransportAssignment | undefined,
): TransportAssignment | null {
  let transport = previous && availableIds.has(previous.transportId)
    ? transports.find((unit) => unit.id === previous.transportId)
    : undefined;
  if (!transport) {
    transport = transports
      .filter((unit) => unit.nationId === link.nationId && availableIds.has(unit.id))
      .sort((a, b) =>
        transportDistanceToRoute(a, link) - transportDistanceToRoute(b, link) ||
        compareIds(a.id, b.id)
      )[0];
  }
  if (!transport) return null;
  availableIds.delete(transport.id);
  const positioned = link.routeRegionIds.includes(transport.regionId);
  const positioningRouteIds = positioned
    ? []
    : buildTransportPositioningRoute(world, transport.regionId, link.routeRegionIds);
  return {
    transportId: transport.id,
    maritimeLinkId: link.id,
    sourcePortId: link.sourcePortId,
    destinationPortId: link.destinationPortId,
    status: positioned ? "stationed" : positioningRouteIds.length > 0 ? "moving-to-source" : "unavailable",
    assignedAtFastTick: previous?.transportId === transport.id
      ? previous.assignedAtFastTick
      : world.time.fastTick,
    routeRegionIds: link.routeRegionIds,
    positioningRouteIds,
  };
}

function transportDistanceToRoute(unit: UnitState, link: MaritimeSupplyLink): number {
  const index = link.routeRegionIds.indexOf(unit.regionId);
  return index >= 0 ? 0 : Number.MAX_SAFE_INTEGER;
}

function buildTransportPositioningRoute(
  world: WorldState,
  startId: MesoRegionId,
  targetRouteIds: MesoRegionId[],
): MesoRegionId[] {
  const startedAt = world.instrumentation ? performance.now() : 0;
  const path = buildNavalPositioningRoute(world, startId, targetRouteIds);
  world.instrumentation?.incrementCounter("maritimeLogistics.pathfindingRequests");
  if (world.instrumentation) {
    world.instrumentation.recordDuration(
      "maritimeLogistics.pathfinding",
      performance.now() - startedAt,
    );
  }
  return path;
}

function reconcileTransportAssignments(
  world: WorldState,
  previous: TransportAssignment[],
  next: TransportAssignment[],
  previousLinksById: Map<string, MaritimeSupplyLink>,
  links: MaritimeSupplyLink[],
  unitById: Map<UnitId, UnitState>,
): void {
  const logistics = world.supplyAssessment.maritimeLogistics;
  const previousByTransport = new Map(previous.map((assignment) => [assignment.transportId, assignment]));
  const nextByTransport = new Map(next.map((assignment) => [assignment.transportId, assignment]));
  let changes = 0;
  for (const assignment of previous) {
    const replacement = nextByTransport.get(assignment.transportId);
    if (replacement?.maritimeLinkId !== assignment.maritimeLinkId) changes += 1;
    if (!unitById.has(assignment.transportId)) {
      logistics.transportLosses += 1;
      world.instrumentation?.incrementCounter("maritimeLogistics.transportLosses");
      if (previousLinksById.get(assignment.maritimeLinkId)?.active) {
        logistics.linksBrokenByTransportLoss += 1;
        world.instrumentation?.incrementCounter("maritimeLogistics.linksBrokenByTransportLoss");
      }
    }
  }
  for (const assignment of next) {
    const old = previousByTransport.get(assignment.transportId);
    if (!old) changes += 1;
  }
  for (const link of links) {
    if (link.active && previousLinksById.get(link.id)?.reason === "no-transport") {
      logistics.linksRestoredByReplacement += 1;
      world.instrumentation?.incrementCounter("maritimeLogistics.linksRestoredByReplacement");
    }
  }
  logistics.assignments = next;
  logistics.assignmentByTransportId = nextByTransport;
  logistics.assignmentChanges += changes;
  world.instrumentation?.incrementCounter("maritimeLogistics.assignmentChanges", changes);
  world.instrumentation?.incrementCounter("maritimeLogistics.assignments", next.length);
}

function recordIncomingReason(
  reasons: Map<SupplyComponentId, MaritimeSupplyInactiveReason>,
  componentId: SupplyComponentId,
  reason: MaritimeSupplyInactiveReason,
): void {
  const current = reasons.get(componentId);
  if (!current || inactiveReasonPriority(reason) < inactiveReasonPriority(current)) {
    reasons.set(componentId, reason);
  }
}

function inactiveReasonPriority(reason: MaritimeSupplyInactiveReason): number {
  switch (reason) {
    case "port-lost": return 0;
    case "no-transport": return 1;
    case "route-invalid": return 2;
    case "source-unsupplied": return 3;
  }
}

function supplyReasonFromMaritime(
  reason: MaritimeSupplyInactiveReason | undefined,
  fallback: SupplyStateReason,
): SupplyStateReason {
  if (reason === "port-lost") return "maritime-port-lost";
  if (reason === "route-invalid") return "maritime-route-invalid";
  if (reason === "no-transport") return "maritime-no-transport";
  if (reason === "source-unsupplied") return "maritime-source-unsupplied";
  return fallback;
}

function resolvePortComponentId(
  world: WorldState,
  assessment: NationSupplyAssessment,
  portId: MesoRegionId,
): SupplyComponentId | null {
  const direct = assessment.componentIdByRegionId.get(portId);
  if (direct) return direct;
  for (const neighborId of [...(getNeighborsById(world).get(portId) ?? [])].sort(compareIds)) {
    const adjacent = assessment.componentIdByRegionId.get(neighborId);
    if (adjacent) return adjacent;
  }
  return null;
}

function advanceDurations(state: SupplyAssessmentState, tick: number): void {
  for (const component of state.componentById.values()) {
    const elapsed = Math.max(0, tick - component.lastDurationTick);
    if (component.supplied) component.suppliedDuration += elapsed;
    else component.isolatedDuration += elapsed;
    component.lastDurationTick = tick;
    state.longestIsolationDuration = Math.max(
      state.longestIsolationDuration,
      component.isolatedDuration,
    );
  }
}

function refreshStrengthDiagnostics(world: WorldState): void {
  const state = world.supplyAssessment;
  for (const component of state.componentById.values()) component.strength = 0;
  for (const unit of world.units) {
    if (unit.domain !== "land") continue;
    const assessment = state.assessmentByNationId.get(unit.nationId);
    const componentId = assessment?.componentIdByRegionId.get(unit.regionId);
    const component = componentId ? state.componentById.get(componentId) : undefined;
    if (component) component.strength += getUnitCombatStrength(unit);
  }
  state.largestIsolatedStrength = 0;
  for (const assessment of state.assessments) {
    assessment.largestIsolatedStrength = assessment.components.reduce(
      (largest, component) => component.isolated ? Math.max(largest, component.strength) : largest,
      0,
    );
    assessment.evaluatedAtTick = world.time.fastTick;
    state.largestIsolatedStrength = Math.max(
      state.largestIsolatedStrength,
      assessment.largestIsolatedStrength,
    );
  }
}

function buildCapitalSourceSignature(world: WorldState): string {
  return [...world.nations]
    .filter(isNationActive)
    .sort((a, b) => compareIds(a.id, b.id))
    .map((nation) => `${nation.id}:${getSupplySources(world, nation.id).join(",")}`)
    .join("|");
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
