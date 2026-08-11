import { WORLD_BALANCE } from "../data/balance";
import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import { getMoveMsPerRegion } from "./movement";
import { buildNavalPositioningRoute } from "./naval-pathfinding";
import { isOperationalCombatShip } from "./maritime-escort";
import type { UnitId, UnitState } from "./unit";
import type { WorldState } from "./world-state";
import { getMesoById, getNeighborsById, getOwnerByMesoId, getPortTargetsByNation } from "./world-cache";
import { isNationActive } from "./nation-active";
import { buildWarAdjacency, isAtWar } from "./war-state";
import { isAmphibiousOwnedUnit } from "./amphibious";

export type NavalMissionType = "ESCORT" | "RAID" | "INTERCEPT" | "BLOCKADE" | "RESERVE";
export type NavalMissionStatus = "ACTIVE" | "UNAVAILABLE";

export interface NavalMission {
  id: string;
  nationId: NationId;
  type: NavalMissionType;
  shipIds: UnitId[];
  targetLinkId?: string;
  targetConvoyId?: string;
  targetPortId?: MesoRegionId;
  targetSeaRegionId?: MesoRegionId;
  targetShipId?: UnitId;
  priority: number;
  createdTick: number;
  status: NavalMissionStatus;
  reasonFlags: string[];
  slotIndex?: number;
}

export interface NavalStrategicAssessment {
  nationId: NationId;
  availableCombatShips: number;
  escortDemand: number;
  raidOpportunities: number;
  interceptionThreats: number;
  blockadeOpportunities: number;
  reserveRequirement: number;
  desiredForce: DesiredNavalForce;
  missionPriorities: Partial<Record<NavalMissionType, number>>;
  version: number;
}

export interface DesiredNavalForce {
  nationId: NationId;
  baselineCombatShips: number;
  escortDemand: number;
  interceptionDemand: number;
  offensiveOpportunityDemand: number;
  enemyNavalThreatDemand: number;
  reserveTarget: number;
  desiredCombatShips: number;
  currentCombatShips: number;
  deficit: number;
  reasons: string[];
  hasUsablePort: boolean;
}

export interface NavalStrategyState {
  version: number;
  nextMissionNumber: number;
  assessments: NavalStrategicAssessment[];
  missions: NavalMission[];
  missionById: Map<string, NavalMission>;
  missionByShipId: Map<UnitId, NavalMission>;
  evaluations: number;
  missionCreations: number;
  missionSwitches: number;
  emergencyOverrides: number;
  totalMissionDurationTicks: number;
  assignmentChurn: number;
  interceptedRaids: number;
  defendedConvoys: number;
  enemyTransportsDestroyed: number;
  transportLossesDespiteEscort: number;
  successfulBlockadeInterceptions: number;
  missionDrivenNavalBattles: number;
  fuelConstrainedMissions: number;
  activeEngagementKeys: Set<string>;
  evaluationCpuMs: number;
  assignmentCpuMs: number;
  movementCpuMs: number;
  pathfindingCpuMs: number;
  desiredFleetEvaluationCpuMs: number;
  bootstrapTriggers: number;
  baselineTriggers: number;
  offensiveOpportunityTriggers: number;
  threatTriggers: number;
  fleetsRebuiltAfterLosses: number;
  maximumFleetSize: number;
  zeroFleetSinceTickByNationId: Map<NationId, number>;
  firstCombatShipTickByNationId: Map<NationId, number>;
  firstOffensiveMissionTickByNationId: Map<NationId, number>;
  rebuildPendingNationIds: Set<NationId>;
  zeroFleetToFirstCombatShipTicks: number;
  zeroFleetToFirstCombatShipSamples: number;
  firstCombatShipToOffensiveMissionTicks: number;
  firstCombatShipToOffensiveMissionSamples: number;
}

export type NavalUnitOwnership =
  | {
      controller: "AMPHIBIOUS_CAPABILITY";
      missionType: "TRANSPORT" | "ESCORT";
      demandId: string;
    }
  | {
      controller: "AMPHIBIOUS_OPERATION";
      missionType: "TRANSPORT" | "ESCORT";
      operationId: string;
    }
  | {
      controller: "NAVAL_STRATEGY";
      missionType: NavalMissionType;
      missionId: string;
      reservePortId?: MesoRegionId;
    }
  | {
      controller: "MARITIME_LOGISTICS";
      missionType: "LOGISTICS" | "RESERVE";
      assignmentId?: string;
      reservePortId?: MesoRegionId;
    };

interface MissionCandidate {
  key: string;
  nationId: NationId;
  type: NavalMissionType;
  priority: number;
  reasonFlags: string[];
  targetLinkId?: string;
  targetConvoyId?: string;
  targetPortId?: MesoRegionId;
  targetSeaRegionId?: MesoRegionId;
  targetShipId?: UnitId;
  emergency?: boolean;
  slotIndex?: number;
}

