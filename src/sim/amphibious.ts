import { WORLD_BALANCE } from "../data/balance";
import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import { canReachControlled, getControlledDistanceField } from "./ai-geography";
import { createAmphibiousConvoy, removeAmphibiousConvoy } from "./convoy-system";
import { releaseUnitFromFrontAllocation } from "./nation-front-allocations";
import { getUnitCombatStrength } from "./unit-strength";
import type { UnitId, UnitState } from "./unit";
import type { WorldState } from "./world-state";
import { getCachedMaritimePositioningSegments, getCachedMaritimeRoute, isEffectivelyControlledPort, isOperationalTransport } from "./maritime-supply";
import { isOperationalCombatShip } from "./maritime-escort";
import { getMesoById, getNeighborsById, getOwnerByMesoId, getPortTargetsByNation } from "./world-cache";
import { buildWarAdjacency, findWar, isAtWar } from "./war-state";
import { moveNavalUnitToward } from "./naval-pathfinding";
import { FAST_TICK_MS } from "./time";
import { getStrategicProgressAssessment } from "./strategic-progress";
import { getCapitalDefenseAssessment } from "./capital-defense";

const PREPARATION_TIMEOUT_TICKS = 2400;

export type AmphibiousPhase = "preparing" | "embarking" | "escort-wait" | "transporting" | "landed" | "cancelled";
export type AmphibiousCancellationReason = "transport-lost" | "escort-lost" | "convoy-lost" | "assets-not-assembled" | "departure-port-lost" | "target-invalid" | "route-invalid" | "war-ended" | "force-lost" | "preparation-timeout";
export type AmphibiousValidationPhase = "planning" | "assembly" | "ready" | "voyage" | "landing";
export type AmphibiousValidationOwner = "strategic-planning" | "fleet-assembly" | "operation-readiness" | "convoy" | "landing";
export type AmphibiousLaunchRejectionReason = "insufficient-strategic-window" | "positioning-unreachable";
export type AmphibiousCapabilityDemandState =
  | "waiting-transport"
  | "waiting-escort"
  | "waiting-landing-force"
  | "assembling"
  | "ready"
  | "expired"
  | "cancelled";

export interface AmphibiousCapabilityDemand {
  id: string;
  nationId: NationId;
  enemyNationId: NationId;
  departurePortId: MesoRegionId;
  destinationPortId: MesoRegionId;
  routeRegionIds: MesoRegionId[];
  reasonFlags: string[];
  desiredTransportCount: number;
  desiredEscortCount: number;
  desiredLandingUnitCount: number;
  requiredLandingStrength: number;
  observedCoastalStrength: number;
  observedReserveStrength: number;
  landingScore: number;
  strategicValue: number;
  immediateDefenderStrength: number;
  reactionStrength: number;
  shortReactionStrength: number;
  mediumReactionStrength: number;
  selectedReason: string;
  targetTypes: AmphibiousTargetType[];
  assaultRatio: number;
  launchReady: boolean;
  waitingReason: string | null;
  forceAssemblyDelayRecorded: boolean;
  priority: number;
  createdAtTick: number;
  lastValidatedAtTick: number;
  state: AmphibiousCapabilityDemandState;
  availableTransportCount: number;
  availableEscortCount: number;
  availableLandingUnitCount: number;
  availableLandingStrength: number;
  assignedTransportIds: UnitId[];
  assignedEscortIds: UnitId[];
  assignedLandingUnitIds: UnitId[];
  fleetReachableAtTick: number | null;
  assemblyStartedAtTick: number | null;
  assemblyCompletedAtTick: number | null;
  assemblyEtaTicks: number;
  initialAssemblyEtaTicks: number;
  readyAtTick: number | null;
  operationCreatedAtTick: number | null;
  operationId: string | null;
}

export interface AmphibiousLaunchFeasibility {
  evaluatedAtTick: number;
  estimatedAssemblyTicks: number;
  estimatedTransportDelayTicks: number;
  estimatedEscortDelayTicks: number;
  estimatedEmbarkationTicks: number;
  estimatedVoyageTicks: number;
  estimatedLandingTicks: number;
  estimatedCompletionTicks: number;
  estimatedCompletionTick: number;
  estimatedOpportunityWindowTicks: number;
  safetyMarginTicks: number;
  accepted: boolean;
  reason: AmphibiousLaunchRejectionReason | null;
  reasonFlags: string[];
}

export interface AmphibiousLaunchRejection extends AmphibiousLaunchFeasibility {
  nationId: NationId;
  enemyNationId: NationId;
  departurePortId: MesoRegionId;
  destinationPortId: MesoRegionId;
  falsePositiveEvaluated: boolean;
}

export interface AmphibiousManifestAssignment {
  unitId: UnitId;
  departurePortId: MesoRegionId;
  controlledDistance: number;
  estimatedArrivalTick: number;
  strength: number;
  arrivedAtTick: number | null;
}

export interface AmphibiousOperation {
  id: string;
  capabilityDemandId: string;
  fleetReadyAtTick: number;
  nationId: NationId;
  enemyNationId: NationId;
  phase: AmphibiousPhase;
  departurePortId: MesoRegionId;
  destinationPortId: MesoRegionId;
  routeRegionIds: MesoRegionId[];
  manifest: AmphibiousManifestAssignment[];
  assignedUnitIds: UnitId[];
  transportIds: UnitId[];
  transportId: UnitId;
  escortIds: UnitId[];
  requiredEscortCount: number;
  convoyId: string | null;
  convoyIds: string[];
  requiredStrength: number;
  assignedStrength: number;
  preparationLeaseStartedAtTick: number;
  preparationLeaseEndedAtTick: number | null;
  phaseStartedAtTick: number;
  completedAtTick: number | null;
  cancellationReason: AmphibiousCancellationReason | null;
  reasonFlags: string[];
  landingScore: number;
  strategicValue: number;
  immediateDefenderStrength: number;
  reactionStrength: number;
  selectedReason: string;
  targetTypes: AmphibiousTargetType[];
  launchFeasibility: AmphibiousLaunchFeasibility;
  launchedAtTick: number | null;
  beachheadOutcome: "pending" | "success" | "failure";
  beachheadEvaluatedAtTick: number | null;
}

export interface AmphibiousOperationState {
  version: number;
  nextOperationNumber: number;
  nextCapabilityDemandNumber: number;
  operations: AmphibiousOperation[];
  capabilityDemands: AmphibiousCapabilityDemand[];
  operationByUnitId: Map<UnitId, AmphibiousOperation>;
  capabilityDemandByUnitId: Map<UnitId, AmphibiousCapabilityDemand>;
  opportunities: number;
  landingPlans: number;
  cancelledPlans: number;
  completedLandings: number;
  embarkationDelayTicks: number;
  transportAssignments: number;
  escortWaitingTicks: number;
  convoyTravelTicks: number;
  transportLosses: number;
  failedLandings: number;
  successfulBeachheads: number;
  failedBeachheads: number;
  assaultStrengthSamples: number;
  totalRequiredAssaultStrength: number;
  totalAssignedAssaultStrength: number;
  utilizationSamples: number;
  totalTransportUtilization: number;
  totalEscortUtilization: number;
  launchesDelayedForForceAssembly: number;
  beachheadSurvivalSamples: number;
  totalBeachheadSurvivalTicks: number;
  evaluationCpuMs: number;
  movementCpuMs: number;
  launchRejections: AmphibiousLaunchRejection[];
  operationsRejected: number;
  operationsAccepted: number;
  feasibilitySampleCount: number;
  totalEstimatedCompletionTicks: number;
  totalOpportunityWindowTicks: number;
  totalSafetyMarginTicks: number;
  falsePositiveCount: number;
  falseNegativeCount: number;
  launchedOperations: number;
  totalCancellationAgeTicks: number;
  capabilityDemandsCreated: number;
  capabilityDemandsSatisfied: number;
  capabilityDemandsExpired: number;
  capabilityDemandsCancelled: number;
  capabilityDemandWaitSamples: number;
  totalCapabilityDemandWaitingTicks: number;
  fleetBuildLatencySamples: number;
  totalFleetBuildLatencyTicks: number;
  operationCreationLatencySamples: number;
  totalOperationCreationLatencyTicks: number;
  capabilityProductionRequests: number;
  capabilityTransportDemand: number;
  capabilityEscortDemand: number;
  capabilityEvaluationCpuMs: number;
  capabilityAssemblyCpuMs: number;
  fleetReachableCount: number;
  fleetAssemblyCount: number;
  assemblyDurationSamples: number;
  totalAssemblyDurationTicks: number;
  assemblyEtaSamples: number;
  totalAssemblyEtaTicks: number;
  assemblySuccesses: number;
  fleetReadyCount: number;
  readyToLaunchLatencySamples: number;
  totalReadyToLaunchLatencyTicks: number;
  positioningTicksRemovedSamples: number;
  totalPositioningTicksRemoved: number;
  planningFailures: number;
  assemblyFailures: number;
  readyFailures: number;
  voyageFailures: number;
  landingFailures: number;
  departurePortCancellations: number;
  landingSiteSamples: number;
  totalLandingScore: number;
  totalStrategicValue: number;
  totalImmediateDefenderStrength: number;
  totalReactionStrength: number;
  landingSiteChanges: number;
  capitalTargets: number;
  portTargets: number;
  strategicCityTargets: number;
  successfulCapitalBeachheads: number;
  successfulPortBeachheads: number;
  successfulStrategicCityBeachheads: number;
}

export type AmphibiousTargetType = "capital" | "port" | "strategic-city";

