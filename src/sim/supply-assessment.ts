import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import { getControlledTopology } from "./ai-geography";
import { isNationActive } from "./nation-active";
import { getUnitCombatStrength } from "./unit-strength";
import type { WorldState } from "./world-state";
import {
  createMaritimeConnectivityCache,
  evaluateMaritimeTransportPolicy,
  getCachedMaritimeRoute,
  isEffectivelyControlledPort,
  type MaritimeConnectivityCache,
  type MaritimeSupplyInactiveReason,
  type MaritimeSupplyLink,
} from "./maritime-supply";
import { getNeighborsById, getOwnerByMesoId } from "./world-cache";

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
  maritimeLinksEvaluated: number;
  activeMaritimeLinkCount: number;
  inactiveMaritimeLinkCount: number;
  remoteComponentsSupplied: number;
  remoteComponentsIsolated: number;
  maritimeSupplyLossesDueToTransport: number;
  maritimeSupplyLossesDueToPortCapture: number;
  maritimeReconnections: number;
  multiHopSupplyPropagations: number;
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
    maritimeLinksEvaluated: 0,
    activeMaritimeLinkCount: 0,
    inactiveMaritimeLinkCount: 0,
    remoteComponentsSupplied: 0,
    remoteComponentsIsolated: 0,
    maritimeSupplyLossesDueToTransport: 0,
    maritimeSupplyLossesDueToPortCapture: 0,
    maritimeReconnections: 0,
    multiHopSupplyPropagations: 0,
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
  const capitalSourceSignature = buildCapitalSourceSignature(world);
  const dirty =
    state.territoryVersion !== world.territoryVersion ||
    state.occupationVersion !== world.occupation.version ||
    state.buildingVersion !== world.buildingVersion ||
    state.mapVersion !== world.mapVersion ||
    state.capitalSourceSignature !== capitalSourceSignature;

  if (dirty) {
    const rebuildStartedAt = world.instrumentation ? performance.now() : 0;
    rebuildSupplyAssessment(world, capitalSourceSignature);
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
): void {
  const state = world.supplyAssessment;
  const previousByNationId = state.assessmentByNationId;
  const assessments: NationSupplyAssessment[] = [];
  const componentById = new Map<SupplyComponentId, SupplyComponentState>();
  const globalComponentIdByRegionId = new Map<MesoRegionId, SupplyComponentId>();
  const previousComponentByCurrentId = new Map<SupplyComponentId, SupplyComponentState>();

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
      if (matched) previousComponentByCurrentId.set(component.id, matched);
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
  propagateMaritimeSupply(world, previousComponentByCurrentId);
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
): void {
  const state = world.supplyAssessment;
  const startedAt = world.instrumentation ? performance.now() : 0;
  const ownerByRegionId = getOwnerByMesoId(world);
  const links: MaritimeSupplyLink[] = [];

  for (const assessment of state.assessments) {
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
        const transport = evaluateMaritimeTransportPolicy(
          world,
          assessment.nationId,
          sourcePortId,
          destinationPortId,
        );
        let reason: MaritimeSupplyInactiveReason | null = null;
        if (!sourceControlled || !destinationControlled) reason = "port-lost";
        else if (!route) reason = "route-invalid";
        else if (!transport.satisfied) reason = transport.reason ?? "no-transport";
        links.push({
          id: `${assessment.nationId}:${sourcePortId}->${destinationPortId}`,
          nationId: assessment.nationId,
          sourcePortId,
          destinationPortId,
          sourceLandComponentId,
          destinationLandComponentId,
          transportSupport: transport.support,
          routeRegionIds: route ?? [],
          active: false,
          reason,
        });
      }
    }
  }
  links.sort((a, b) => compareIds(a.id, b.id));

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
  for (const link of links) {
    if (!link.destinationLandComponentId || !link.reason) continue;
    const current = incomingReasonByComponentId.get(link.destinationLandComponentId);
    if (!current || inactiveReasonPriority(link.reason) < inactiveReasonPriority(current)) {
      incomingReasonByComponentId.set(link.destinationLandComponentId, link.reason);
    }
  }

  const outgoingByComponentId = new Map<SupplyComponentId, MaritimeSupplyLink[]>();
  for (const link of links) {
    if (!link.sourceLandComponentId || !link.destinationLandComponentId || link.reason) continue;
    const outgoing = outgoingByComponentId.get(link.sourceLandComponentId);
    if (outgoing) outgoing.push(link);
    else outgoingByComponentId.set(link.sourceLandComponentId, [link]);
  }
  const queue = [...reached].sort(compareIds);
  for (let index = 0; index < queue.length; index += 1) {
    const sourceComponentId = queue[index];
    const sourceDepth = depthByComponentId.get(sourceComponentId) ?? 0;
    for (const link of outgoingByComponentId.get(sourceComponentId) ?? []) {
      link.active = true;
      link.reason = null;
      const destinationId = link.destinationLandComponentId;
      if (!destinationId || reached.has(destinationId)) continue;
      reached.add(destinationId);
      depthByComponentId.set(destinationId, sourceDepth + 1);
      queue.push(destinationId);
    }
  }
  for (const link of links) {
    if (!link.active && !link.reason) link.reason = "source-unsupplied";
    if (link.destinationLandComponentId && link.reason) {
      const current = incomingReasonByComponentId.get(link.destinationLandComponentId);
      if (!current || inactiveReasonPriority(link.reason) < inactiveReasonPriority(current)) {
        incomingReasonByComponentId.set(link.destinationLandComponentId, link.reason);
      }
    }
  }

  let remoteSupplied = 0;
  let remoteIsolated = 0;
  let reconnections = 0;
  let lossesDueToTransport = 0;
  let lossesDueToPortCapture = 0;
  let multiHop = 0;
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
      if (supplied) remoteSupplied += 1;
      else remoteIsolated += 1;
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