const OFFENSIVE_BOOTSTRAP_MINIMUM_SCORE = 40;

export function createNavalStrategyState(): NavalStrategyState {
  return {
    version: 0, nextMissionNumber: 0, assessments: [], missions: [],
    missionById: new Map(), missionByShipId: new Map(), evaluations: 0,
    missionCreations: 0, missionSwitches: 0, emergencyOverrides: 0,
    totalMissionDurationTicks: 0, assignmentChurn: 0, interceptedRaids: 0,
    defendedConvoys: 0, transportLossesDespiteEscort: 0,
    enemyTransportsDestroyed: 0,
    successfulBlockadeInterceptions: 0, missionDrivenNavalBattles: 0,
    fuelConstrainedMissions: 0,
    activeEngagementKeys: new Set(),
    evaluationCpuMs: 0, assignmentCpuMs: 0, movementCpuMs: 0, pathfindingCpuMs: 0,
    desiredFleetEvaluationCpuMs: 0, bootstrapTriggers: 0, baselineTriggers: 0,
    offensiveOpportunityTriggers: 0, threatTriggers: 0, fleetsRebuiltAfterLosses: 0,
    maximumFleetSize: 0, zeroFleetSinceTickByNationId: new Map(),
    firstCombatShipTickByNationId: new Map(), firstOffensiveMissionTickByNationId: new Map(),
    rebuildPendingNationIds: new Set(),
    zeroFleetToFirstCombatShipTicks: 0, zeroFleetToFirstCombatShipSamples: 0,
    firstCombatShipToOffensiveMissionTicks: 0, firstCombatShipToOffensiveMissionSamples: 0,
  };
}