export function createAmphibiousOperationState(): AmphibiousOperationState {
  return { version: 0, nextOperationNumber: 0, nextCapabilityDemandNumber: 0,
    operations: [], capabilityDemands: [], operationByUnitId: new Map(),
    capabilityDemandByUnitId: new Map(),
    opportunities: 0, landingPlans: 0, cancelledPlans: 0, completedLandings: 0,
    embarkationDelayTicks: 0, transportAssignments: 0, escortWaitingTicks: 0,
    convoyTravelTicks: 0, transportLosses: 0, failedLandings: 0,
    successfulBeachheads: 0, failedBeachheads: 0,
    assaultStrengthSamples: 0, totalRequiredAssaultStrength: 0,
    totalAssignedAssaultStrength: 0, utilizationSamples: 0,
    totalTransportUtilization: 0, totalEscortUtilization: 0,
    launchesDelayedForForceAssembly: 0, beachheadSurvivalSamples: 0,
    totalBeachheadSurvivalTicks: 0, evaluationCpuMs: 0, movementCpuMs: 0,
    launchRejections: [], operationsRejected: 0, operationsAccepted: 0,
    feasibilitySampleCount: 0, totalEstimatedCompletionTicks: 0,
    totalOpportunityWindowTicks: 0, totalSafetyMarginTicks: 0,
    falsePositiveCount: 0, falseNegativeCount: 0, launchedOperations: 0,
    totalCancellationAgeTicks: 0,
    capabilityDemandsCreated: 0, capabilityDemandsSatisfied: 0,
    capabilityDemandsExpired: 0, capabilityDemandsCancelled: 0,
    capabilityDemandWaitSamples: 0, totalCapabilityDemandWaitingTicks: 0,
    fleetBuildLatencySamples: 0, totalFleetBuildLatencyTicks: 0,
    operationCreationLatencySamples: 0, totalOperationCreationLatencyTicks: 0,
    capabilityProductionRequests: 0, capabilityTransportDemand: 0,
    capabilityEscortDemand: 0, capabilityEvaluationCpuMs: 0,
    capabilityAssemblyCpuMs: 0, fleetReachableCount: 0, fleetAssemblyCount: 0,
    assemblyDurationSamples: 0, totalAssemblyDurationTicks: 0,
    assemblyEtaSamples: 0, totalAssemblyEtaTicks: 0, assemblySuccesses: 0,
    fleetReadyCount: 0, readyToLaunchLatencySamples: 0,
    totalReadyToLaunchLatencyTicks: 0, positioningTicksRemovedSamples: 0,
    totalPositioningTicksRemoved: 0,
    planningFailures: 0, assemblyFailures: 0, readyFailures: 0,
    voyageFailures: 0, landingFailures: 0, departurePortCancellations: 0,
    landingSiteSamples: 0, totalLandingScore: 0, totalStrategicValue: 0,
    totalImmediateDefenderStrength: 0, totalReactionStrength: 0,
    landingSiteChanges: 0, capitalTargets: 0, portTargets: 0,
    strategicCityTargets: 0, successfulCapitalBeachheads: 0,
    successfulPortBeachheads: 0, successfulStrategicCityBeachheads: 0 };
}

/** Slow-tick strategic evaluator. It only considers cached ports, fronts and supply data. */
export function updateAmphibiousPlanning(world: WorldState): void {
  if (!WORLD_BALANCE.unit.naval?.amphibiousEnabled) return;
  const startedAt = world.instrumentation ? performance.now() : 0;
  reconcileOperations(world);
  evaluateRejectedOutcomes(world);
  const activeNations = new Set(world.amphibiousOperations.operations
    .filter((operation) => operation.phase !== "landed" && operation.phase !== "cancelled")
    .map((operation) => operation.nationId));
  const warAdjacency = buildWarAdjacency(world.wars);
  const portsByNation = getPortTargetsByNation(world);
  for (const demand of world.amphibiousOperations.capabilityDemands) {
    if (!isActiveCapabilityDemand(demand)) continue;
    const ownPorts = (portsByNation.get(demand.nationId) ?? [])
      .filter((id) => isEffectivelyControlledPort(world, demand.nationId, id));
    const enemyPorts = (portsByNation.get(demand.enemyNationId) ?? [])
      .filter((id) => isValidTargetPort(world, demand.nationId, demand.enemyNationId, id));
    const opportunityValid = isAtWar(demand.nationId, demand.enemyNationId, warAdjacency) &&
      ownPorts.length > 0 && enemyPorts.length > 0 &&
      isStrategicOpportunity(world, demand.nationId, demand.enemyNationId);
    const candidate = opportunityValid
      ? chooseCandidate(world, demand.nationId, demand.enemyNationId, ownPorts, enemyPorts)
      : null;
    if (!candidate) {
      expireCapabilityDemand(world, demand);
      continue;
    }
    applyCandidateToDemand(world, demand, candidate);
    refreshCapabilityProgress(world, demand);
    if (demand.state === "ready") createOperationForDemand(world, demand, candidate);
    activeNations.add(demand.nationId);
  }
  for (const nation of [...world.nations].sort((a, b) => compareIds(a.id, b.id))) {
    if (activeNations.has(nation.id)) continue;
    const ownPorts = (portsByNation.get(nation.id) ?? []).filter((id) => isEffectivelyControlledPort(world, nation.id, id));
    if (ownPorts.length === 0) continue;
    const enemies = [...(warAdjacency.get(nation.id) ?? [])].sort(compareIds);
    for (const enemyId of enemies) {
      const enemyPorts = (portsByNation.get(enemyId) ?? []).filter((id) => isValidTargetPort(world, nation.id, enemyId, id));
      if (enemyPorts.length === 0 || !isStrategicOpportunity(world, nation.id, enemyId)) continue;
      world.amphibiousOperations.opportunities += 1;
      world.instrumentation?.incrementCounter("amphibious.opportunities");
      const candidate = chooseCandidate(world, nation.id, enemyId, ownPorts, enemyPorts);
      if (candidate) {
        const demand = createCapabilityDemand(world, candidate);
        refreshCapabilityProgress(world, demand);
        if (demand.state === "ready") createOperationForDemand(world, demand, candidate);
        activeNations.add(nation.id);
      }
      break;
    }
  }
  rebuildOwnership(world);
  if (world.instrumentation) {
    const elapsed = performance.now() - startedAt;
    world.amphibiousOperations.evaluationCpuMs += elapsed;
    world.amphibiousOperations.capabilityEvaluationCpuMs += elapsed;
    world.instrumentation.recordDuration("amphibious.evaluation", elapsed);
    world.instrumentation.recordDuration("amphibious.planning", elapsed);
  }
}

/** Fast-tick lifecycle coordinator; movement itself remains owned by land movement and Convoy. */
export function updateAmphibiousOperations(world: WorldState): void {
  if (!WORLD_BALANCE.unit.naval?.amphibiousEnabled) return;
  const startedAt = world.instrumentation ? performance.now() : 0;
  const unitById = new Map(world.units.map((unit) => [unit.id, unit]));
  for (const operation of world.amphibiousOperations.operations) {
    if (operation.phase === "landed" || operation.phase === "cancelled") continue;
    const validation = getAmphibiousOperationValidation(world, operation, unitById);
    if (validation.failures.length > 0) {
      cancelOperation(world, operation, validation.failures[0]!, validation.phase, unitById);
      continue;
    }
    const force = operation.assignedUnitIds.map((id) => unitById.get(id)).filter((u): u is UnitState => !!u);
    if (operation.phase === "preparing" || operation.phase === "embarking") {
      operation.phase = "embarking";
      let allArrived = true;
      for (const assignment of operation.manifest) {
        const unit = unitById.get(assignment.unitId);
        if (!unit) continue;
        if (unit.regionId === operation.departurePortId) {
          assignment.arrivedAtTick ??= world.time.fastTick;
          unit.moveTargetId = null;
        } else {
          allArrived = false;
          unit.moveTargetId = operation.departurePortId;
        }
      }
      if (!allArrived) { world.amphibiousOperations.embarkationDelayTicks += 1; continue; }
      const transports = operation.transportIds.map((id) => unitById.get(id))
        .filter((unit): unit is UnitState => !!unit);
      const fleetAtPort = transports.every((transport) => {
        if (transport.regionId !== operation.departurePortId) {
          positionShipAtPort(world, transport, operation.departurePortId);
          return false;
        }
        return true;
      });
      if (!fleetAtPort) continue;
      const capacity = Math.max(1, WORLD_BALANCE.unit.navalTransportCapacity ?? 10);
      for (let index = 0; index < force.length; index += 1) {
        const transport = transports[Math.floor(index / capacity)];
        if (!transport) break;
        const unit = force[index]!;
        resetMovement(unit);
        unit.amphibiousEmbarkRequested = false;
        transport.cargoUnits.push(unit);
      }
      const cargoIds = new Set(force.map((unit) => unit.id));
      world.units = world.units.filter((unit) => !cargoIds.has(unit.id));
      operation.phase = "escort-wait";
      operation.phaseStartedAtTick = world.time.fastTick;
      operation.preparationLeaseEndedAtTick = world.time.fastTick;
      continue;
    }
    const transports = operation.transportIds.map((id) => unitById.get(id))
      .filter((unit): unit is UnitState => !!unit);
    if (operation.phase === "escort-wait") {
      if (operation.escortIds.length < operation.requiredEscortCount) {
        world.amphibiousOperations.escortWaitingTicks += 1;
        continue;
      }
      const escortsReady = operation.escortIds.every((id) => {
        const escort = unitById.get(id);
        if (!escort) return false;
        if (escort.regionId !== operation.departurePortId) positionShipAtPort(world, escort, operation.departurePortId);
        return escort.regionId === operation.departurePortId;
      });
      if (!escortsReady) { world.amphibiousOperations.escortWaitingTicks += 1; continue; }
      operation.convoyIds = transports.map((transport, index) => {
        const escortIds = operation.escortIds.filter((_, escortIndex) =>
          escortIndex % transports.length === index);
        return createAmphibiousConvoy(world, `${operation.id}:transport:${index}`, transport.id, escortIds,
          operation.routeRegionIds, operation.departurePortId, operation.destinationPortId).id;
      });
      operation.convoyId = operation.convoyIds[0] ?? null;
      operation.phase = "transporting";
      operation.phaseStartedAtTick = world.time.fastTick;
      operation.launchedAtTick = world.time.fastTick;
      world.amphibiousOperations.launchedOperations += 1;
      world.amphibiousOperations.readyToLaunchLatencySamples += 1;
      world.amphibiousOperations.totalReadyToLaunchLatencyTicks +=
        Math.max(0, world.time.fastTick - operation.fleetReadyAtTick);
      continue;
    }
    if (operation.phase === "transporting") {
      world.amphibiousOperations.convoyTravelTicks += 1;
      if (!transports.every((transport) => transport.regionId === operation.destinationPortId)) continue;
      for (const transport of transports) {
        for (const unit of transport.cargoUnits) {
          unit.regionId = operation.destinationPortId;
          resetMovement(unit);
          world.units.push(unit);
        }
        transport.cargoUnits = [];
      }
      completeOperation(world, operation);
    }
  }
  evaluateBeachheads(world);
  rebuildOwnership(world);
  if (world.instrumentation) world.amphibiousOperations.movementCpuMs += performance.now() - startedAt;
}

export function isAmphibiousOwnedUnit(world: WorldState, unitId: UnitId): boolean {
  return world.amphibiousOperations.operationByUnitId.has(unitId) ||
    world.amphibiousOperations.capabilityDemandByUnitId.has(unitId);
}

/** Capability-owned fast-tick assembly. Land movement is progressed by the
 * existing repositioning system; this coordinator only maintains targets and
 * reuses the existing naval positioning movement. */
export function updateAmphibiousCapabilityAssembly(world: WorldState, dtMs: number): void {
  if (!WORLD_BALANCE.unit.naval?.amphibiousEnabled) return;
  const startedAt = world.instrumentation ? performance.now() : 0;
  const unitById = new Map(world.units.map((unit) => [unit.id, unit]));
  for (const demand of world.amphibiousOperations.capabilityDemands) {
    if (!isActiveCapabilityDemand(demand) || demand.assemblyStartedAtTick === null) continue;
    for (const id of demand.assignedLandingUnitIds) {
      const unit = unitById.get(id);
      if (unit && unit.regionId !== demand.departurePortId) unit.moveTargetId = demand.departurePortId;
    }
    for (const id of [...demand.assignedTransportIds, ...demand.assignedEscortIds]) {
      const unit = unitById.get(id);
      if (unit && unit.regionId !== demand.departurePortId) {
        moveNavalUnitToward(world, unit, demand.departurePortId, dtMs);
      }
    }
    demand.assemblyEtaTicks = Math.max(0, demand.initialAssemblyEtaTicks -
      (world.time.fastTick - demand.assemblyStartedAtTick));
    completeAssemblyIfReady(world, demand, unitById);
  }
  rebuildOwnership(world);
  if (world.instrumentation) {
    const elapsed = performance.now() - startedAt;
    world.amphibiousOperations.capabilityAssemblyCpuMs += elapsed;
    world.instrumentation.recordDuration("amphibious.fleetAssembly", elapsed);
  }
}

function isStrategicOpportunity(world: WorldState, nationId: NationId, enemyId: NationId): boolean {
  const hasLandFront = world.landFronts.operationalSectors.some((front) =>
    front.sideA.nationId === nationId && front.sideB.nationId === enemyId ||
    front.sideA.nationId === enemyId && front.sideB.nationId === nationId);
  const usefulOffensive = world.offensiveOperations.operations.some((operation) =>
    operation.nationId === nationId && operation.enemyNationId === enemyId && operation.outcome === null);
  return !hasLandFront || !usefulOffensive;
}

interface LandingCandidate {
  nationId: NationId;
  enemyId: NationId;
  departure: MesoRegionId;
  destination: MesoRegionId;
  route: MesoRegionId[];
  score: number;
  reasons: string[];
  requiredStrength: number;
  coastalStrength: number;
  reserveStrength: number;
  strategicValue: number;
  immediateDefenderStrength: number;
  reactionStrength: number;
  shortReactionStrength: number;
  mediumReactionStrength: number;
  selectedReason: string;
  targetTypes: AmphibiousTargetType[];
}
function chooseCandidate(world: WorldState, nationId: NationId, enemyId: NationId, departures: MesoRegionId[], destinations: MesoRegionId[]): LandingCandidate | null {
  const startedAt = world.instrumentation ? performance.now() : 0;
  const mesoById = getMesoById(world);
  const neighborsById = getNeighborsById(world);
  const enemyUnits = world.units.filter((unit) => unit.domain === "land" && unit.nationId === enemyId);
  const averageRegionSpan = estimateAverageRegionSpan(world);
  const activeEnemyOperationUnits = new Set(world.offensiveOperations.operations
    .filter((operation) => operation.nationId === enemyId && operation.outcome === null)
    .flatMap((operation) => operation.assignedUnitIds));
  const friendlyObjectives = world.offensiveOperations.operations
    .filter((operation) => operation.nationId === nationId && operation.enemyNationId === enemyId && operation.outcome === null)
    .flatMap((operation) => [operation.primaryTargetRegionId, ...operation.supportingTargetRegionIds]);
  const candidates: LandingCandidate[] = [];
  for (const destination of [...destinations].sort(compareIds).slice(0, 8)) {
    const estimate = estimateAssaultStrength(world, enemyId, destination, enemyUnits,
      averageRegionSpan, activeEnemyOperationUnits);
    const neighboringIds = neighborsById.get(destination) ?? [];
    const coastalBuildings = [destination, ...neighboringIds].map((id) => mesoById.get(id)?.building);
    const capitalCoast = coastalBuildings.includes("capital");
    const strategicCity = coastalBuildings.includes("city");
    const supplySource = world.supplyAssessment.maritimeLinks.some((link) =>
      link.nationId === enemyId && link.sourcePortId === destination);
    const nearbyFriendlyObjective = friendlyObjectives.some((id) =>
      id === destination || neighboringIds.includes(id));
    const expansionRegions = neighboringIds.filter((id) =>
      mesoById.get(id)?.type === "land" && getOwnerByMesoId(world).get(id) === enemyId).length;
    const value = WORLD_BALANCE.unit.amphibiousAssault.landingValue;
    const strategicValue = value.port + (capitalCoast ? value.capital : 0) +
      (strategicCity ? value.strategicCity : 0) +
      (supplySource ? value.maritimeSupplySource : 0) +
      (estimate.immediateDefenderStrength === 0 ? value.weakDefense : 0) +
      expansionRegions * value.inlandExpansionPerRegion +
      (nearbyFriendlyObjective ? value.nearbyFriendlyObjective : 0);
    for (const departure of [...departures].sort(compareIds).slice(0, 8)) {
      const route = getCachedMaritimeRoute(world, world.supplyAssessment.maritimeConnectivity, departure, destination);
      if (!route) continue;
      const risk = WORLD_BALANCE.unit.amphibiousAssault.landingRisk;
      const score = strategicValue -
        estimate.immediateDefenderStrength * risk.immediateDefenderPerStrength -
        estimate.reactionStrength * risk.reactionPerStrength -
        Math.max(0, route.length - 1) * risk.travelPerRouteSegment;
      const reasons = ["enemy-port", ...(capitalCoast ? ["capital-coast"] : []),
        ...(strategicCity ? ["strategic-city"] : []),
        ...(supplySource ? ["maritime-supply-source"] : []),
        ...(estimate.immediateDefenderStrength === 0 ? ["weak-coastal-defense"] : []),
        ...(nearbyFriendlyObjective ? ["nearby-friendly-objective"] : []),
        ...(expansionRegions > 1 ? ["inland-expansion"] : []),
        ...(estimate.enemyOperationStrength > 0 ? ["nearby-enemy-operation"] : []),
        ...(estimate.reserveReactionStrength > 0 ? ["local-reserve-concentration"] : [])];
      const selectedReason = selectLandingReason({ capitalCoast, strategicCity, supplySource,
        weakDefense: estimate.immediateDefenderStrength === 0, nearbyFriendlyObjective,
        expansionRegions, reactionStrength: estimate.reactionStrength });
      const targetTypes: AmphibiousTargetType[] = ["port",
        ...(capitalCoast ? ["capital" as const] : []),
        ...(strategicCity ? ["strategic-city" as const] : [])];
      candidates.push({ nationId, enemyId, departure, destination, route,
        score, reasons, requiredStrength: estimate.requiredStrength,
        coastalStrength: estimate.immediateDefenderStrength,
        reserveStrength: estimate.reactionStrength, strategicValue,
        immediateDefenderStrength: estimate.immediateDefenderStrength,
        reactionStrength: estimate.reactionStrength,
        shortReactionStrength: estimate.shortReactionStrength,
        mediumReactionStrength: estimate.mediumReactionStrength,
        selectedReason, targetTypes });
    }
  }
  const selected = candidates.sort((a, b) => b.score - a.score || compareIds(a.destination, b.destination) || compareIds(a.departure, b.departure))[0] ?? null;
  if (world.instrumentation) {
    world.instrumentation.recordDuration("amphibious.landingSiteEvaluation", performance.now() - startedAt);
  }
  return selected;
}