/** Slow-tick strategic owner for every operational CombatShip. */
export function updateNavalStrategy(world: WorldState): void {
  const state = world.supplyAssessment.navalStrategy;
  const startedAt = world.instrumentation ? performance.now() : 0;
  const previousByKey = new Map(state.missions.map((mission) => [missionKey(mission), mission]));
  const previousByShip = state.missionByShipId;
  const shipsByNation = new Map<NationId, UnitState[]>();
  for (const ship of world.units.filter(isLiveCombatShip).sort(compareUnits)) {
    const ships = shipsByNation.get(ship.nationId);
    if (ships) ships.push(ship); else shipsByNation.set(ship.nationId, [ship]);
  }
  const nextMissions: NavalMission[] = [];
  const assessments: NavalStrategicAssessment[] = [];
  const portsByNation = getPortTargetsByNation(world);
  const activePortNations = world.nations.filter(isNationActive)
    .map((nation) => nation.id).filter((nationId) => (portsByNation.get(nationId)?.length ?? 0) > 0);
  const assessedNationIds = [...new Set([...activePortNations, ...shipsByNation.keys()])].sort(compareIds);
  const desiredStartedAt = world.instrumentation ? performance.now() : 0;
  for (const nationId of assessedNationIds) {
    const ships = shipsByNation.get(nationId) ?? [];
    const operationalShips = ships.filter((ship) =>
      isOperationalCombatShip(ship) && !isAmphibiousOwnedUnit(world, ship.id));
    const candidates = buildCandidates(world, nationId);
    const desiredForce = assessDesiredNavalForce(world, nationId, ships,
      (portsByNation.get(nationId)?.length ?? 0) > 0);
    const bestRaid = candidates.find((candidate) => candidate.type === "RAID");
    const concentrateRaid = new Set(operationalShips.map((ship) => ship.regionId)).size === 1 &&
      !candidates.some((candidate) => candidate.type === "BLOCKADE");
    for (let slot = 1; bestRaid && concentrateRaid && slot < operationalShips.length; slot += 1) {
      candidates.push({ ...bestRaid, key: `${bestRaid.key}:reinforcement-${slot}`, slotIndex: slot,
        priority: bestRaid.priority + 0.1 - slot * 0.001,
        reasonFlags: [...bestRaid.reasonFlags, "fleet-concentration"] });
    }
    candidates.sort((a, b) => b.priority - a.priority || compareIds(a.key, b.key));
    const emergencyCount = candidates.filter((candidate) => candidate.emergency).length;
    const config = WORLD_BALANCE.unit.naval.strategy;
    const reserveRequirement = operationalShips.length >= desiredForce.desiredCombatShips &&
      desiredForce.desiredCombatShips >= config.reserveMinimumFleetSize && emergencyCount === 0
      ? desiredForce.reserveTarget : 0;
    const committedCapacity = Math.max(emergencyCount, operationalShips.length - reserveRequirement);
    const selected = candidates.slice(0, committedCapacity);
    if (emergencyCount === 0 && selected.length > 0) {
      for (const old of state.missions.filter((mission) => mission.nationId === nationId)) {
        const oldCandidate = candidates.find((candidate) => candidate.key === missionKey(old));
        if (!oldCandidate || selected.includes(oldCandidate)) continue;
        const worstIndex = selected.reduce((result, item, index) =>
          item.priority < selected[result].priority ? index : result, 0);
        const committedTicks = world.time.fastTick - old.createdTick;
        if (committedTicks < config.minimumCommitmentTicks ||
          oldCandidate.priority + config.switchingThreshold >= selected[worstIndex].priority) {
          selected[worstIndex] = oldCandidate;
        }
      }
      selected.sort((a, b) => b.priority - a.priority || compareIds(a.key, b.key));
    }
    const available = new Set(operationalShips.map((ship) => ship.id));
    const assignments = new Map<string, UnitId[]>();

    // Stable ownership wins ties and small score changes; emergency missions may override it.
    for (const candidate of selected) {
      const prior = previousByKey.get(candidate.key);
      for (const shipId of prior?.shipIds ?? []) {
        if (!available.delete(shipId)) continue;
        assignments.set(candidate.key, [...(assignments.get(candidate.key) ?? []), shipId]);
        break;
      }
    }
    for (const candidate of selected) {
      if ((assignments.get(candidate.key)?.length ?? 0) > 0) continue;
      const ship = chooseShip(world, ships.filter((item) => available.has(item.id)), candidate, previousByShip);
      if (!ship) continue;
      available.delete(ship.id);
      assignments.set(candidate.key, [ship.id]);
    }
    for (const ship of ships.filter((item) => available.has(item.id))) {
      const portId = selectReservePort(world, nationId, ship);
      const key = `RESERVE:${nationId}:${portId ?? ship.regionId}`;
      assignments.set(key, [...(assignments.get(key) ?? []), ship.id]);
      if (!selected.some((candidate) => candidate.key === key)) selected.push({
        key, nationId, type: "RESERVE", priority: 10,
        reasonFlags: ["strategic-reserve"], targetPortId: portId,
      });
    }
    for (const ship of ships.filter((item): boolean => !isOperationalCombatShip(item))) {
      const portId = selectReservePort(world, nationId, ship);
      const key = `RESERVE:${nationId}:${portId ?? ship.regionId}`;
      assignments.set(key, [...(assignments.get(key) ?? []), ship.id]);
      if (!selected.some((candidate) => candidate.key === key)) selected.push({
        key, nationId, type: "RESERVE", priority: 10,
        reasonFlags: ["strategic-reserve", "unit-unavailable"], targetPortId: portId,
      });
    }

    for (const candidate of selected) {
      const shipIds = assignments.get(candidate.key);
      if (!shipIds?.length) continue;
      const previous = previousByKey.get(candidate.key);
      const fuelUnavailable = shipIds.every((shipId) => {
        const ship = ships.find((item) => item.id === shipId);
        return !isOperationalCombatShip(ship) ||
          !Number.isFinite(ship.moveTicksPerRegion) || ship.combatPower <= 0;
      });
      const mission: NavalMission = {
        id: previous?.id ?? `naval-mission-${state.nextMissionNumber++}`,
        nationId, type: candidate.type, shipIds: [...shipIds].sort(compareIds),
        targetLinkId: candidate.targetLinkId, targetConvoyId: candidate.targetConvoyId,
        targetPortId: candidate.targetPortId, targetSeaRegionId: candidate.targetSeaRegionId,
        targetShipId: candidate.targetShipId, priority: candidate.priority,
        createdTick: previous?.createdTick ?? world.time.fastTick,
        status: fuelUnavailable ? "UNAVAILABLE" : "ACTIVE",
        reasonFlags: [...candidate.reasonFlags, ...(fuelUnavailable ? ["fuel-unavailable"] : [])],
        slotIndex: candidate.slotIndex,
      };
      if (!previous) {
        state.missionCreations += 1;
        world.instrumentation?.incrementCounter("navalStrategy.missionCreations");
      }
      nextMissions.push(mission);
    }
    assessments.push({
      nationId, availableCombatShips: operationalShips.length,
      escortDemand: world.supplyAssessment.maritimeEscorts.demands.filter((d) => d.nationId === nationId).length,
      raidOpportunities: world.supplyAssessment.maritimeInterdiction.assessments.filter((a) => a.attackerNationId === nationId).length,
      interceptionThreats: candidates.filter((c) => c.type === "INTERCEPT").length,
      blockadeOpportunities: candidates.filter((c) => c.type === "BLOCKADE").length,
      reserveRequirement, desiredForce, version: state.version + 1,
      missionPriorities: Object.fromEntries(nextMissions.filter((m) => m.nationId === nationId)
        .map((m) => [m.type, Math.max(m.priority, 0)])),
    });
    recordDesiredForceMetrics(world, desiredForce);
  }
  if (world.instrumentation) {
    const elapsed = performance.now() - desiredStartedAt;
    state.desiredFleetEvaluationCpuMs += elapsed;
    world.instrumentation.recordDuration("navalStrategy.desiredFleet", elapsed);
  }
  const nextByShip = new Map<UnitId, NavalMission>();
  for (const mission of nextMissions) for (const shipId of mission.shipIds) nextByShip.set(shipId, mission);
  for (const [shipId, mission] of nextByShip) {
    const old = previousByShip.get(shipId);
    if (old && missionKey(old) !== missionKey(mission)) {
      state.missionSwitches += 1;
      state.assignmentChurn += 1;
      world.instrumentation?.incrementCounter("navalStrategy.missionSwitches");
      world.instrumentation?.incrementCounter("navalStrategy.assignmentChurn");
      if (mission.type === "INTERCEPT") {
        state.emergencyOverrides += 1;
        world.instrumentation?.incrementCounter("navalStrategy.emergencyOverrides");
      }
    }
  }
  for (const mission of state.missions) {
    state.totalMissionDurationTicks += Math.max(0, world.time.fastTick - mission.createdTick);
  }
  state.missions = nextMissions.sort((a, b) => compareIds(a.id, b.id));
  state.missionById = new Map(state.missions.map((mission) => [mission.id, mission]));
  state.missionByShipId = nextByShip;
  state.assessments = assessments;
  state.fuelConstrainedMissions = nextMissions.filter((mission) =>
    mission.status === "UNAVAILABLE" && mission.reasonFlags.includes("fuel-unavailable")).length;
  state.version += 1;
  state.evaluations += 1;
  updateFleetLifecycleMetrics(world, assessments, nextMissions);
  recordMetrics(world);
  if (world.instrumentation) {
    const elapsed = performance.now() - startedAt;
    state.evaluationCpuMs += elapsed;
    state.assignmentCpuMs += elapsed;
    world.instrumentation.recordDuration("navalStrategy.evaluation", elapsed);
    world.instrumentation.recordDuration("navalStrategy.assignment", elapsed);
  }
}