function estimateAssaultStrength(
  world: WorldState,
  enemyId: NationId,
  destination: MesoRegionId,
  providedEnemyUnits?: readonly UnitState[],
  providedAverageRegionSpan?: number,
  providedEnemyOperationUnits?: ReadonlySet<UnitId>,
): { requiredStrength: number; immediateDefenderStrength: number; reactionStrength: number;
  shortReactionStrength: number; mediumReactionStrength: number; reserveReactionStrength: number;
  enemyOperationStrength: number } {
  const enemyUnits = providedEnemyUnits ?? world.units.filter((unit) =>
    unit.domain === "land" && unit.nationId === enemyId);
  const destinationCenter = getMesoById(world).get(destination)?.center;
  const averageRegionSpan = providedAverageRegionSpan ?? estimateAverageRegionSpan(world);
  const enemyOperationUnits = providedEnemyOperationUnits ?? new Set(world.offensiveOperations.operations
    .filter((operation) => operation.nationId === enemyId && operation.outcome === null)
    .flatMap((operation) => operation.assignedUnitIds));
  const balance = WORLD_BALANCE.unit.amphibiousAssault;
  const shortWindow = balance.beachheadSurvivalTicks * balance.reactionShortWindowFraction;
  const mediumWindow = balance.beachheadSurvivalTicks * balance.reactionMediumWindowFraction;
  let immediateDefenderStrength = 0;
  let shortReactionStrength = 0;
  let mediumReactionStrength = 0;
  let reserveReactionStrength = 0;
  let enemyOperationStrength = 0;
  for (const unit of enemyUnits) {
    const strength = getUnitCombatStrength(unit);
    if (unit.regionId === destination) { immediateDefenderStrength += strength; continue; }
    const center = getMesoById(world).get(unit.regionId)?.center;
    if (!center || !destinationCenter || !Number.isFinite(unit.moveTicksPerRegion)) continue;
    const directDistance = Math.hypot(center.x - destinationCenter.x, center.y - destinationCenter.y);
    const estimatedSegments = Math.max(1, Math.ceil(directDistance / averageRegionSpan));
    const progressTicks = Math.floor(Math.max(0, unit.moveProgressMs) / FAST_TICK_MS);
    const arrivalTicks = Math.max(0, estimatedSegments * Math.max(1, unit.moveTicksPerRegion) - progressTicks);
    if (arrivalTicks > mediumWindow) continue;
    if (arrivalTicks <= shortWindow) shortReactionStrength += strength;
    else mediumReactionStrength += strength;
    if (world.strategicReserves.reserveNationByUnitId.get(unit.id) === enemyId) reserveReactionStrength += strength;
    if (enemyOperationUnits.has(unit.id)) enemyOperationStrength += strength;
  }
  const reactionStrength = shortReactionStrength * balance.reactionShortWeight +
    mediumReactionStrength * balance.reactionMediumWeight;
  return {
    immediateDefenderStrength, reactionStrength, shortReactionStrength, mediumReactionStrength,
    reserveReactionStrength, enemyOperationStrength,
    requiredStrength: Math.max(0.5,
      immediateDefenderStrength * balance.coastalDefenseMultiplier + reactionStrength),
  };
}

function createCapabilityDemand(world: WorldState, candidate: LandingCandidate): AmphibiousCapabilityDemand {
  const requirement = deriveForceRequirement(world, candidate.nationId, candidate.departure, candidate.requiredStrength);
  const demand: AmphibiousCapabilityDemand = {
    id: `amphibious-capability-${world.amphibiousOperations.nextCapabilityDemandNumber++}`,
    nationId: candidate.nationId,
    enemyNationId: candidate.enemyId,
    departurePortId: candidate.departure,
    destinationPortId: candidate.destination,
    routeRegionIds: candidate.route,
    reasonFlags: candidate.reasons,
    desiredTransportCount: requirement.transportCount,
    desiredEscortCount: requirement.escortCount,
    desiredLandingUnitCount: requirement.landUnitCount,
    requiredLandingStrength: candidate.requiredStrength,
    observedCoastalStrength: candidate.coastalStrength,
    observedReserveStrength: candidate.reserveStrength,
    landingScore: candidate.score,
    strategicValue: candidate.strategicValue,
    immediateDefenderStrength: candidate.immediateDefenderStrength,
    reactionStrength: candidate.reactionStrength,
    shortReactionStrength: candidate.shortReactionStrength,
    mediumReactionStrength: candidate.mediumReactionStrength,
    selectedReason: candidate.selectedReason,
    targetTypes: candidate.targetTypes,
    assaultRatio: 0,
    launchReady: false,
    waitingReason: "assembling combat power",
    forceAssemblyDelayRecorded: false,
    priority: candidate.score,
    createdAtTick: world.time.fastTick,
    lastValidatedAtTick: world.time.fastTick,
    state: "waiting-transport",
    availableTransportCount: 0,
    availableEscortCount: 0,
    availableLandingUnitCount: 0,
    availableLandingStrength: 0,
    assignedTransportIds: [],
    assignedEscortIds: [],
    assignedLandingUnitIds: [],
    fleetReachableAtTick: null,
    assemblyStartedAtTick: null,
    assemblyCompletedAtTick: null,
    assemblyEtaTicks: 0,
    initialAssemblyEtaTicks: 0,
    readyAtTick: null,
    operationCreatedAtTick: null,
    operationId: null,
  };
  world.amphibiousOperations.capabilityDemands.push(demand);
  world.amphibiousOperations.capabilityDemandsCreated += 1;
  world.amphibiousOperations.version += 1;
  world.instrumentation?.incrementCounter("amphibious.capabilityDemands");
  return demand;
}

function applyCandidateToDemand(world: WorldState, demand: AmphibiousCapabilityDemand, candidate: LandingCandidate): void {
  const siteChanged = demand.destinationPortId !== candidate.destination;
  const departureChanged = demand.departurePortId !== candidate.departure;
  if (siteChanged) {
    world.amphibiousOperations.landingSiteChanges += 1;
    world.instrumentation?.incrementCounter("amphibious.landingSiteChanges");
  }
  if (departureChanged) releaseCapabilityAssignments(world, demand);
  demand.departurePortId = candidate.departure;
  demand.destinationPortId = candidate.destination;
  demand.routeRegionIds = candidate.route;
  demand.reasonFlags = candidate.reasons;
  demand.priority = candidate.score;
  demand.requiredLandingStrength = candidate.requiredStrength;
  demand.observedCoastalStrength = candidate.coastalStrength;
  demand.observedReserveStrength = candidate.reserveStrength;
  demand.landingScore = candidate.score;
  demand.strategicValue = candidate.strategicValue;
  demand.immediateDefenderStrength = candidate.immediateDefenderStrength;
  demand.reactionStrength = candidate.reactionStrength;
  demand.shortReactionStrength = candidate.shortReactionStrength;
  demand.mediumReactionStrength = candidate.mediumReactionStrength;
  demand.selectedReason = candidate.selectedReason;
  demand.targetTypes = candidate.targetTypes;
  const requirement = deriveForceRequirement(world, demand.nationId, demand.departurePortId,
    demand.requiredLandingStrength);
  demand.desiredLandingUnitCount = requirement.landUnitCount;
  demand.desiredTransportCount = requirement.transportCount;
  demand.desiredEscortCount = requirement.escortCount;
}

function refreshCapabilityProgress(world: WorldState, demand: AmphibiousCapabilityDemand): void {
  const unitById = new Map(world.units.map((unit) => [unit.id, unit]));
  demand.assignedTransportIds = demand.assignedTransportIds.filter((id) => {
    const unit = unitById.get(id);
    return isOperationalTransport(unit, demand.nationId) && Number.isFinite(unit!.moveTicksPerRegion) &&
      getCachedMaritimePositioningSegments(world, unit!.regionId, demand.departurePortId) !== null;
  });
  demand.assignedEscortIds = demand.assignedEscortIds.filter((id) => {
    const unit = unitById.get(id);
    return isOperationalCombatShip(unit, demand.nationId) && Number.isFinite(unit!.moveTicksPerRegion) &&
      getCachedMaritimePositioningSegments(world, unit!.regionId, demand.departurePortId) !== null;
  });
  demand.assignedLandingUnitIds = demand.assignedLandingUnitIds.filter((id) => {
    const unit = unitById.get(id);
    return !!unit && unit.domain === "land" && unit.nationId === demand.nationId &&
      canReachControlled(world, demand.nationId, unit.regionId, demand.departurePortId);
  });
  rebuildOwnership(world);
  const transports = findAvailableTransports(world, demand.nationId, demand.departurePortId);
  const escorts = findAvailableEscorts(world, demand.nationId, demand.departurePortId);
  const landingForce = selectLandingForce(world, demand.nationId, demand.departurePortId,
    demand.requiredLandingStrength, demand.desiredLandingUnitCount);
  demand.assignedTransportIds.push(...transports.slice(0,
    Math.max(0, demand.desiredTransportCount - demand.assignedTransportIds.length)).map((unit) => unit.id));
  demand.assignedEscortIds.push(...escorts.slice(0,
    Math.max(0, demand.desiredEscortCount - demand.assignedEscortIds.length)).map((unit) => unit.id));
  const landingById = new Map([
    ...demand.assignedLandingUnitIds.map((id) => [id, unitById.get(id)] as const),
    ...landingForce.units.map((unit) => [unit.id, unit] as const),
  ]);
  const selectedLandingUnits = [...landingById.values()].filter((unit): unit is UnitState => !!unit)
    .sort(compareLandingUnits).slice(0, demand.desiredLandingUnitCount);
  demand.assignedLandingUnitIds = selectedLandingUnits.map((unit) => unit.id);
  for (const unit of selectedLandingUnits) {
    releaseUnitFromFrontAllocation(world, unit.id);
    if (unit.regionId !== demand.departurePortId) unit.moveTargetId = demand.departurePortId;
  }
  const previousState = demand.state;
  demand.availableTransportCount = demand.assignedTransportIds.length;
  demand.availableEscortCount = demand.assignedEscortIds.length;
  demand.availableLandingUnitCount = selectedLandingUnits.length;
  demand.availableLandingStrength = selectedLandingUnits.reduce((sum, unit) => sum + getUnitCombatStrength(unit), 0);
  demand.assaultRatio = demand.requiredLandingStrength > 0
    ? demand.availableLandingStrength / demand.requiredLandingStrength : 0;
  demand.lastValidatedAtTick = world.time.fastTick;
  const fleetReachable = demand.availableTransportCount >= demand.desiredTransportCount &&
    demand.availableEscortCount >= demand.desiredEscortCount;
  const forceReady = demand.availableLandingUnitCount >= demand.desiredLandingUnitCount &&
    demand.availableLandingStrength >= demand.requiredLandingStrength;
  const opportunityWindow = estimateOpportunityWindow(world, demand.nationId, demand.enemyNationId).ticks;
  const emergencyReady = opportunityWindow <= WORLD_BALANCE.unit.amphibiousAssault.emergencyWindowTicks &&
    demand.assaultRatio >= WORLD_BALANCE.unit.amphibiousAssault.emergencyMinimumAssaultRatio &&
    demand.availableTransportCount >= Math.ceil(demand.availableLandingUnitCount /
      Math.max(1, WORLD_BALANCE.unit.navalTransportCapacity ?? 10)) &&
    demand.availableEscortCount >= Math.min(demand.desiredEscortCount, demand.availableTransportCount);
  demand.launchReady = fleetReachable && forceReady || emergencyReady;
  if (!fleetReachable || !forceReady) {
    if (emergencyReady) {
      demand.waitingReason = null;
      startAssembly(world, demand, unitById);
      completeAssemblyIfReady(world, demand, unitById);
    } else {
      demand.state = demand.availableTransportCount < demand.desiredTransportCount ? "waiting-transport"
        : demand.availableEscortCount < demand.desiredEscortCount ? "waiting-escort" : "waiting-landing-force";
      demand.waitingReason = demand.state === "waiting-transport" ? "waiting for transport capacity"
        : demand.state === "waiting-escort" ? "waiting for escorts" : "assembling combat power";
      if (demand.state === "waiting-landing-force" && !demand.forceAssemblyDelayRecorded) {
        demand.forceAssemblyDelayRecorded = true;
        world.amphibiousOperations.launchesDelayedForForceAssembly += 1;
      }
    }
  } else {
    demand.waitingReason = null;
    startAssembly(world, demand, unitById);
    completeAssemblyIfReady(world, demand, unitById);
  }
  rebuildOwnership(world);
  if (previousState !== demand.state || demand.state !== "ready") {
    world.amphibiousOperations.version += 1;
  }
}

function startAssembly(
  world: WorldState,
  demand: AmphibiousCapabilityDemand,
  unitById: ReadonlyMap<UnitId, UnitState>,
): void {
  const currentEtaTicks = estimateAssemblyTicks(world, demand, unitById);
  if (demand.fleetReachableAtTick === null) {
    demand.fleetReachableAtTick = world.time.fastTick;
    world.amphibiousOperations.fleetReachableCount += 1;
    world.instrumentation?.incrementCounter("amphibious.fleetReachable");
  }
  if (demand.assemblyStartedAtTick === null) {
    demand.assemblyStartedAtTick = world.time.fastTick;
    demand.initialAssemblyEtaTicks = currentEtaTicks;
    world.amphibiousOperations.fleetAssemblyCount += 1;
    world.amphibiousOperations.assemblyEtaSamples += 1;
    world.amphibiousOperations.totalAssemblyEtaTicks += demand.initialAssemblyEtaTicks;
    world.amphibiousOperations.positioningTicksRemovedSamples += 1;
    world.amphibiousOperations.totalPositioningTicksRemoved += demand.initialAssemblyEtaTicks;
    world.instrumentation?.incrementCounter("amphibious.fleetAssembly");
  }
  demand.assemblyEtaTicks = currentEtaTicks;
  demand.state = "assembling";
}

function estimateAssemblyTicks(
  world: WorldState,
  demand: AmphibiousCapabilityDemand,
  unitById: ReadonlyMap<UnitId, UnitState>,
): number {
  const distance = getControlledDistanceField(world, demand.nationId, [demand.departurePortId]).distanceByRegionId;
  let maximum = 0;
  for (const id of demand.assignedLandingUnitIds) {
    const unit = unitById.get(id);
    if (unit) maximum = Math.max(maximum, (distance.get(unit.regionId) ?? 0) * Math.max(1, Math.round(unit.moveTicksPerRegion)));
  }
  for (const id of [...demand.assignedTransportIds, ...demand.assignedEscortIds]) {
    const unit = unitById.get(id);
    if (!unit) continue;
    maximum = Math.max(maximum, positioningTicks(unit,
      getCachedMaritimePositioningSegments(world, unit.regionId, demand.departurePortId)));
  }
  return maximum;
}

function completeAssemblyIfReady(
  world: WorldState,
  demand: AmphibiousCapabilityDemand,
  unitById: ReadonlyMap<UnitId, UnitState>,
): void {
  const allIds = [...demand.assignedTransportIds, ...demand.assignedEscortIds, ...demand.assignedLandingUnitIds];
  if (allIds.length === 0 || !allIds.every((id) => unitById.get(id)?.regionId === demand.departurePortId)) return;
  demand.state = "ready";
  demand.launchReady = true;
  demand.waitingReason = null;
  demand.assemblyEtaTicks = 0;
  if (demand.readyAtTick !== null) return;
  demand.readyAtTick = world.time.fastTick;
  demand.assemblyCompletedAtTick = world.time.fastTick;
  const state = world.amphibiousOperations;
  state.fleetBuildLatencySamples += 1;
  state.totalFleetBuildLatencyTicks += Math.max(0, world.time.fastTick - demand.createdAtTick);
  state.assemblyDurationSamples += 1;
  state.totalAssemblyDurationTicks += Math.max(0, world.time.fastTick - (demand.assemblyStartedAtTick ?? world.time.fastTick));
  state.assemblySuccesses += 1;
  state.fleetReadyCount += 1;
  state.version += 1;
  world.instrumentation?.incrementCounter("amphibious.assemblySuccess");
  world.instrumentation?.incrementCounter("amphibious.fleetReady");
}

function expireCapabilityDemand(world: WorldState, demand: AmphibiousCapabilityDemand): void {
  const validationPhase: AmphibiousValidationPhase = demand.state === "assembling" ? "assembly" : "planning";
  releaseCapabilityAssignments(world, demand);
  demand.state = "expired";
  demand.lastValidatedAtTick = world.time.fastTick;
  world.amphibiousOperations.capabilityDemandsExpired += 1;
  if (validationPhase === "assembly") world.amphibiousOperations.assemblyFailures += 1;
  else world.amphibiousOperations.planningFailures += 1;
  world.instrumentation?.incrementCounter(validationPhase === "assembly"
    ? "amphibious.validationFailure.assembly"
    : "amphibious.validationFailure.planning");
  recordCapabilityWait(world, demand);
  world.amphibiousOperations.version += 1;
  world.instrumentation?.incrementCounter("amphibious.capabilityExpired");
}

function recordCapabilityWait(world: WorldState, demand: AmphibiousCapabilityDemand): void {
  world.amphibiousOperations.capabilityDemandWaitSamples += 1;
  world.amphibiousOperations.totalCapabilityDemandWaitingTicks +=
    Math.max(0, world.time.fastTick - demand.createdAtTick);
}

function createOperationForDemand(
  world: WorldState,
  demand: AmphibiousCapabilityDemand,
  candidate: LandingCandidate,
): AmphibiousOperation | null {
  const operation = createOperation(world, demand, candidate);
  if (!operation) return null;
  demand.operationId = operation.id;
  demand.operationCreatedAtTick = world.time.fastTick;
  demand.state = "ready";
  world.amphibiousOperations.capabilityDemandsSatisfied += 1;
  world.amphibiousOperations.operationCreationLatencySamples += 1;
  world.amphibiousOperations.totalOperationCreationLatencyTicks +=
    Math.max(0, world.time.fastTick - demand.createdAtTick);
  recordCapabilityWait(world, demand);
  world.instrumentation?.incrementCounter("amphibious.capabilitySatisfied");
  return operation;
}