function buildCandidates(world: WorldState, nationId: NationId): MissionCandidate[] {
  const result: MissionCandidate[] = [];
  const friendlyLinks = new Map(world.supplyAssessment.maritimeLinks
    .filter((link) => link.nationId === nationId).map((link) => [link.id, link]));
  for (const raid of world.supplyAssessment.maritimeInterdiction.assignments) {
    const link = friendlyLinks.get(raid.maritimeLinkId);
    const raider = world.units.find((unit) => unit.id === raid.combatShipId);
    if (!link || !raider) continue;
    const transportId = world.supplyAssessment.convoys.convoyByLinkId.get(link.id)?.transportId;
    const transport = transportId ? world.units.find((unit) => unit.id === transportId) : undefined;
    if (transport && world.units.some((unit) =>
      isOperationalCombatShip(unit, nationId) && unit.regionId === transport.regionId
    )) continue;
    const local = world.units.filter((unit) => isOperationalCombatShip(unit, nationId)).some((ship) => {
      const route = buildNavalPositioningRoute(world, ship.regionId, [raider.regionId]);
      return route.length > 0 && route.length - 1 <= WORLD_BALANCE.unit.naval.strategy.localInterceptRouteSteps;
    });
    if (!local) continue;
    result.push({ key: `INTERCEPT:${nationId}:${raid.combatShipId}`, nationId, type: "INTERCEPT",
      priority: 1000 + raid.targetScore, emergency: true, targetLinkId: link.id,
      targetConvoyId: world.supplyAssessment.convoys.convoyByLinkId.get(link.id)?.id,
      targetShipId: raid.combatShipId, targetSeaRegionId: raider.regionId,
      reasonFlags: ["immediate-raid-threat", "convoy-defense"] });
  }
  for (const demand of world.supplyAssessment.maritimeEscorts.demands.filter((item) => item.nationId === nationId)) {
    const [force, strength, frontline, reconnected, cities, reorganizing, downstream] = demand.priority;
    const pressure = world.supplyAssessment.maritimeInterdiction.assignmentsByLinkId.get(demand.maritimeLinkId)?.length ?? 0;
    const priority = 180 + force * 25 + strength * 0.02 + frontline * 30 + reconnected * 35 +
      cities * 20 + reorganizing * 12 + downstream * 25 + pressure * 50;
    for (let i = 0; i < demand.requiredEscortCount; i += 1) result.push({
      key: `ESCORT:${nationId}:${demand.maritimeLinkId}:${i}`, nationId, type: "ESCORT", priority,
      targetLinkId: demand.maritimeLinkId,
      targetConvoyId: world.supplyAssessment.convoys.convoyByLinkId.get(demand.maritimeLinkId)?.id,
      reasonFlags: [...demand.reasons, ...(pressure ? ["raid-threat"] : [])],
      slotIndex: i,
    });
  }
  const raids = world.supplyAssessment.maritimeInterdiction.assessments
    .filter((item) => item.attackerNationId === nationId);
  for (const assessment of raids) result.push({
    key: `RAID:${nationId}:${assessment.maritimeLinkId}`, nationId, type: "RAID",
    priority: 120 + assessment.targetPriority.total, targetLinkId: assessment.maritimeLinkId,
    targetConvoyId: world.supplyAssessment.convoys.convoyByLinkId.get(assessment.maritimeLinkId)?.id,
    reasonFlags: assessment.targetPriority.reasons.length ? assessment.targetPriority.reasons : ["enemy-convoy"],
  });
  const blockadeThreshold = WORLD_BALANCE.unit.naval.strategy.blockadeMinimumTargetScore;
  for (const assessment of raids.filter((item) => item.targetPriority.total >= blockadeThreshold)) {
    const link = world.supplyAssessment.maritimeLinks.find((item) => item.id === assessment.maritimeLinkId);
    if (!link) continue;
    result.push({ key: `BLOCKADE:${nationId}:${link.sourcePortId}`, nationId, type: "BLOCKADE",
      priority: 70 + assessment.targetPriority.total * 0.5, targetLinkId: link.id,
      targetPortId: link.sourcePortId, reasonFlags: ["important-enemy-port", "persistent-interdiction"] });
  }
  return result.sort((a, b) => b.priority - a.priority || compareIds(a.key, b.key));
}