function createOperation(world: WorldState, demand: AmphibiousCapabilityDemand, candidate: LandingCandidate): AmphibiousOperation | null {
  const unitById = new Map(world.units.map((unit) => [unit.id, unit]));
  const transports = demand.assignedTransportIds.map((id) => unitById.get(id))
    .filter((unit): unit is UnitState => !!unit);
  if (transports.length === 0 || transports.some((transport) =>
    !isOperationalTransport(transport, candidate.nationId) || !Number.isFinite(transport.moveTicksPerRegion) ||
    transport.regionId !== candidate.departure)) return null;
  const units = demand.assignedLandingUnitIds.map((id) => unitById.get(id)).filter((unit): unit is UnitState => !!unit);
  const strength = units.reduce((sum, unit) => sum + getUnitCombatStrength(unit), 0);
  const emergencyReady = estimateOpportunityWindow(world, candidate.nationId, candidate.enemyId).ticks <=
    WORLD_BALANCE.unit.amphibiousAssault.emergencyWindowTicks &&
    strength / Math.max(0.5, demand.requiredLandingStrength) >=
      WORLD_BALANCE.unit.amphibiousAssault.emergencyMinimumAssaultRatio;
  if (units.length === 0 || strength < demand.requiredLandingStrength && !emergencyReady) return null;
  const escorts = demand.assignedEscortIds.map((id) => unitById.get(id))
    .filter((unit): unit is UnitState => !!unit);
  if (escorts.length < Math.min(demand.desiredEscortCount, transports.length) || escorts.some((escort) =>
    !isOperationalCombatShip(escort, candidate.nationId) || !Number.isFinite(escort.moveTicksPerRegion) ||
    escort.regionId !== candidate.departure)) return null;
  if (units.some((unit) => unit.regionId !== candidate.departure)) return null;
  const feasibility = assessLaunchFeasibility(world, candidate, transports, escorts);
  recordFeasibilitySample(world, feasibility);
  if (!feasibility.accepted) {
    world.amphibiousOperations.operationsRejected += 1;
    world.amphibiousOperations.launchRejections.push({
      ...feasibility, nationId: candidate.nationId, enemyNationId: candidate.enemyId,
      departurePortId: candidate.departure, destinationPortId: candidate.destination,
      falsePositiveEvaluated: false,
    });
    world.amphibiousOperations.version += 1;
    return null;
  }
  for (const unit of units) releaseUnitFromFrontAllocation(world, unit.id);
  const operation: AmphibiousOperation = { id: `amphibious-operation-${world.amphibiousOperations.nextOperationNumber++}`,
    capabilityDemandId: demand.id, fleetReadyAtTick: demand.readyAtTick ?? world.time.fastTick,
    nationId: candidate.nationId, enemyNationId: candidate.enemyId, phase: "preparing",
    departurePortId: candidate.departure, destinationPortId: candidate.destination,
    routeRegionIds: candidate.route, assignedUnitIds: units.map((u) => u.id),
    transportIds: transports.map((transport) => transport.id), transportId: transports[0]!.id,
    escortIds: escorts.map((escort) => escort.id), requiredEscortCount: escorts.length,
    convoyId: null, convoyIds: [], requiredStrength: demand.requiredLandingStrength, assignedStrength: strength,
    manifest: units.map((u) => ({ unitId: u.id, departurePortId: candidate.departure,
      controlledDistance: 0, estimatedArrivalTick: world.time.fastTick,
      strength: getUnitCombatStrength(u), arrivedAtTick: world.time.fastTick })), preparationLeaseStartedAtTick: world.time.fastTick,
    preparationLeaseEndedAtTick: null, phaseStartedAtTick: world.time.fastTick, completedAtTick: null,
    cancellationReason: null, reasonFlags: candidate.reasons,
    landingScore: candidate.score, strategicValue: candidate.strategicValue,
    immediateDefenderStrength: candidate.immediateDefenderStrength,
    reactionStrength: candidate.reactionStrength, selectedReason: candidate.selectedReason,
    targetTypes: candidate.targetTypes,
    launchFeasibility: feasibility, launchedAtTick: null,
    beachheadOutcome: "pending", beachheadEvaluatedAtTick: null };
  world.amphibiousOperations.operations.push(operation); world.amphibiousOperations.landingPlans += 1;
  world.amphibiousOperations.operationsAccepted += 1;
  world.amphibiousOperations.transportAssignments += transports.length;
  const state = world.amphibiousOperations;
  state.assaultStrengthSamples += 1;
  state.totalRequiredAssaultStrength += demand.requiredLandingStrength;
  state.totalAssignedAssaultStrength += strength;
  state.utilizationSamples += 1;
  state.totalTransportUtilization += units.length /
    Math.max(1, transports.length * (WORLD_BALANCE.unit.navalTransportCapacity ?? 10));
  state.totalEscortUtilization += demand.desiredEscortCount / Math.max(1, escorts.length);
  state.landingSiteSamples += 1;
  state.totalLandingScore += candidate.score;
  state.totalStrategicValue += candidate.strategicValue;
  state.totalImmediateDefenderStrength += candidate.immediateDefenderStrength;
  state.totalReactionStrength += candidate.reactionStrength;
  if (candidate.targetTypes.includes("capital")) state.capitalTargets += 1;
  if (candidate.targetTypes.includes("port")) state.portTargets += 1;
  if (candidate.targetTypes.includes("strategic-city")) state.strategicCityTargets += 1;
  world.amphibiousOperations.version += 1;
  world.instrumentation?.incrementCounter("amphibious.landingPlans");
  return operation;
}

export interface AmphibiousValidationResult {
  phase: AmphibiousValidationPhase;
  owner: AmphibiousValidationOwner;
  failures: AmphibiousCancellationReason[];
}

export function getAmphibiousOperationValidation(
  world: WorldState,
  op: AmphibiousOperation,
  providedUnits?: Map<UnitId, UnitState>,
): AmphibiousValidationResult {
  const units = providedUnits ?? new Map(world.units.map((unit) => [unit.id, unit]));
  const transports = op.transportIds.map((id) => units.get(id));
  const atDestination = op.phase === "transporting" && transports.length > 0 &&
    transports.every((transport) => transport?.regionId === op.destinationPortId);
  const phase: AmphibiousValidationPhase = op.phase === "transporting"
    ? atDestination ? "landing" : "voyage"
    : "ready";
  const owner: AmphibiousValidationOwner = phase === "voyage" ? "convoy"
    : phase === "landing" ? "landing" : "operation-readiness";
  const failures: AmphibiousCancellationReason[] = [];
  if (!isAtWar(op.nationId, op.enemyNationId, buildWarAdjacency(world.wars))) failures.push("war-ended");
  if (phase === "ready" && !isEffectivelyControlledPort(world, op.nationId, op.departurePortId)) {
    failures.push("departure-port-lost");
  }
  if (!isValidTargetPort(world, op.nationId, op.enemyNationId, op.destinationPortId)) failures.push("target-invalid");
  if ((phase === "ready" || phase === "voyage") &&
    !isStoredRouteValid(world, op.routeRegionIds, op.departurePortId, op.destinationPortId)) {
    failures.push("route-invalid");
  }
  if (transports.some((transport) => !isOperationalTransport(transport, op.nationId))) failures.push("transport-lost");
  if (op.escortIds.some((id) => !isOperationalCombatShip(units.get(id), op.nationId))) failures.push("escort-lost");
  const liveForce = op.phase === "escort-wait" || op.phase === "transporting"
    ? transports.flatMap((transport) => transport?.cargoUnits ?? [])
    : op.assignedUnitIds.map((id) => units.get(id)).filter(Boolean);
  if (liveForce.length === 0) failures.push("force-lost");
  if (phase === "ready") {
    const forceAssembled = op.phase === "escort-wait"
      ? liveForce.length > 0
      : op.assignedUnitIds.every((id) => units.get(id)?.regionId === op.departurePortId);
    const fleetAssembled = transports.every((transport) => transport?.regionId === op.departurePortId) &&
      op.escortIds.every((id) => units.get(id)?.regionId === op.departurePortId);
    if (!forceAssembled || !fleetAssembled) failures.push("assets-not-assembled");
  }
  if (phase === "ready" && (op.phase === "preparing" || op.phase === "embarking") &&
    world.time.fastTick - op.preparationLeaseStartedAtTick > PREPARATION_TIMEOUT_TICKS) {
    failures.push("preparation-timeout");
  }
  if (phase === "voyage") {
    const convoys = op.convoyIds.map((id) => world.supplyAssessment.convoys.convoyById.get(id));
    if (convoys.length !== op.transportIds.length || convoys.some((convoy) => !convoy || convoy.mission !== "amphibious")) {
      failures.push("convoy-lost");
    } else if (convoys.some((convoy) => !routesEqual(convoy!.route.waypointIds, op.routeRegionIds))) {
      failures.push("route-invalid");
    }
  }
  return { phase, owner, failures: [...new Set(failures)] };
}

function cancelOperation(world: WorldState, op: AmphibiousOperation, reason: AmphibiousCancellationReason, phase: AmphibiousValidationPhase, units: Map<UnitId, UnitState>): void {
  const transports = op.transportIds.map((id) => units.get(id)).filter((unit): unit is UnitState => !!unit);
  for (const transport of transports) if (transport.cargoUnits.length) {
    const region = getMesoById(world).get(transport.regionId);
    if (region?.type !== "sea" && getOwnerByMesoId(world).get(transport.regionId) === op.nationId) {
      for (const unit of transport.cargoUnits) { unit.regionId = transport.regionId; resetMovement(unit); world.units.push(unit); }
    }
    // At sea, cancellation is a failed landing; cargo is lost rather than teleported.
    transport.cargoUnits = [];
  }
  for (const id of [...op.assignedUnitIds, ...op.transportIds, ...op.escortIds]) { const unit = units.get(id); if (unit) resetMovement(unit); }
  for (const convoyId of op.convoyIds) removeAmphibiousConvoy(world, convoyId);
  op.phase = "cancelled"; op.cancellationReason = reason; op.completedAtTick = world.time.fastTick;
  op.preparationLeaseEndedAtTick ??= world.time.fastTick;
  world.amphibiousOperations.cancelledPlans += 1; world.amphibiousOperations.failedLandings += 1;
  if (phase === "ready") world.amphibiousOperations.readyFailures += 1;
  else if (phase === "voyage") world.amphibiousOperations.voyageFailures += 1;
  else if (phase === "landing") world.amphibiousOperations.landingFailures += 1;
  if (reason === "departure-port-lost") world.amphibiousOperations.departurePortCancellations += 1;
  world.amphibiousOperations.totalCancellationAgeTicks += Math.max(0, world.time.fastTick - op.preparationLeaseStartedAtTick);
  if (reason === "war-ended" || reason === "target-invalid" || reason === "departure-port-lost" || reason === "preparation-timeout") {
    world.amphibiousOperations.falseNegativeCount += 1;
  }
  if (reason === "transport-lost") world.amphibiousOperations.transportLosses += 1;
  if (phase === "ready") world.instrumentation?.incrementCounter("amphibious.validationFailure.ready");
  else if (phase === "voyage") world.instrumentation?.incrementCounter("amphibious.validationFailure.voyage");
  else if (phase === "landing") world.instrumentation?.incrementCounter("amphibious.validationFailure.landing");
  if (reason === "departure-port-lost") world.instrumentation?.incrementCounter("amphibious.departurePortCancellation");
  world.amphibiousOperations.version += 1;
}

function completeOperation(world: WorldState, op: AmphibiousOperation): void {
  for (const convoyId of op.convoyIds) removeAmphibiousConvoy(world, convoyId);
  op.phase = "landed"; op.completedAtTick = world.time.fastTick;
  world.amphibiousOperations.completedLandings += 1;
  world.amphibiousOperations.version += 1;
}

function evaluateBeachheads(world: WorldState): void {
  const liveUnits = new Map(world.units.filter((unit) => unit.domain === "land" && unit.manpower > 0)
    .map((unit) => [unit.id, unit]));
  const neighborsById = getNeighborsById(world);
  const ownerById = getOwnerByMesoId(world);
  const survivalThreshold = WORLD_BALANCE.unit.amphibiousAssault.beachheadSurvivalTicks;
  for (const operation of world.amphibiousOperations.operations) {
    if (operation.phase !== "landed" || operation.beachheadOutcome !== "pending" ||
      operation.completedAtTick === null) continue;
    const survivalTicks = Math.max(0, world.time.fastTick - operation.completedAtTick);
    const survivors = operation.assignedUnitIds.map((id) => liveUnits.get(id))
      .filter((unit): unit is UnitState => !!unit);
    if (survivors.length > 0 && survivalTicks < survivalThreshold) continue;
    const beachheadRegions = new Set([
      operation.destinationPortId,
      ...(neighborsById.get(operation.destinationPortId) ?? []),
    ]);
    const held = ownerById.get(operation.destinationPortId) === operation.nationId ||
      survivors.some((unit) => beachheadRegions.has(unit.regionId));
    operation.beachheadOutcome = held ? "success" : "failure";
    operation.beachheadEvaluatedAtTick = world.time.fastTick;
    const state = world.amphibiousOperations;
    state.beachheadSurvivalSamples += 1;
    state.totalBeachheadSurvivalTicks += survivalTicks;
    if (held) {
      state.successfulBeachheads += 1;
      if (operation.targetTypes.includes("capital")) state.successfulCapitalBeachheads += 1;
      if (operation.targetTypes.includes("port")) state.successfulPortBeachheads += 1;
      if (operation.targetTypes.includes("strategic-city")) state.successfulStrategicCityBeachheads += 1;
      world.instrumentation?.incrementCounter("amphibious.successfulBeachheads");
    } else {
      state.failedBeachheads += 1;
    }
    state.version += 1;
  }
}

function assessLaunchFeasibility(
  world: WorldState,
  candidate: LandingCandidate,
  transports: readonly UnitState[],
  escorts: readonly UnitState[],
): AmphibiousLaunchFeasibility {
  const estimatedAssemblyTicks = 0;
  const estimatedTransportDelayTicks = 0;
  const estimatedEscortDelayTicks = 0;
  const estimatedEmbarkationTicks = 1;
  const convoyMoveTicks = Math.max(1,
    ...transports.map((transport) => transport.moveTicksPerRegion),
    ...escorts.map((escort) => escort.moveTicksPerRegion));
  const estimatedVoyageTicks = Math.max(0, candidate.route.length - 1) * Math.round(convoyMoveTicks);
  const estimatedLandingTicks = 1;
  const estimatedCompletionTicks = estimatedEmbarkationTicks +
    estimatedVoyageTicks + estimatedLandingTicks;
  const opportunity = estimateOpportunityWindow(world, candidate.nationId, candidate.enemyId);
  const safetyMarginTicks = opportunity.ticks - estimatedCompletionTicks;
  const reason: AmphibiousLaunchRejectionReason | null = safetyMarginTicks < 0
    ? "insufficient-strategic-window" : null;
  return {
    evaluatedAtTick: world.time.fastTick,
    estimatedAssemblyTicks, estimatedTransportDelayTicks, estimatedEscortDelayTicks,
    estimatedEmbarkationTicks, estimatedVoyageTicks, estimatedLandingTicks,
    estimatedCompletionTicks, estimatedCompletionTick: world.time.fastTick + estimatedCompletionTicks,
    estimatedOpportunityWindowTicks: opportunity.ticks, safetyMarginTicks,
    accepted: reason === null, reason, reasonFlags: opportunity.reasons,
  };
}

function positioningTicks(unit: UnitState, segments: number | null): number {
  if (segments === null) return PREPARATION_TIMEOUT_TICKS + 1;
  const perSegment = Math.max(1, Math.round(unit.moveTicksPerRegion));
  const progressTicks = Math.floor(Math.max(0, unit.moveProgressMs) / FAST_TICK_MS);
  return Math.max(0, segments * perSegment - progressTicks);
}

function estimateOpportunityWindow(
  world: WorldState,
  nationId: NationId,
  enemyId: NationId,
): { ticks: number; reasons: string[] } {
  const reasons: string[] = [];
  const war = findWar(world.wars, nationId, enemyId);
  const warAge = war ? Math.max(0, world.time.fastTick - war.startedAtFastTick) : 0;
  const enemy = world.nations.find((nation) => nation.id === enemyId);
  const threshold = Math.max(0.001, WORLD_BALANCE.war.surrender.threshold);
  const resistance = clamp(1 - (enemy?.surrenderScore ?? 0) / threshold, 0, 1);
  let window = Math.round(120 + resistance * 1080);
  reasons.push(`enemy-resistance:${resistance.toFixed(2)}`);
  const ageWindow = Math.max(240, Math.round(1200 - Math.max(0, warAge - 800) * 0.25));
  if (ageWindow < window) reasons.push("mature-war");
  window = Math.min(window, ageWindow);

  const progress = getStrategicProgressAssessment(world, nationId, enemyId);
  if (progress && progress.score > 0) {
    window = Math.round(window * (1 - Math.min(0.35, progress.score / 100 * 0.35)));
    reasons.push("existing-strategic-progress");
  }
  const activeOffensives = world.offensiveOperations.operations.filter((operation) =>
    operation.nationId === nationId && operation.enemyNationId === enemyId && operation.outcome === null).length;
  if (activeOffensives > 0) {
    window = Math.round(window * Math.max(0.65, 1 - activeOffensives * 0.1));
    reasons.push("active-land-offensive");
  }
  const enemyCapital = getCapitalDefenseAssessment(world, enemyId)?.threatLevel;
  if (enemyCapital === "critical") { window = Math.min(window, 180); reasons.push("enemy-capital-critical"); }
  else if (enemyCapital === "threatened") { window = Math.min(window, 360); reasons.push("enemy-capital-threatened"); }
  const ownCapital = getCapitalDefenseAssessment(world, nationId)?.threatLevel;
  if (ownCapital === "critical") { window = Math.min(window, 120); reasons.push("own-capital-critical"); }
  else if (ownCapital === "threatened") { window = Math.min(window, 300); reasons.push("own-capital-threatened"); }
  return { ticks: Math.max(0, window), reasons };
}

function recordFeasibilitySample(world: WorldState, feasibility: AmphibiousLaunchFeasibility): void {
  const state = world.amphibiousOperations;
  state.feasibilitySampleCount += 1;
  state.totalEstimatedCompletionTicks += feasibility.estimatedCompletionTicks;
  state.totalOpportunityWindowTicks += feasibility.estimatedOpportunityWindowTicks;
  state.totalSafetyMarginTicks += feasibility.safetyMarginTicks;
}

function evaluateRejectedOutcomes(world: WorldState): void {
  const warAdjacency = buildWarAdjacency(world.wars);
  for (const rejection of world.amphibiousOperations.launchRejections) {
    if (rejection.falsePositiveEvaluated || world.time.fastTick < rejection.estimatedCompletionTick) continue;
    rejection.falsePositiveEvaluated = true;
    if (isAtWar(rejection.nationId, rejection.enemyNationId, warAdjacency) &&
      isValidTargetPort(world, rejection.nationId, rejection.enemyNationId, rejection.destinationPortId) &&
      isStrategicOpportunity(world, rejection.nationId, rejection.enemyNationId)) {
      world.amphibiousOperations.falsePositiveCount += 1;
    }
  }
}

function reconcileOperations(world: WorldState): void {
  rebuildOwnership(world);
  for (const demand of world.amphibiousOperations.capabilityDemands) {
    if (!demand.operationId || demand.state !== "ready") continue;
    const operation = world.amphibiousOperations.operations.find((item) => item.id === demand.operationId);
    if (operation?.phase !== "cancelled") continue;
    demand.state = "cancelled";
    demand.lastValidatedAtTick = world.time.fastTick;
    world.amphibiousOperations.capabilityDemandsCancelled += 1;
    world.amphibiousOperations.version += 1;
  }
}

function isActiveCapabilityDemand(demand: AmphibiousCapabilityDemand): boolean {
  return demand.operationId === null &&
    (demand.state === "waiting-transport" || demand.state === "waiting-escort" ||
      demand.state === "waiting-landing-force" || demand.state === "assembling" || demand.state === "ready");
}

function findAvailableTransports(
  world: WorldState,
  nationId: NationId,
  departurePortId?: MesoRegionId,
): UnitState[] {
  const logisticsTransportIds = new Set(
    world.supplyAssessment.maritimeLogistics.assignments.map((assignment) => assignment.transportId),
  );
  return world.units.filter((unit) =>
    isOperationalTransport(unit, nationId) &&
    Number.isFinite(unit.moveTicksPerRegion) &&
    !logisticsTransportIds.has(unit.id) &&
    !isAmphibiousOwnedUnit(world, unit.id) &&
    (departurePortId === undefined ||
      getCachedMaritimePositioningSegments(world, unit.regionId, departurePortId) !== null)
  ).sort(compareUnits);
}