function assessDesiredNavalForce(
  world: WorldState,
  nationId: NationId,
  ships: UnitState[],
  hasUsablePort: boolean,
): DesiredNavalForce {
  const ownLinks = world.supplyAssessment.maritimeLinks.filter((link) => link.nationId === nationId);
  const meaningfulOwnLinks = ownLinks.filter((link) => {
    const destination = link.destinationLandComponentId
      ? world.supplyAssessment.componentById.get(link.destinationLandComponentId) : undefined;
    return (destination?.strength ?? 0) > 0;
  });
  const escortDemand = Math.min(2, world.supplyAssessment.maritimeEscorts.demands
    .filter((demand) => demand.nationId === nationId)
    .reduce((sum, demand) => sum + demand.requiredEscortCount, 0));
  const offensiveOpportunityDemand = world.supplyAssessment.maritimeInterdiction.assessments
    .some((assessment) => assessment.attackerNationId === nationId &&
      assessment.targetPriority.total >= OFFENSIVE_BOOTSTRAP_MINIMUM_SCORE) ? 1 : 0;
  const warAdjacency = buildWarAdjacency(world.wars);
  const hostileCombatShipsExist = world.units.some((unit) =>
    isOperationalCombatShip(unit) && isAtWar(nationId, unit.nationId, warAdjacency));
  const enemyNavalThreatDemand = hostileCombatShipsExist && (meaningfulOwnLinks.length > 0 || hasUsablePort) ? 1 : 0;
  const interceptionDemand = hostileCombatShipsExist && meaningfulOwnLinks.some((link) => link.active) ? 1 : 0;
  const meaningfulInterest = meaningfulOwnLinks.length > 0 || escortDemand > 0 || offensiveOpportunityDemand > 0 ||
    enemyNavalThreatDemand > 0;
  const baselineCombatShips = hasUsablePort && meaningfulInterest ? 1 : 0;
  const strategicDemand = baselineCombatShips + escortDemand +
    Math.max(interceptionDemand, enemyNavalThreatDemand) + offensiveOpportunityDemand;
  const reserveTarget = strategicDemand >= 3 ? 1 : 0;
  const desiredCombatShips = hasUsablePort ? Math.min(4, strategicDemand + reserveTarget) : 0;
  const currentCombatShips = ships.length;
  const reasons = [
    ...(baselineCombatShips ? ["baseline-fleet"] : []),
    ...(meaningfulOwnLinks.length ? ["own-maritime-supply"] : []),
    ...(escortDemand ? ["escort-deficit"] : []),
    ...(offensiveOpportunityDemand ? ["offensive-bootstrap", "enemy-maritime-supply"] : []),
    ...(interceptionDemand ? ["interception-threat"] : []),
    ...(enemyNavalThreatDemand ? ["naval-threat"] : []),
    ...(reserveTarget ? ["reserve-restoration"] : []),
  ];
  return {
    nationId, baselineCombatShips, escortDemand, interceptionDemand,
    offensiveOpportunityDemand, enemyNavalThreatDemand, reserveTarget,
    desiredCombatShips, currentCombatShips,
    deficit: Math.max(0, desiredCombatShips - currentCombatShips),
    reasons, hasUsablePort,
  };
}