function findAvailableEscorts(
  world: WorldState,
  nationId: NationId,
  departurePortId?: MesoRegionId,
): UnitState[] {
  const reserveIds = new Set(world.supplyAssessment.navalStrategy.missions
    .filter((mission) => mission.nationId === nationId && mission.type === "RESERVE")
    .flatMap((mission) => mission.shipIds));
  return world.units.filter((unit) =>
    isOperationalCombatShip(unit, nationId) &&
    Number.isFinite(unit.moveTicksPerRegion) &&
    reserveIds.has(unit.id) &&
    !isAmphibiousOwnedUnit(world, unit.id) &&
    (departurePortId === undefined ||
      getCachedMaritimePositioningSegments(world, unit.regionId, departurePortId) !== null)
  ).sort(compareUnits);
}

function selectLandingForce(
  world: WorldState,
  nationId: NationId,
  departurePortId: MesoRegionId,
  requiredStrength: number,
  desiredUnitCount: number,
  providedDistance?: Map<MesoRegionId, number>,
): { units: UnitState[]; strength: number } {
  const distance = providedDistance ??
    getControlledDistanceField(world, nationId, [departurePortId]).distanceByRegionId;
  const unavailable = new Set([
    ...world.retreatPlans.retreatIdByUnitId.keys(),
    ...world.reorganization.planIdByUnitId.keys(),
    ...world.strategicReserves.reserveNationByUnitId.keys(),
    ...world.collapseAdvances.advanceNationByUnitId.keys(),
    ...world.offensiveOperations.operations.filter((operation) => operation.outcome === null)
      .flatMap((operation) => operation.assignedUnitIds),
  ]);
  const candidates = world.units.filter((unit) =>
    unit.domain === "land" && unit.nationId === nationId &&
    !unavailable.has(unit.id) &&
    canReachControlled(world, nationId, unit.regionId, departurePortId)
  ).sort(compareLandingUnits);
  const units: UnitState[] = [];
  let strength = 0;
  for (const unit of candidates) {
    if (units.length >= desiredUnitCount && strength >= requiredStrength) break;
    units.push(unit);
    strength += getUnitCombatStrength(unit);
  }
  return { units, strength };
}

function deriveForceRequirement(
  world: WorldState,
  nationId: NationId,
  departurePortId: MesoRegionId,
  requiredStrength: number,
): { landUnitCount: number; transportCount: number; escortCount: number } {
  const distance = getControlledDistanceField(world, nationId, [departurePortId]).distanceByRegionId;
  const unavailable = new Set([
    ...world.retreatPlans.retreatIdByUnitId.keys(),
    ...world.reorganization.planIdByUnitId.keys(),
    ...world.strategicReserves.reserveNationByUnitId.keys(),
    ...world.collapseAdvances.advanceNationByUnitId.keys(),
    ...world.offensiveOperations.operations.filter((operation) => operation.outcome === null)
      .flatMap((operation) => operation.assignedUnitIds),
  ]);
  const eligible = world.units.filter((unit) =>
    unit.domain === "land" && unit.nationId === nationId && !unavailable.has(unit.id) &&
    canReachControlled(world, nationId, unit.regionId, departurePortId) &&
    Number.isFinite(distance.get(unit.regionId))).sort(compareLandingUnits);
  const averageStrength = eligible.length > 0
    ? eligible.reduce((sum, unit) => sum + getUnitCombatStrength(unit), 0) / eligible.length
    : WORLD_BALANCE.unit.types.Infantry.manpower *
      WORLD_BALANCE.unit.types.Infantry.combatPower * 0.75;
  let assembledStrength = 0;
  let landUnitCount = 0;
  for (const unit of eligible) {
    if (assembledStrength >= requiredStrength) break;
    assembledStrength += getUnitCombatStrength(unit);
    landUnitCount += 1;
  }
  if (assembledStrength < requiredStrength) {
    landUnitCount += Math.ceil((requiredStrength - assembledStrength) / Math.max(0.5, averageStrength));
  }
  landUnitCount = Math.max(1, landUnitCount);
  const transportCapacity = Math.max(1, WORLD_BALANCE.unit.navalTransportCapacity ?? 10);
  const transportCount = Math.max(1, Math.ceil(landUnitCount / transportCapacity));
  const escortCount = Math.max(1, Math.ceil(transportCount /
    Math.max(1, WORLD_BALANCE.unit.amphibiousAssault.escortsPerTransports)));
  return { landUnitCount, transportCount, escortCount };
}

export interface AmphibiousNavalProductionDemand {
  nationId: NationId;
  departurePortId: MesoRegionId;
  priority: number;
  transports: number;
  escorts: number;
}

/** Lightweight slow-tick adapter consumed by the unified naval production loop. */
export function getAmphibiousNavalProductionDemands(
  world: WorldState,
): AmphibiousNavalProductionDemand[] {
  const demands: AmphibiousNavalProductionDemand[] = [];
  for (const demand of world.amphibiousOperations.capabilityDemands) {
    if (!isActiveCapabilityDemand(demand)) continue;
    demands.push({
      nationId: demand.nationId,
      departurePortId: demand.departurePortId,
      priority: demand.priority,
      transports: Math.max(0, demand.desiredTransportCount -
        demand.assignedTransportIds.length - findAvailableTransports(world, demand.nationId, demand.departurePortId).length),
      escorts: Math.max(0, demand.desiredEscortCount -
        demand.assignedEscortIds.length - findAvailableEscorts(world, demand.nationId, demand.departurePortId).length),
    });
  }
  return demands;
}

function findAvailableEscort(world: WorldState, nationId: NationId): UnitState | undefined {
  return findAvailableEscorts(world, nationId)[0];
}
function rebuildOwnership(world: WorldState): void {
  const map = new Map<UnitId, AmphibiousOperation>();
  for (const op of world.amphibiousOperations.operations) if (op.phase !== "landed" && op.phase !== "cancelled")
    for (const id of [...op.assignedUnitIds, ...op.transportIds, ...op.escortIds]) map.set(id, op);
  world.amphibiousOperations.operationByUnitId = map;
  const capabilityMap = new Map<UnitId, AmphibiousCapabilityDemand>();
  for (const demand of world.amphibiousOperations.capabilityDemands) {
    if (!isActiveCapabilityDemand(demand)) continue;
    for (const id of [...demand.assignedTransportIds, ...demand.assignedEscortIds, ...demand.assignedLandingUnitIds]) {
      capabilityMap.set(id, demand);
    }
  }
  world.amphibiousOperations.capabilityDemandByUnitId = capabilityMap;
}
function releaseCapabilityAssignments(world: WorldState, demand: AmphibiousCapabilityDemand): void {
  const unitById = new Map(world.units.map((unit) => [unit.id, unit]));
  for (const id of [...demand.assignedTransportIds, ...demand.assignedEscortIds, ...demand.assignedLandingUnitIds]) {
    const unit = unitById.get(id);
    if (unit) resetMovement(unit);
  }
}
function isValidTargetPort(world: WorldState, nationId: NationId, enemyId: NationId, id: MesoRegionId): boolean {
  return getMesoById(world).get(id)?.building === "port" && getOwnerByMesoId(world).get(id) === enemyId && isAtWar(nationId, enemyId, buildWarAdjacency(world.wars));
}
function isStoredRouteValid(world: WorldState, route: readonly MesoRegionId[], departure: MesoRegionId, destination: MesoRegionId): boolean {
  if (route.length < 2 || route[0] !== departure || route.at(-1) !== destination) return false;
  const neighbors = getNeighborsById(world);
  return route.slice(1).every((regionId, index) =>
    (neighbors.get(route[index]!) ?? []).includes(regionId));
}
function routesEqual(a: readonly MesoRegionId[], b: readonly MesoRegionId[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}
function positionShipAtPort(world: WorldState, ship: UnitState, port: MesoRegionId): void {
  moveNavalUnitToward(world, ship, port, FAST_TICK_MS);
}
function resetMovement(unit: UnitState): void { unit.moveTargetId = null; unit.moveFromId = null; unit.moveToId = null; unit.moveProgressMs = 0; }
function compareIds(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function compareUnits(a: UnitState, b: UnitState): number { return compareIds(a.id, b.id); }
function compareLandingUnits(a: UnitState, b: UnitState): number {
  return getUnitCombatStrength(b) - getUnitCombatStrength(a) || compareUnits(a, b);
}
function estimateAverageRegionSpan(world: WorldState): number {
  if (world.cache.averageRegionSpanMapVersion === world.mapVersion) {
    return world.cache.averageRegionSpan;
  }
  const mesoById = getMesoById(world);
  let total = 0;
  let samples = 0;
  for (const region of world.mesoRegions) {
    for (const neighbor of region.neighbors) {
      if (region.id >= neighbor.id) continue;
      const center = mesoById.get(neighbor.id)?.center;
      if (!center) continue;
      total += Math.hypot(region.center.x - center.x, region.center.y - center.y);
      samples += 1;
    }
  }
  world.cache.averageRegionSpan = samples > 0
    ? Math.max(1, total / samples)
    : Math.max(1, Math.min(world.width, world.height) / 10);
  world.cache.averageRegionSpanMapVersion = world.mapVersion;
  return world.cache.averageRegionSpan;
}
function selectLandingReason(factors: { capitalCoast: boolean; strategicCity: boolean;
  supplySource: boolean; weakDefense: boolean; nearbyFriendlyObjective: boolean;
  expansionRegions: number; reactionStrength: number }): string {
  if (factors.weakDefense && factors.reactionStrength === 0) return "isolated weak defense";
  if (factors.supplySource) return "maritime supply source";
  if (factors.nearbyFriendlyObjective) return "supports friendly objective";
  if (factors.expansionRegions > 1) return "inland expansion potential";
  if (factors.capitalCoast) return "capital access worth the risk";
  if (factors.strategicCity) return "strategic city access";
  return "best value-to-reaction balance";
}
function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