function recordDesiredForceMetrics(world: WorldState, force: DesiredNavalForce): void {
  world.instrumentation?.incrementCounter("navalStrategy.desiredCombatShips", force.desiredCombatShips);
  world.instrumentation?.incrementCounter("navalStrategy.combatShipDeficits", force.deficit);
  if (force.baselineCombatShips) world.instrumentation?.incrementCounter("navalStrategy.triggers.baseline");
  if (force.offensiveOpportunityDemand) {
    world.instrumentation?.incrementCounter("navalStrategy.triggers.offensiveOpportunity");
  }
  if (force.enemyNavalThreatDemand) world.instrumentation?.incrementCounter("navalStrategy.triggers.threat");
}

function updateFleetLifecycleMetrics(
  world: WorldState,
  assessments: NavalStrategicAssessment[],
  missions: NavalMission[],
): void {
  const state = world.supplyAssessment.navalStrategy;
  for (const assessment of assessments) {
    const force = assessment.desiredForce;
    state.maximumFleetSize = Math.max(state.maximumFleetSize, force.currentCombatShips);
    if (force.currentCombatShips === 0 && force.desiredCombatShips > 0) {
      if (!state.zeroFleetSinceTickByNationId.has(force.nationId)) {
        state.zeroFleetSinceTickByNationId.set(force.nationId, world.time.fastTick);
        state.bootstrapTriggers += 1;
        if (force.baselineCombatShips) state.baselineTriggers += 1;
        if (force.offensiveOpportunityDemand) state.offensiveOpportunityTriggers += 1;
        if (force.enemyNavalThreatDemand) state.threatTriggers += 1;
        if (state.firstCombatShipTickByNationId.has(force.nationId)) {
          state.rebuildPendingNationIds.add(force.nationId);
        }
        world.instrumentation?.incrementCounter("navalStrategy.triggers.bootstrap");
      }
      continue;
    }
    if (force.currentCombatShips > 0) {
      const zeroSince = state.zeroFleetSinceTickByNationId.get(force.nationId);
      if (!state.firstCombatShipTickByNationId.has(force.nationId)) {
        state.firstCombatShipTickByNationId.set(force.nationId, world.time.fastTick);
        if (zeroSince !== undefined) {
          state.zeroFleetToFirstCombatShipTicks += Math.max(0, world.time.fastTick - zeroSince);
          state.zeroFleetToFirstCombatShipSamples += 1;
        }
      }
      if (state.rebuildPendingNationIds.delete(force.nationId)) {
        state.fleetsRebuiltAfterLosses += 1;
        world.instrumentation?.incrementCounter("navalStrategy.fleetsRebuilt");
      }
      state.zeroFleetSinceTickByNationId.delete(force.nationId);
    }
    const hasOffensiveMission = missions.some((mission) => mission.nationId === force.nationId &&
      (mission.type === "RAID" || mission.type === "BLOCKADE"));
    if (hasOffensiveMission && !state.firstOffensiveMissionTickByNationId.has(force.nationId)) {
      state.firstOffensiveMissionTickByNationId.set(force.nationId, world.time.fastTick);
      const firstShipTick = state.firstCombatShipTickByNationId.get(force.nationId);
      if (firstShipTick !== undefined) {
        state.firstCombatShipToOffensiveMissionTicks += Math.max(0, world.time.fastTick - firstShipTick);
        state.firstCombatShipToOffensiveMissionSamples += 1;
      }
    }
  }
}

function chooseShip(
  world: WorldState, ships: UnitState[], candidate: MissionCandidate,
  previousByShip: Map<UnitId, NavalMission>,
): UnitState | undefined {
  const costs = new Map<UnitId, number>();
  for (const ship of ships) {
    const old = previousByShip.get(ship.id);
    const commitment = old ? world.time.fastTick - old.createdTick : Number.MAX_SAFE_INTEGER;
    const protectedCommitment = old && old.type === "ESCORT" && !candidate.emergency &&
      commitment < WORLD_BALANCE.unit.naval.strategy.minimumCommitmentTicks ? 1_000_000 : 0;
    const target = candidate.targetShipId
      ? world.units.find((unit) => unit.id === candidate.targetShipId)?.regionId
      : candidate.targetPortId ?? candidate.targetSeaRegionId;
    const route = target ? buildNavalPositioningRoute(world, ship.regionId, [target]) : [ship.regionId];
    costs.set(ship.id, protectedCommitment + (route.length || 10_000));
  }
  return [...ships].sort((a, b) => {
    return (costs.get(a.id) ?? 0) - (costs.get(b.id) ?? 0) || compareIds(a.id, b.id);
  })[0];
}

function selectReservePort(world: WorldState, nationId: NationId, ship: UnitState): MesoRegionId | undefined {
  const ownerById = getOwnerByMesoId(world);
  const linked = new Set(world.supplyAssessment.maritimeLinks.filter((link) => link.nationId === nationId)
    .flatMap((link) => [link.sourcePortId, link.destinationPortId]));
  const ports = world.mesoRegions.filter((region) => region.building === "port" && ownerById.get(region.id) === nationId)
    .sort((a, b) => Number(isSuppliedPort(world, nationId, b.id)) - Number(isSuppliedPort(world, nationId, a.id)) ||
      Number(linked.has(b.id)) - Number(linked.has(a.id)) ||
      distanceSquared(ship, a.id, world) - distanceSquared(ship, b.id, world) || compareIds(a.id, b.id));
  return ports[0]?.id;
}

function isSuppliedPort(world: WorldState, nationId: NationId, regionId: MesoRegionId): boolean {
  const assessment = world.supplyAssessment.assessmentByNationId.get(nationId);
  const componentId = assessment?.componentIdByRegionId.get(regionId);
  return !!componentId && assessment?.componentById.get(componentId)?.supplied === true;
}

/** Executes only INTERCEPT and RESERVE positioning; other missions use existing systems. */
export function updateNavalStrategyMovement(world: WorldState, dtMs: number): void {
  const state = world.supplyAssessment.navalStrategy;
  if (!state.missions.some((mission) => mission.type === "INTERCEPT" || mission.type === "RESERVE")) return;
  const startedAt = world.instrumentation ? performance.now() : 0;
  const unitById = new Map(world.units.map((unit) => [unit.id, unit]));
  const neighbors = getNeighborsById(world);
  for (const mission of state.missions) {
    if (mission.type !== "INTERCEPT" && mission.type !== "RESERVE") continue;
    const liveTarget = mission.targetShipId ? unitById.get(mission.targetShipId)?.regionId : undefined;
    const target = liveTarget ?? mission.targetPortId ?? mission.targetSeaRegionId;
    if (!target) continue;
    for (const shipId of mission.shipIds) {
      const ship = unitById.get(shipId);
      if (ship && isAmphibiousOwnedUnit(world, ship.id)) continue;
      if (!isOperationalCombatShip(ship, mission.nationId) || ship.regionId === target) {
        if (ship) resetMovement(ship);
        continue;
      }
      const pathStartedAt = world.instrumentation ? performance.now() : 0;
      const route = buildNavalPositioningRoute(world, ship.regionId, [target]);
      if (world.instrumentation) state.pathfindingCpuMs += performance.now() - pathStartedAt;
      if (mission.type === "INTERCEPT" && route.length - 1 > WORLD_BALANCE.unit.naval.strategy.localInterceptRouteSteps) {
        mission.status = "UNAVAILABLE";
        resetMovement(ship);
        continue;
      }
      const nextId = route[1];
      if (!nextId || !(neighbors.get(ship.regionId) ?? []).includes(nextId)) continue;
      if (ship.moveToId !== nextId) {
        ship.moveFromId = ship.regionId; ship.moveToId = nextId; ship.moveTargetId = target; ship.moveProgressMs = 0;
      }
      ship.moveProgressMs += Math.max(0, dtMs);
      if (ship.moveProgressMs < getMoveMsPerRegion(ship)) continue;
      ship.regionId = nextId; resetMovement(ship);
    }
  }
  if (world.instrumentation) {
    const elapsed = performance.now() - startedAt;
    state.movementCpuMs += elapsed;
    world.instrumentation.recordDuration("navalStrategy.movement", elapsed);
  }
}

export function getNavalMission(world: WorldState, shipId: UnitId): NavalMission | undefined {
  return world.supplyAssessment.navalStrategy.missionByShipId.get(shipId);
}

/** Gives newly produced CombatShips an immediate, stationary owner without
 * duplicating the slow-tick strategic evaluation or doing any pathfinding. */
export function registerNewCombatShipsAsReserve(
  world: WorldState,
  ships: readonly UnitState[],
): void {
  const state = world.supplyAssessment.navalStrategy;
  let changed = false;
  for (const ship of [...ships].filter(isLiveCombatShip).sort(compareUnits)) {
    if (state.missionByShipId.has(ship.id)) continue;
    let mission = state.missions.find((candidate) =>
      candidate.nationId === ship.nationId && candidate.type === "RESERVE" &&
      candidate.targetPortId === ship.regionId);
    if (!mission) {
      mission = {
        id: `naval-mission-${state.nextMissionNumber++}`,
        nationId: ship.nationId,
        type: "RESERVE",
        shipIds: [],
        targetPortId: ship.regionId,
        priority: 10,
        createdTick: world.time.fastTick,
        status: "ACTIVE",
        reasonFlags: ["new-production", "strategic-reserve"],
      };
      state.missions.push(mission);
      state.missionById.set(mission.id, mission);
      state.missionCreations += 1;
      world.instrumentation?.incrementCounter("navalStrategy.missionCreations");
    }
    mission.shipIds.push(ship.id);
    mission.shipIds.sort(compareIds);
    state.missionByShipId.set(ship.id, mission);
    changed = true;
  }
  if (changed) {
    state.missions.sort((a, b) => compareIds(a.id, b.id));
    state.version += 1;
  }
}

/** Single public ownership API. Escort and interdiction are mission executors,
 * never independent owners. Unassigned transports remain logistics reserves. */
export function getNavalUnitOwnership(
  world: WorldState,
  unitId: UnitId,
): NavalUnitOwnership | undefined {
  const unit = world.units.find((candidate) => candidate.id === unitId);
  if (!unit || unit.domain !== "naval" || unit.manpower <= 0) return undefined;
  const amphibious = world.amphibiousOperations.operationByUnitId.get(unitId);
  if (amphibious) return {
    controller: "AMPHIBIOUS_OPERATION",
    missionType: unit.id === amphibious.transportId ? "TRANSPORT" : "ESCORT",
    operationId: amphibious.id,
  };
  const capability = world.amphibiousOperations.capabilityDemandByUnitId.get(unitId);
  if (capability) return {
    controller: "AMPHIBIOUS_CAPABILITY",
    missionType: capability.assignedTransportIds.includes(unitId) ? "TRANSPORT" : "ESCORT",
    demandId: capability.id,
  };
  if (unit.type === "CombatShip") {
    const mission = getNavalMission(world, unit.id);
    return mission ? {
      controller: "NAVAL_STRATEGY",
      missionType: mission.type,
      missionId: mission.id,
      reservePortId: mission.type === "RESERVE" ? mission.targetPortId : undefined,
    } : undefined;
  }
  if (unit.type !== "TransportShip") return undefined;
  const assignment = world.supplyAssessment.maritimeLogistics.assignmentByTransportId.get(unit.id);
  return assignment ? {
    controller: "MARITIME_LOGISTICS",
    missionType: "LOGISTICS",
    assignmentId: assignment.maritimeLinkId,
  } : {
    controller: "MARITIME_LOGISTICS",
    missionType: "RESERVE",
    reservePortId: selectReservePort(world, unit.nationId, unit),
  };
}

function missionKey(mission: NavalMission): string {
  const base = `${mission.type}:${mission.nationId}:${mission.targetShipId ?? mission.targetLinkId ?? mission.targetPortId ?? ""}`;
  if (mission.type === "ESCORT") return `${base}:${mission.slotIndex ?? 0}`;
  if (mission.type === "RAID" && (mission.slotIndex ?? 0) > 0) return `${base}:reinforcement-${mission.slotIndex}`;
  return base;
}
function distanceSquared(ship: UnitState, targetId: MesoRegionId, world: WorldState): number {
  const a = getMesoById(world).get(ship.regionId)?.center; const b = getMesoById(world).get(targetId)?.center;
  if (!a || !b) return Number.MAX_SAFE_INTEGER;
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}
function resetMovement(unit: UnitState): void {
  unit.moveTargetId = null; unit.moveFromId = null; unit.moveToId = null; unit.moveProgressMs = 0;
}
function recordMetrics(world: WorldState): void {
  const state = world.supplyAssessment.navalStrategy;
  world.instrumentation?.incrementCounter("navalStrategy.evaluations");
  for (const type of ["ESCORT", "RAID", "INTERCEPT", "BLOCKADE", "RESERVE"] as const) {
    world.instrumentation?.incrementCounter(`navalStrategy.ships.${type.toLowerCase()}` as
      | "navalStrategy.ships.escort" | "navalStrategy.ships.raid" | "navalStrategy.ships.intercept"
      | "navalStrategy.ships.blockade" | "navalStrategy.ships.reserve",
      state.missions.filter((mission) => mission.type === type).reduce((n, mission) => n + mission.shipIds.length, 0));
  }
  const operationalIds = new Set(world.units.filter((unit) => isOperationalCombatShip(unit))
    .map((unit) => unit.id));
  const assigned = [...state.missionByShipId.keys()].filter((shipId) => operationalIds.has(shipId)).length;
  const operational = operationalIds.size;
  world.instrumentation?.incrementCounter("navalStrategy.ships.unassigned", operational - assigned);
}
function compareUnits(a: UnitState, b: UnitState): number { return compareIds(a.id, b.id); }
function isLiveCombatShip(unit: UnitState): boolean {
  return unit.domain === "naval" && unit.type === "CombatShip" && unit.manpower > 0;
}
function compareIds(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
