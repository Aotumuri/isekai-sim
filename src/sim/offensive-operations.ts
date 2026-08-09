import { WORLD_BALANCE } from "../data/balance";
import type { MesoRegion, MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import {
  getCapitalDefenseAssessment,
  recordCapitalOperationCancellations,
} from "./capital-defense";
import {
  getFrontSide,
  getOpposingFrontSide,
  type FrontId,
  type OperationalSector,
} from "./land-fronts";
import {
  getFrontAllocation,
  type NationFrontAllocation,
} from "./nation-front-allocations";
import {
  isStrategicReserveUnit,
  releaseStrategicReserveUnit,
} from "./strategic-reserves";
import { getFrontPlan, type NationFrontPlan } from "./nation-front-plans";
import type { UnitId, UnitState } from "./unit";
import { getUnitCombatStrength } from "./unit-strength";
import { buildWarAdjacency, isAtWar } from "./war-state";
import type { WorldState } from "./world-state";
import { FAST_TICK_MS } from "./time";
import { getMesoById, getNeighborsById, getOwnerByMesoId } from "./world-cache";
import {
  getFrontlineCoverage,
  type FrontlineCoverageLevel,
  type FrontlineDefensivePosition,
} from "./frontline-coverage";
import {
  isSchwerpunktSector,
  recordMajorOffensiveOutcome,
} from "./stalemate-pressure";
import { canReachControlled, getControlledDistanceField } from "./ai-geography";
import {
  getBattlefieldTopologyAssessment,
  type BattlefieldComponentId,
  type PocketClosureOpportunity,
} from "./battlefield-topology";

export type OperationId = string & { __brand: "OperationId" };

export type OffensiveOperationPhase =
  | "preparing"
  | "attacking"
  | "exploiting"
  | "recovering";

export type ExploitationStopReason =
  | "target-occupied"
  | "covered-frontline"
  | "local-strength-disadvantage"
  | "enemy-reserve-arrival"
  | "retreat-started"
  | "capital-emergency"
  | "front-disappeared"
  | "timeout"
  | "force-depleted"
  | "allocation-lost"
  | "war-ended"
  | "target-invalid";

export type OffensiveOperationOutcome =
  | "success"
  | "failure"
  | "cancelled";

export type OffensiveOperationReason =
  | "front-superiority"
  | "enemy-frontline-gap"
  | "enemy-frontline-weak"
  | "local-strength-superiority"
  | "recent-breakthrough"
  | "enemy-capital-opportunity"
  | "enemy-city-opportunity"
  | "pocket-closure"
  | "high-front-priority"
  | "weak-enemy-presence";

export type OffensiveOperationCompletionReason =
  | "primary-target-occupied"
  | "supporting-targets-occupied"
  | "attack-expired"
  | "force-depleted"
  | "strength-collapsed"
  | "target-unreachable"
  | "target-invalid"
  | "front-disappeared"
  | "war-ended"
  | "posture-changed"
  | "capital-emergency"
  | "allocation-lost";

export type OffensiveOperationEventType =
  | "created"
  | "phase-transition"
  | "exploitation-started"
  | "exploitation-stopped"
  | "front-remapped"
  | "lease-override"
  | "success"
  | "failure"
  | "cancelled"
  | "recovery-complete";

export type OperationCandidateRejectionReason =
  | "insufficient-on-time-strength"
  | "insufficient-units";

export type PreparationLeaseOverrideReason =
  | "front-invalid"
  | "capital-emergency"
  | "mandatory-retreat"
  | "operation-cancelled";

export interface OperationManifestAssignment {
  unitId: UnitId;
  approachRegionId: MesoRegionId;
  controlledDistance: number;
  estimatedTravelTicks: number;
  estimatedArrivalTick: number;
  arrivalSlack: number;
  requiredContribution: number;
  strength: number;
  isReplacement: boolean;
  arrivedAtTick: number | null;
}

export interface OperationCandidate {
  key: string;
  nationId: NationId;
  enemyNationId: NationId;
  frontId: FrontId;
  isMajorOffensive: boolean;
  isSchwerpunktOperation: boolean;
  primaryTargetRegionId: MesoRegionId;
  supportingTargetRegionIds: MesoRegionId[];
  stagingRegionId: MesoRegionId;
  plannedApproachRegionIds: MesoRegionId[];
  requiredStrengthByApproach: Map<MesoRegionId, number>;
  onTimeStrengthByApproach: Map<MesoRegionId, number>;
  manifest: OperationManifestAssignment[];
  requiredCompletion: number;
  feasible: boolean;
  rejectionReasons: OperationCandidateRejectionReason[];
  createdAtTick: number;
  evaluatedAtTick: number;
  evaluationCount: number;
  offensiveSurplusAvailable: number;
  initialFriendlyStrength: number;
  initialEnemyStrength: number;
  initialStrengthRatio: number;
  targetCoverageState: FrontlineCoverageLevel | null;
  targetLocalDefenderStrength: number;
  targetTacticalScore: number;
  targetTopologyScore: number;
  pocketClosureObjective: PocketClosureOpportunity | null;
  reasonFlags: OffensiveOperationReason[];
  fellBackToSingleApproach: boolean;
}

export interface OffensiveOperation {
  id: OperationId;
  nationId: NationId;
  enemyNationId: NationId;
  frontId: FrontId;
  phase: OffensiveOperationPhase;
  isMajorOffensive: boolean;
  isSchwerpunktOperation: boolean;
  offensiveSurplusAvailable: number;
  localStrengthRatioAtAttack: number;
  primaryTargetRegionId: MesoRegionId;
  supportingTargetRegionIds: MesoRegionId[];
  stagingRegionId: MesoRegionId;
  assignedUnitIds: UnitId[];
  assignedStrength: number;
  initialAssignedUnitIds: UnitId[];
  initialAssignedUnitCount: number;
  initialAssignedStrength: number;
  unitTargetRegionIds: Map<UnitId, MesoRegionId>;
  plannedApproachRegionIds: MesoRegionId[];
  approachRegionByUnitId: Map<UnitId, MesoRegionId>;
  plannedStrengthByApproach: Map<MesoRegionId, number>;
  approachGroups: OperationApproachGroup[];
  committedManifest: OperationManifestAssignment[];
  preparationFeasible: boolean;
  infeasibleAtTick: number | null;
  preparationLeaseStartedAtTick: number;
  preparationLeaseEndedAtTick: number | null;
  leaseOverrideReasons: PreparationLeaseOverrideReason[];
  allocationReclaimedUnitIds: UnitId[];
  readinessCompletion: number;
  replacementRecruitCount: number;
  recruitmentDistanceTotal: number;
  recruitmentCount: number;
  actualActiveApproachCount: number;
  synchronizationReady: boolean;
  synchronizationWaitTicks: number;
  fellBackToSingleApproach: boolean;
  startedAtTick: number;
  phaseStartedAtTick: number;
  minimumCommitUntilTick: number;
  expiresAtTick: number;
  initialFriendlyStrength: number;
  initialEnemyStrength: number;
  initialStrengthRatio: number;
  targetCoverageState: FrontlineCoverageLevel | null;
  targetLocalDefenderStrength: number;
  targetTacticalScore: number;
  targetTopologyScore: number;
  pocketClosureObjective: PocketClosureOpportunity | null;
  pocketClosureConfirmation: PocketClosureConfirmation | null;
  attackSuccessReason: OffensiveOperationCompletionReason | null;
  exploitationTargetRegionId: MesoRegionId | null;
  exploitationTargetCoverageState: FrontlineCoverageLevel | null;
  exploitationTargetLocalEnemyStrength: number;
  exploitationTargetScore: number;
  exploitationDepth: number;
  exploitationUnitIds: UnitId[];
  exploitationHoldUnitIds: UnitId[];
  exploitationForceStrength: number;
  exploitationStartedAtTick: number | null;
  exploitationFrontVersion: number;
  exploitationStopReason: ExploitationStopReason | null;
  capturedRegionIds: MesoRegionId[];
  reasonFlags: OffensiveOperationReason[];
  outcome: OffensiveOperationOutcome | null;
  completionReason: OffensiveOperationCompletionReason | null;
  completedAtTick: number | null;
}

export interface PocketClosureConfirmation {
  status: "success" | "failed";
  confirmedAtTick: number;
  resultingPocketId: BattlefieldComponentId | null;
  trappedStrength: number;
  trappedRegionIds: MesoRegionId[];
  trappedCities: number;
}

export interface OperationApproachGroup {
  regionId: MesoRegionId;
  requiredStrength: number;
  committedStrengthTarget: number;
  assignedUnitIds: UnitId[];
  currentAssignedStrength: number;
  readyStrength: number;
  feasibleStrength: number;
  remainingFeasibleStrength: number;
  minimumArrivalSlack: number | null;
  completion: number;
  replacementRecruitCount: number;
  recruitmentDistanceTotal: number;
  recruitmentCount: number;
}

export interface OffensiveOperationEvent {
  tick: number;
  operationId: OperationId;
  nationId: NationId;
  frontId: FrontId;
  type: OffensiveOperationEventType;
  phase: OffensiveOperationPhase;
  detail: string;
}

export interface OffensiveOperationState {
  exploitationEnabled: boolean;
  operations: OffensiveOperation[];
  operationsById: Map<OperationId, OffensiveOperation>;
  operationsByNationId: Map<NationId, OffensiveOperation[]>;
  operationsByFrontNation: Map<string, OffensiveOperation>;
  operationIdByUnitId: Map<UnitId, OperationId>;
  candidatesByFrontNation: Map<string, OperationCandidate>;
  history: OffensiveOperation[];
  timeline: OffensiveOperationEvent[];
  version: number;
  membershipVersion: number;
  nextOperationNumber: number;
  createdCount: number;
  completedCount: number;
  failedCount: number;
  cancelledCount: number;
  phaseTransitionCount: number;
  unitAssignmentCount: number;
  targetChangeCount: number;
  unitTargetSwitchCount: number;
  preparingDurationTicks: number;
  attackingDurationTicks: number;
  maxTargetConcentration: number;
  exploitationStartedCount: number;
  exploitationSuccessCount: number;
  exploitationStoppedCount: number;
  exploitationDepthTotal: number;
  exploitationDurationTicks: number;
  exploitationForceUnitTotal: number;
  exploitationForceStrengthTotal: number;
  exploitationStopCounts: Record<ExploitationStopReason, number>;
  successfulCapturedRegionCount: number;
  coordinatedCreatedCount: number;
  plannedApproachCountTotal: number;
  achievedApproachCountTotal: number;
  synchronizationWaitTicks: number;
  singleApproachFallbackCount: number;
  preparationSucceededCount: number;
  preparationTimeoutCount: number;
  approachCompletionSampleTotal: number;
  approachCompletionSampleCount: number;
  recruitmentDistanceTotal: number;
  recruitmentCount: number;
  replacementRecruitCount: number;
  candidatesCreatedCount: number;
  candidatesAcceptedCount: number;
  candidatesRejectedCount: number;
  candidateRejectionCounts: Record<OperationCandidateRejectionReason, number>;
  impossibleAtCreationCount: number;
  impossibleDuringPreparationCount: number;
  leaseOverrideCount: number;
  leaseOverrideCounts: Record<PreparationLeaseOverrideReason, number>;
  replacementArrivalCount: number;
  replacementImpossibleCount: number;
  arrivalSlackTotal: number;
  arrivalSlackCount: number;
  minimumArrivalSlack: number | null;
  preparationLeaseLifetimeTotal: number;
  preparationLeaseLifetimeCount: number;
  preparationTimeoutMissingStrength: number;
  preparationTimeoutTravellingStrength: number;
  allocationReclaimCount: number;
  exploitationCandidateEvaluatedCounts: Record<FrontlineCoverageLevel, number>;
  exploitationSelectedCounts: Record<FrontlineCoverageLevel, number>;
  exploitationRejectionCounts: {
    insufficientLocalStrength: number;
    unreachable: number;
    reserveThreat: number;
  };
  pocketClosureCreatedCount: number;
  pocketClosureSuccessCount: number;
  pocketClosureFailureCount: number;
}

export interface OperationTargetSelection {
  primaryTargetRegionId: MesoRegionId;
  supportingTargetRegionIds: MesoRegionId[];
  stagingRegionId: MesoRegionId;
  nearbyEnemyStrength: number;
  targetCoverageState: FrontlineCoverageLevel | null;
  targetLocalDefenderStrength: number;
  tacticalScore: number;
  topologyScore?: number;
  pocketClosure?: PocketClosureOpportunity | null;
  tacticalReasons: OffensiveOperationReason[];
}

export interface OperationApproachPlan {
  regionIds: MesoRegionId[];
  regionByUnitId: Map<UnitId, MesoRegionId>;
  strengthByRegion: Map<MesoRegionId, number>;
  fellBackToSingle: boolean;
}

interface TargetTacticalAssessment {
  coverageState: FrontlineCoverageLevel | null;
  localDefenderStrength: number;
  score: number;
  reasons: OffensiveOperationReason[];
}

interface ExploitationTargetSelection {
  regionId: MesoRegionId;
  sectorId: FrontId;
  depth: number;
  score: number;
  coverageState: FrontlineCoverageLevel;
  localEnemyStrength: number;
}

interface OperationAdvanceResult {
  keep: boolean;
  changed: boolean;
}

export function createOffensiveOperationState(): OffensiveOperationState {
  return {
    exploitationEnabled: true,
    operations: [],
    operationsById: new Map(),
    operationsByNationId: new Map(),
    operationsByFrontNation: new Map(),
    operationIdByUnitId: new Map(),
    candidatesByFrontNation: new Map(),
    history: [],
    timeline: [],
    version: 0,
    membershipVersion: 0,
    nextOperationNumber: 0,
    createdCount: 0,
    completedCount: 0,
    failedCount: 0,
    cancelledCount: 0,
    phaseTransitionCount: 0,
    unitAssignmentCount: 0,
    targetChangeCount: 0,
    unitTargetSwitchCount: 0,
    preparingDurationTicks: 0,
    attackingDurationTicks: 0,
    maxTargetConcentration: 0,
    exploitationStartedCount: 0,
    exploitationSuccessCount: 0,
    exploitationStoppedCount: 0,
    exploitationDepthTotal: 0,
    exploitationDurationTicks: 0,
    exploitationForceUnitTotal: 0,
    exploitationForceStrengthTotal: 0,
    exploitationStopCounts: createExploitationStopCounts(),
    successfulCapturedRegionCount: 0,
    coordinatedCreatedCount: 0,
    plannedApproachCountTotal: 0,
    achievedApproachCountTotal: 0,
    synchronizationWaitTicks: 0,
    singleApproachFallbackCount: 0,
    preparationSucceededCount: 0,
    preparationTimeoutCount: 0,
    approachCompletionSampleTotal: 0,
    approachCompletionSampleCount: 0,
    recruitmentDistanceTotal: 0,
    recruitmentCount: 0,
    replacementRecruitCount: 0,
    candidatesCreatedCount: 0,
    candidatesAcceptedCount: 0,
    candidatesRejectedCount: 0,
    candidateRejectionCounts: {
      "insufficient-on-time-strength": 0,
      "insufficient-units": 0,
    },
    impossibleAtCreationCount: 0,
    impossibleDuringPreparationCount: 0,
    leaseOverrideCount: 0,
    leaseOverrideCounts: {
      "front-invalid": 0,
      "capital-emergency": 0,
      "mandatory-retreat": 0,
      "operation-cancelled": 0,
    },
    replacementArrivalCount: 0,
    replacementImpossibleCount: 0,
    arrivalSlackTotal: 0,
    arrivalSlackCount: 0,
    minimumArrivalSlack: null,
    preparationLeaseLifetimeTotal: 0,
    preparationLeaseLifetimeCount: 0,
    preparationTimeoutMissingStrength: 0,
    preparationTimeoutTravellingStrength: 0,
    allocationReclaimCount: 0,
    exploitationCandidateEvaluatedCounts: { gap: 0, weak: 0, covered: 0 },
    exploitationSelectedCounts: { gap: 0, weak: 0, covered: 0 },
    exploitationRejectionCounts: {
      insufficientLocalStrength: 0,
      unreachable: 0,
      reserveThreat: 0,
    },
    pocketClosureCreatedCount: 0,
    pocketClosureSuccessCount: 0,
    pocketClosureFailureCount: 0,
  };
}

export function updateOffensiveOperations(world: WorldState): void {
  const state = world.offensiveOperations;
  const startedAt = world.instrumentation ? performance.now() : 0;
  const previousMembership = state.operationIdByUnitId;
  let changed = false;
  const retained: OffensiveOperation[] = [];

  for (const operation of state.operations) {
    const result = advanceOperation(world, operation);
    changed = changed || result.changed;
    if (result.keep) {
      retained.push(operation);
    } else {
      archiveOperation(world, operation);
    }
  }
  state.operations = retained;
  rebuildOperationIndexes(state);

  const settings = WORLD_BALANCE.war.landFront.offensiveOperation;
  const plansByNation = [...world.frontPlans.plansByNationId.entries()].sort(
    ([nationA], [nationB]) => compareIds(nationA, nationB),
  );
  const eligibleCandidateKeys = new Set<string>();
  for (const [nationId, plans] of plansByNation) {
    for (const plan of plans) {
      if (isOperationPlanEligible(world, nationId, plan)) {
        eligibleCandidateKeys.add(createFrontNationKey(plan.frontId, nationId));
      }
    }
  }
  for (const [nationId, plans] of plansByNation) {
    if (
      getCapitalDefenseAssessment(world, nationId)?.threatLevel === "critical"
    ) {
      continue;
    }
    const current = state.operationsByNationId.get(nationId) ?? [];
    if (current.length >= settings.maxActivePerNation) {
      continue;
    }
    const candidates = plans
      .filter((plan) => isOperationPlanEligible(world, nationId, plan))
      .sort((a, b) =>
        bestPocketClosureScore(world, nationId, b.frontId) -
          bestPocketClosureScore(world, nationId, a.frontId) ||
        Number(isSchwerpunktSector(world, nationId, b.frontId)) -
          Number(isSchwerpunktSector(world, nationId, a.frontId)) ||
        compareOperationCandidatePlans(a, b)
      );
    for (const plan of candidates) {
      if (
        (state.operationsByNationId.get(nationId)?.length ?? 0) >=
        settings.maxActivePerNation
      ) {
        break;
      }
      if (state.operationsByFrontNation.has(createFrontNationKey(plan.frontId, nationId))) {
        continue;
      }
      if (
        world.retreatPlans.plansByFrontNation.has(
          createFrontNationKey(plan.frontId, nationId),
        )
      ) {
        continue;
      }
      const candidateKey = createFrontNationKey(plan.frontId, nationId);
      const previousCandidate = state.candidatesByFrontNation.get(candidateKey);
      const candidate = buildOperationCandidate(world, plan, previousCandidate);
      if (!candidate) {
        state.candidatesByFrontNation.delete(candidateKey);
        continue;
      }
      state.candidatesByFrontNation.set(candidateKey, candidate);
      if (!previousCandidate) {
        state.candidatesCreatedCount += 1;
        world.instrumentation?.incrementCounter("offensiveOperation.candidatesCreated");
      }
      if (!candidate.feasible) {
        if (!previousCandidate) {
          state.candidatesRejectedCount += 1;
          world.instrumentation?.incrementCounter("offensiveOperation.candidatesRejected");
          for (const reason of candidate.rejectionReasons) {
            state.candidateRejectionCounts[reason] += 1;
            world.instrumentation?.incrementCounter(
              `offensiveOperation.candidateRejected.${reason}`,
            );
          }
          state.impossibleAtCreationCount += 1;
          world.instrumentation?.incrementCounter(
            "offensiveOperation.impossibleAtCreation",
          );
        }
        continue;
      }
      const operation = createOperationFromCandidate(world, candidate);
      state.candidatesByFrontNation.delete(candidateKey);
      state.candidatesAcceptedCount += 1;
      world.instrumentation?.incrementCounter("offensiveOperation.candidatesAccepted");
      state.operations.push(operation);
      state.createdCount += 1;
      if (operation.isMajorOffensive) {
        world.stalematePressure.majorOffensivesLaunched += 1;
      }
      state.unitAssignmentCount += operation.assignedUnitIds.length;
      world.instrumentation?.incrementCounter("offensiveOperation.created");
      world.instrumentation?.incrementCounter(
        "offensiveOperation.unitAssignments",
        operation.assignedUnitIds.length,
      );
      recordEvent(world, operation, "created", "attack-front-selected");
      if (operation.pocketClosureObjective) {
        state.pocketClosureCreatedCount += 1;
      }
      changed = true;
      rebuildOperationIndexes(state);
    }
  }

  for (const key of [...state.candidatesByFrontNation.keys()]) {
    if (!eligibleCandidateKeys.has(key)) {
      state.candidatesByFrontNation.delete(key);
    }
  }

  rebuildOperationIndexes(state);
  const membershipChanged = !areAssignmentMapsEqual(
    previousMembership,
    state.operationIdByUnitId,
  );
  if (membershipChanged) {
    state.membershipVersion += 1;
  }
  if (changed || membershipChanged) {
    state.version += 1;
  }

  sampleOperationMetrics(world);
  if (world.instrumentation) {
    world.instrumentation.recordDuration(
      "offensiveOperation.evaluation",
      performance.now() - startedAt,
    );
  }
}

export function getOffensiveOperations(
  world: WorldState,
  nationId?: NationId,
): readonly OffensiveOperation[] {
  return nationId === undefined
    ? world.offensiveOperations.operations
    : (world.offensiveOperations.operationsByNationId.get(nationId) ?? []);
}

export function getOffensiveOperationForFront(
  world: WorldState,
  frontId: FrontId,
  nationId: NationId,
): OffensiveOperation | undefined {
  return world.offensiveOperations.operationsByFrontNation.get(
    createFrontNationKey(frontId, nationId),
  );
}

export function getOperationCandidateForFront(
  world: WorldState,
  frontId: FrontId,
  nationId: NationId,
): OperationCandidate | undefined {
  return world.offensiveOperations.candidatesByFrontNation.get(
    createFrontNationKey(frontId, nationId),
  );
}

export function getOffensiveOperationForUnit(
  world: WorldState,
  unitId: UnitId,
): OffensiveOperation | undefined {
  const operationId = world.offensiveOperations.operationIdByUnitId.get(unitId);
  return operationId
    ? world.offensiveOperations.operationsById.get(operationId)
    : undefined;
}

/** Immediately releases operation membership before a RetreatPlan claims the force. */
export function cancelOffensiveOperationForRetreat(
  world: WorldState,
  frontId: FrontId,
  nationId: NationId,
): boolean {
  const state = world.offensiveOperations;
  const operation = state.operationsByFrontNation.get(
    createFrontNationKey(frontId, nationId),
  );
  if (!operation || operation.phase === "recovering") {
    return false;
  }
  const previousMembership = state.operationIdByUnitId;
  if (operation.phase === "preparing") {
    recordPreparationLeaseOverride(world, operation, "mandatory-retreat");
  }
  if (operation.phase === "exploiting") {
    stopExploitation(world, operation, "retreat-started");
  } else {
    finishOperation(world, operation, "cancelled", "posture-changed");
  }
  rebuildOperationIndexes(state);
  if (!areAssignmentMapsEqual(previousMembership, state.operationIdByUnitId)) {
    state.membershipVersion += 1;
  }
  state.version += 1;
  return true;
}

/** Releases distant offensive commitments during a critical capital emergency. */
export function cancelOffensiveOperationsForCapitalEmergency(
  world: WorldState,
): number {
  const state = world.offensiveOperations;
  const previousMembership = state.operationIdByUnitId;
  const operations = state.operations.filter(
    (operation) =>
      operation.phase !== "recovering" &&
      getCapitalDefenseAssessment(world, operation.nationId)?.threatLevel ===
        "critical",
  );
  for (const operation of operations) {
    if (operation.phase === "preparing") {
      recordPreparationLeaseOverride(world, operation, "capital-emergency");
    }
    if (operation.phase === "exploiting") {
      stopExploitation(world, operation, "capital-emergency");
    } else {
      finishOperation(world, operation, "cancelled", "capital-emergency");
    }
  }
  if (operations.length === 0) return 0;
  rebuildOperationIndexes(state);
  if (!areAssignmentMapsEqual(previousMembership, state.operationIdByUnitId)) {
    state.membershipVersion += 1;
  }
  state.version += 1;
  const cancelledCount = operations.filter(
    (operation) => operation.exploitationStopReason !== "capital-emergency",
  ).length;
  recordCapitalOperationCancellations(world, cancelledCount);
  return operations.length;
}

export function formatOffensiveOperationSummary(world: WorldState): string {
  const lines: string[] = [];
  for (const operation of world.offensiveOperations.operations) {
    lines.push(
      `${operation.id} ${operation.nationId} vs ${operation.enemyNationId}`,
      `  Front: ${operation.frontId}`,
      `  phase: ${operation.phase}`,
      `  primary: ${operation.primaryTargetRegionId}`,
      `  supporting: ${operation.supportingTargetRegionIds.join(", ") || "none"}`,
      `  staging: ${operation.stagingRegionId}`,
      `  approaches: ${operation.actualActiveApproachCount}/${operation.plannedApproachRegionIds.length} ${operation.plannedApproachRegionIds.join(", ")}`,
      `  readiness: ${(operation.readinessCompletion * 100).toFixed(1)}% (${operation.synchronizationWaitTicks} ticks)`,
      ...operation.approachGroups.map((group, index) =>
        `    A${index + 1}: assigned ${group.currentAssignedStrength.toFixed(1)} / required ${group.requiredStrength.toFixed(1)}, ready ${group.readyStrength.toFixed(1)}, feasible ${group.feasibleStrength.toFixed(1)}, remaining ${group.remainingFeasibleStrength.toFixed(1)}, slack ${group.minimumArrivalSlack ?? "-"}, completion ${(group.completion * 100).toFixed(1)}%`
      ),
      `  manifest: ${operation.committedManifest.length}`,
      `  preparation lease: ${operation.preparationLeaseEndedAtTick === null ? "active" : `ended@${operation.preparationLeaseEndedAtTick}`}`,
      `  lease overrides: ${operation.leaseOverrideReasons.join(", ") || "none"}`,
      `  units: ${operation.assignedUnitIds.length}`,
      `  strength: ${operation.assignedStrength.toFixed(1)}`,
      `  target coverage: ${operation.targetCoverageState ?? "none"}`,
      `  local defense: ${operation.targetLocalDefenderStrength.toFixed(1)}`,
      `  tactical score: ${operation.targetTacticalScore.toFixed(1)}`,
      `  topology score: ${operation.targetTopologyScore.toFixed(1)}`,
      `  pocket closure: ${operation.pocketClosureObjective ? `${operation.pocketClosureObjective.candidateRegionId} exits ${operation.pocketClosureObjective.currentExits}->${operation.pocketClosureObjective.expectedExitsAfterCapture} score ${operation.pocketClosureObjective.score.toFixed(1)}` : "none"}`,
      `  closure result: ${operation.pocketClosureConfirmation?.status ?? "pending"}`,
      `  exploitation target: ${operation.exploitationTargetRegionId ?? "none"}`,
      `  exploitation coverage: ${operation.exploitationTargetCoverageState ?? "none"}`,
      `  exploitation local defense: ${operation.exploitationTargetLocalEnemyStrength.toFixed(1)}`,
      `  exploitation score: ${operation.exploitationTargetScore.toFixed(1)}`,
      `  exploitation depth: ${operation.exploitationDepth}`,
      `  exploitation force: ${operation.exploitationUnitIds.length} / ${operation.assignedUnitIds.length}`,
      `  exploitation stop: ${operation.exploitationStopReason ?? "none"}`,
      `  started: ${operation.startedAtTick}`,
      `  outcome: ${operation.outcome ?? "active"}`,
      `  completion: ${operation.completionReason ?? "none"}`,
      `  reasons: ${operation.reasonFlags.join(", ")}`,
    );
  }
  return lines.join("\n");
}

function advanceOperation(
  world: WorldState,
  operation: OffensiveOperation,
): OperationAdvanceResult {
  const now = world.time.fastTick;
  let operationChanged = false;
  if (operation.phase === "recovering") {
    if (now < operation.expiresAtTick) {
      return { keep: true, changed: false };
    }
    recordEvent(world, operation, "recovery-complete", "cooldown-complete");
    return { keep: false, changed: true };
  }

  if (operation.phase === "exploiting") {
    return advanceExploitation(world, operation);
  }

  if (
    operation.phase === "attacking" &&
    isRegionControlledBy(world, operation.primaryTargetRegionId, operation.nationId)
  ) {
    recordOperationCaptures(world, operation);
    confirmPocketClosure(world, operation);
    if (!tryStartExploitation(world, operation, "primary-target-occupied")) {
      finishOperation(
        world,
        operation,
        "success",
        "primary-target-occupied",
      );
    }
    return { keep: true, changed: true };
  }
  if (
    operation.phase === "attacking" &&
    hasOccupiedSupportingMajority(world, operation)
  ) {
    recordOperationCaptures(world, operation);
    if (!tryStartExploitation(world, operation, "supporting-targets-occupied")) {
      finishOperation(
        world,
        operation,
        "success",
        "supporting-targets-occupied",
      );
    }
    return { keep: true, changed: true };
  }

  const warAdjacency = buildWarAdjacency(world.wars);
  if (!isAtWar(operation.nationId, operation.enemyNationId, warAdjacency)) {
    finishOperation(world, operation, "cancelled", "war-ended");
    return { keep: true, changed: true };
  }
  let front = world.landFronts.operationalSectorsById.get(operation.frontId);
  if (front && !world.landFronts.physicalFrontsById.has(front.physicalFrontId)) {
    front = undefined;
  }
  if (!front) {
    const replacement = findContinuationFront(world, operation);
    if (!replacement) {
      finishOperation(world, operation, "cancelled", "front-disappeared");
      return { keep: true, changed: true };
    }
    const previousFrontId = operation.frontId;
    operation.frontId = replacement.id;
    front = replacement;
    operationChanged = true;
    recordEvent(
      world,
      operation,
      "front-remapped",
      `${previousFrontId}->${replacement.id}`,
    );
  }
  const plan = getFrontPlan(world, operation.frontId, operation.nationId);
  if (!plan || (plan.posture !== "attack" && !operation.isMajorOffensive && !operation.pocketClosureObjective)) {
    finishOperation(world, operation, "cancelled", "posture-changed");
    return { keep: true, changed: true };
  }
  const allocation = getFrontAllocation(
    world,
    operation.frontId,
    operation.nationId,
  );
  if (!allocation) {
    finishOperation(world, operation, "cancelled", "allocation-lost");
    return { keep: true, changed: true };
  }
  const enemySide = getOpposingFrontSide(front, operation.nationId);
  if (!enemySide) {
    finishOperation(world, operation, "cancelled", "front-disappeared");
    return { keep: true, changed: true };
  }
  if (!enemySide.influenceRegionIds.includes(operation.primaryTargetRegionId)) {
    finishOperation(world, operation, "cancelled", "target-invalid");
    return { keep: true, changed: true };
  }
  if (operation.pocketClosureObjective && !isPocketClosureStillValid(world, operation)) {
    finishOperation(world, operation, "cancelled", "target-invalid");
    return { keep: true, changed: true };
  }

  const unitById = new Map(world.units.map((unit) => [unit.id, unit]));
  const survivingInitialCount = operation.initialAssignedUnitIds.filter((unitId) => {
    const unit = unitById.get(unitId);
    return (
      !!unit &&
      unit.domain === "land" &&
      unit.nationId === operation.nationId
    );
  }).length;
  const settings = WORLD_BALANCE.war.landFront.offensiveOperation;
  if (
    operation.phase !== "preparing" &&
    survivingInitialCount <
    Math.ceil(
      operation.initialAssignedUnitCount * settings.minimumSurvivingForceRatio,
    )
  ) {
    finishOperation(world, operation, "cancelled", "force-depleted");
    return { keep: true, changed: true };
  }

  const previouslyAssignedIds = new Set(operation.assignedUnitIds);
  const assignmentChanged = operation.phase === "preparing"
    ? recruitApproachGroups(world, operation, allocation, previouslyAssignedIds)
    : pruneExploitationForce(world, operation);

  if (operation.phase === "preparing") {
    if (!operation.preparationFeasible) {
      if (operation.infeasibleAtTick === null) {
        operation.infeasibleAtTick = now;
        world.offensiveOperations.impossibleDuringPreparationCount += 1;
        world.offensiveOperations.replacementImpossibleCount += 1;
        world.instrumentation?.incrementCounter(
          "offensiveOperation.impossibleDuringPreparation",
        );
        world.instrumentation?.incrementCounter(
          "offensiveOperation.replacementImpossible",
        );
      }
      finishOperation(world, operation, "failure", "strength-collapsed");
      return { keep: true, changed: true };
    }
    const preparationTicks = now - operation.phaseStartedAtTick;
    const approachReadiness = getApproachReadiness(world, operation);
    operationChanged = operationChanged ||
      operation.actualActiveApproachCount !== approachReadiness.readyCount ||
      operation.synchronizationReady !== approachReadiness.ready;
    operation.actualActiveApproachCount = approachReadiness.readyCount;
    operation.synchronizationReady = approachReadiness.ready;
    operation.readinessCompletion = approachReadiness.operationCompletion;
    operation.synchronizationWaitTicks = preparationTicks;
    const majorSettings = WORLD_BALANCE.war.landFront.stalemate;
    const minimumPreparation = operation.isMajorOffensive
      ? majorSettings.majorMinimumPreparationTicks : settings.minimumPreparationTicks;
    const requiredCompletion = operation.isMajorOffensive
      ? majorSettings.majorStagedFraction : settings.stagedFraction;
    if (
      preparationTicks >= minimumPreparation &&
      approachReadiness.operationCompletion >= requiredCompletion
    ) {
      const { attackerStrength, defenderStrength } = getLaunchLocalStrength(world, operation);
      const localRatio = defenderStrength <= 0 ? 10 : attackerStrength / defenderStrength;
      operation.localStrengthRatioAtAttack = localRatio;
      if (operation.isMajorOffensive && localRatio < majorSettings.majorLocalOvermatchRatio) {
        finishOperation(world, operation, "failure", "strength-collapsed");
        return { keep: true, changed: true };
      }
      transitionToAttacking(world, operation);
      return { keep: true, changed: true };
    }
    if (preparationTicks >= settings.preparationTimeoutTicks) {
      world.offensiveOperations.preparationTimeoutCount += 1;
      recordPreparationTimeout(world, operation);
      finishOperation(world, operation, "failure", "strength-collapsed");
      return { keep: true, changed: true };
    }
    return { keep: true, changed: operationChanged || assignmentChanged };
  }

  if (operation.assignedUnitIds.length === 0) {
    finishOperation(world, operation, "cancelled", "allocation-lost");
    return { keep: true, changed: true };
  }

  if (now >= operation.minimumCommitUntilTick) {
    const friendly = getFrontSide(front, operation.nationId);
    const enemy = getOpposingFrontSide(front, operation.nationId);
    const currentRatio = getStrengthRatio(
      friendly?.strength ?? 0,
      enemy?.strength ?? 0,
    );
    if (
      currentRatio < 1 &&
      currentRatio <
        operation.initialStrengthRatio * settings.failureStrengthRatioMultiplier
    ) {
      finishOperation(world, operation, "failure", "strength-collapsed");
      return { keep: true, changed: true };
    }
  }
  if (now >= operation.expiresAtTick) {
    finishOperation(world, operation, "failure", "attack-expired");
    return { keep: true, changed: true };
  }
  if (!isTargetReachableWithinFront(world, operation, front)) {
    finishOperation(world, operation, "failure", "target-unreachable");
    return { keep: true, changed: true };
  }
  return { keep: true, changed: operationChanged || assignmentChanged };
}

function findContinuationFront(
  world: WorldState,
  operation: OffensiveOperation,
): OperationalSector | undefined {
  return world.landFronts.operationalSectors
    .filter((front) => {
      if (!world.landFronts.physicalFrontsById.has(front.physicalFrontId)) {
        return false;
      }
      const samePair =
        (front.nationAId === operation.nationId &&
          front.nationBId === operation.enemyNationId) ||
        (front.nationBId === operation.nationId &&
          front.nationAId === operation.enemyNationId);
      if (!samePair) {
        return false;
      }
      const enemy = getOpposingFrontSide(front, operation.nationId);
      return !!enemy?.influenceRegionIds.includes(
        operation.primaryTargetRegionId,
      );
    })
    .sort((a, b) => {
      const friendlyA = getFrontSide(a, operation.nationId);
      const friendlyB = getFrontSide(b, operation.nationId);
      const stagingA = friendlyA?.influenceRegionIds.includes(
        operation.stagingRegionId,
      )
        ? 1
        : 0;
      const stagingB = friendlyB?.influenceRegionIds.includes(
        operation.stagingRegionId,
      )
        ? 1
        : 0;
      return stagingB - stagingA || compareIds(a.id, b.id);
    })[0];
}

function buildOperationCandidate(
  world: WorldState,
  plan: NationFrontPlan,
  previous: OperationCandidate | undefined,
): OperationCandidate | null {
  const settings = WORLD_BALANCE.war.landFront.offensiveOperation;
  const isSchwerpunktOperation = isSchwerpunktSector(world, plan.nationId, plan.frontId);
  const focusPressure = world.stalematePressure.assessments.find((assessment) =>
    assessment.nationId === plan.nationId && assessment.schwerpunktSectorId === plan.frontId
  )?.pressure ?? 0;
  const isMajorOffensive = isSchwerpunktOperation &&
    focusPressure >= WORLD_BALANCE.war.landFront.stalemate.majorOffensiveThreshold;
  const front = world.landFronts.operationalSectorsById.get(plan.frontId);
  const allocation = getFrontAllocation(world, plan.frontId, plan.nationId);
  if (
    !front ||
    !allocation ||
    allocation.unitIds.length < settings.minimumFrontUnits
  ) {
    return null;
  }
  const friendly = getFrontSide(front, plan.nationId);
  const enemy = getOpposingFrontSide(front, plan.nationId);
  if (!friendly || !enemy) {
    return null;
  }
  const unitById = new Map(world.units.map((unit) => [unit.id, unit]));
  const allocationUnits = allocation.unitIds
    .map((unitId) => unitById.get(unitId))
    .filter(isOperationalLandUnit);
  const defensiveIds = new Set(
    getFrontlineCoverage(world, plan.frontId, plan.nationId)?.positions.flatMap(
      (position) => position.defenderUnitIds,
    ) ?? [],
  );
  const surplusUnits = allocationUnits.filter((unit) =>
    !defensiveIds.has(unit.id) &&
    !world.collapseAdvances.advanceNationByUnitId.has(unit.id) &&
    !world.offensiveOperations.operationIdByUnitId.has(unit.id)
  );
  if (allocationUnits.length < settings.minimumFrontUnits || surplusUnits.length < 2) {
    return null;
  }
  const targets = selectOperationTargets(world, front, plan, surplusUnits);
  if (!targets) {
    return null;
  }
  const forceFraction = isSchwerpunktOperation
    ? WORLD_BALANCE.war.landFront.stalemate.majorOperationForceFraction
    : settings.forceFraction;
  const requiredOperationStrength = sumUnitStrength(surplusUnits) * forceFraction;
  const approachPlan = planOperationApproaches(
    world,
    plan.nationId,
    targets,
    surplusUnits,
    isSchwerpunktOperation,
    requiredOperationStrength,
  );
  const initialStrengthRatio = getStrengthRatio(friendly.strength, enemy.strength);
  const requiredCompletion = isMajorOffensive
    ? WORLD_BALANCE.war.landFront.stalemate.majorStagedFraction
    : settings.stagedFraction;
  const deadlineTick = world.time.fastTick + settings.preparationTimeoutTicks;
  const deployedReserve = world.strategicReserves.reservesByNationId.get(plan.nationId);
  const reserveUnits = deployedReserve?.deployment?.targetFrontId === front.id &&
    deployedReserve.deployment.status !== "returning"
    ? deployedReserve.deployment.unitIds
      .map((unitId) => unitById.get(unitId))
      .filter(isOperationalLandUnit)
      .filter((unit) =>
        !world.retreatPlans.retreatIdByUnitId.has(unit.id) &&
        !world.reorganization.planIdByUnitId.has(unit.id) &&
        !world.offensiveOperations.operationIdByUnitId.has(unit.id)
      )
    : [];
  const preflightUnits = [...new Map(
    [...surplusUnits, ...reserveUnits].map((unit) => [unit.id, unit]),
  ).values()];
  const manifestResult = buildPreflightManifest(
    world,
    plan.nationId,
    front.id,
    approachPlan.regionIds,
    approachPlan.strengthByRegion,
    preflightUnits,
    requiredCompletion,
    deadlineTick,
    new Set(),
    false,
  );
  const rejectionReasons: OperationCandidateRejectionReason[] = [];
  if (manifestResult.manifest.length < 2) {
    rejectionReasons.push("insufficient-units");
  }
  if (!manifestResult.feasible) {
    rejectionReasons.push("insufficient-on-time-strength");
  }
  const createdAtTick = previous?.createdAtTick ?? world.time.fastTick;
  return {
    key: createFrontNationKey(front.id, plan.nationId),
    nationId: plan.nationId,
    enemyNationId: enemy.nationId,
    frontId: front.id,
    isMajorOffensive,
    isSchwerpunktOperation,
    primaryTargetRegionId: targets.primaryTargetRegionId,
    supportingTargetRegionIds: [...targets.supportingTargetRegionIds],
    stagingRegionId: targets.stagingRegionId,
    plannedApproachRegionIds: [...approachPlan.regionIds],
    requiredStrengthByApproach: new Map(approachPlan.strengthByRegion),
    onTimeStrengthByApproach: manifestResult.onTimeStrengthByApproach,
    manifest: manifestResult.manifest,
    requiredCompletion,
    feasible: rejectionReasons.length === 0,
    rejectionReasons,
    createdAtTick,
    evaluatedAtTick: world.time.fastTick,
    evaluationCount: (previous?.evaluationCount ?? 0) + 1,
    offensiveSurplusAvailable: sumUnitStrength(surplusUnits),
    initialFriendlyStrength: finiteNumber(friendly.strength),
    initialEnemyStrength: finiteNumber(enemy.strength),
    initialStrengthRatio,
    targetCoverageState: targets.targetCoverageState,
    targetLocalDefenderStrength: targets.targetLocalDefenderStrength,
    targetTacticalScore: targets.tacticalScore,
    targetTopologyScore: targets.topologyScore ?? 0,
    pocketClosureObjective: targets.pocketClosure
      ? clonePocketClosureOpportunity(targets.pocketClosure) : null,
    reasonFlags: collectOperationReasons(
      world,
      plan,
      front,
      targets,
      initialStrengthRatio,
    ),
    fellBackToSingleApproach: approachPlan.fellBackToSingle,
  };
}

function createOperationFromCandidate(
  world: WorldState,
  candidate: OperationCandidate,
): OffensiveOperation {
  const settings = WORLD_BALANCE.war.landFront.offensiveOperation;
  for (const assignment of candidate.manifest) {
    if (isStrategicReserveUnit(world, assignment.unitId)) {
      releaseStrategicReserveUnit(world, assignment.unitId);
    }
  }
  const assignedUnitIds = candidate.manifest
    .map((assignment) => assignment.unitId)
    .sort(compareIds);
  const assignedStrength = candidate.manifest.reduce(
    (sum, assignment) => sum + assignment.strength,
    0,
  );
  const approachRegionByUnitId = new Map(
    candidate.manifest.map((assignment) => [
      assignment.unitId,
      assignment.approachRegionId,
    ]),
  );
  const operation: OffensiveOperation = {
    id: createOperationId(world.offensiveOperations.nextOperationNumber),
    nationId: candidate.nationId,
    enemyNationId: candidate.enemyNationId,
    frontId: candidate.frontId,
    phase: "preparing",
    isMajorOffensive: candidate.isMajorOffensive,
    isSchwerpunktOperation: candidate.isSchwerpunktOperation,
    offensiveSurplusAvailable: candidate.offensiveSurplusAvailable,
    localStrengthRatioAtAttack: 0,
    primaryTargetRegionId: candidate.primaryTargetRegionId,
    supportingTargetRegionIds: [...candidate.supportingTargetRegionIds],
    stagingRegionId: candidate.stagingRegionId,
    assignedUnitIds,
    assignedStrength,
    initialAssignedUnitIds: [...assignedUnitIds],
    initialAssignedUnitCount: assignedUnitIds.length,
    initialAssignedStrength: assignedStrength,
    unitTargetRegionIds: new Map(),
    plannedApproachRegionIds: [...candidate.plannedApproachRegionIds],
    approachRegionByUnitId,
    plannedStrengthByApproach: new Map(candidate.requiredStrengthByApproach),
    approachGroups: candidate.plannedApproachRegionIds.map((regionId) => ({
      regionId,
      requiredStrength: candidate.requiredStrengthByApproach.get(regionId) ?? 0,
      assignedUnitIds: candidate.manifest
        .filter((assignment) => assignment.approachRegionId === regionId)
        .map((assignment) => assignment.unitId)
        .sort(compareIds),
      currentAssignedStrength:
        candidate.onTimeStrengthByApproach.get(regionId) ?? 0,
      committedStrengthTarget:
        candidate.onTimeStrengthByApproach.get(regionId) ?? 0,
      readyStrength: 0,
      feasibleStrength: candidate.onTimeStrengthByApproach.get(regionId) ?? 0,
      remainingFeasibleStrength: candidate.onTimeStrengthByApproach.get(regionId) ?? 0,
      minimumArrivalSlack: minimumSlack(
        candidate.manifest.filter(
          (assignment) => assignment.approachRegionId === regionId,
        ),
      ),
      completion: 0,
      replacementRecruitCount: 0,
      recruitmentDistanceTotal: candidate.manifest
        .filter((assignment) => assignment.approachRegionId === regionId)
        .reduce((sum, assignment) => sum + assignment.controlledDistance, 0),
      recruitmentCount: candidate.manifest.filter(
        (assignment) => assignment.approachRegionId === regionId,
      ).length,
    })),
    committedManifest: candidate.manifest.map((assignment) => ({ ...assignment })),
    preparationFeasible: true,
    infeasibleAtTick: null,
    preparationLeaseStartedAtTick: world.time.fastTick,
    preparationLeaseEndedAtTick: null,
    leaseOverrideReasons: [],
    allocationReclaimedUnitIds: [],
    readinessCompletion: 0,
    replacementRecruitCount: 0,
    recruitmentDistanceTotal: candidate.manifest.reduce(
      (sum, assignment) => sum + assignment.controlledDistance,
      0,
    ),
    recruitmentCount: candidate.manifest.length,
    actualActiveApproachCount: 0,
    synchronizationReady: false,
    synchronizationWaitTicks: 0,
    fellBackToSingleApproach: candidate.fellBackToSingleApproach,
    startedAtTick: world.time.fastTick,
    phaseStartedAtTick: world.time.fastTick,
    minimumCommitUntilTick:
      world.time.fastTick + settings.minimumCommitTicks,
    expiresAtTick:
      world.time.fastTick +
      settings.preparationTimeoutTicks +
      settings.attackTimeoutTicks,
    initialFriendlyStrength: candidate.initialFriendlyStrength,
    initialEnemyStrength: candidate.initialEnemyStrength,
    initialStrengthRatio: candidate.initialStrengthRatio,
    targetCoverageState: candidate.targetCoverageState,
    targetLocalDefenderStrength: candidate.targetLocalDefenderStrength,
    targetTacticalScore: candidate.targetTacticalScore,
    targetTopologyScore: candidate.targetTopologyScore,
    pocketClosureObjective: candidate.pocketClosureObjective
      ? clonePocketClosureOpportunity(candidate.pocketClosureObjective) : null,
    pocketClosureConfirmation: null,
    attackSuccessReason: null,
    exploitationTargetRegionId: null,
    exploitationTargetCoverageState: null,
    exploitationTargetLocalEnemyStrength: 0,
    exploitationTargetScore: 0,
    exploitationDepth: 0,
    exploitationUnitIds: [],
    exploitationHoldUnitIds: [],
    exploitationForceStrength: 0,
    exploitationStartedAtTick: null,
    exploitationFrontVersion: world.landFronts.version,
    exploitationStopReason: null,
    capturedRegionIds: [],
    reasonFlags: [...candidate.reasonFlags],
    outcome: null,
    completionReason: null,
    completedAtTick: null,
  };
  world.offensiveOperations.nextOperationNumber += 1;
  world.offensiveOperations.plannedApproachCountTotal += candidate.plannedApproachRegionIds.length;
  world.offensiveOperations.recruitmentDistanceTotal += operation.recruitmentDistanceTotal;
  world.offensiveOperations.recruitmentCount += operation.recruitmentCount;
  for (const assignment of candidate.manifest) {
    recordArrivalSlack(world, assignment.arrivalSlack);
  }
  world.instrumentation?.incrementCounter(
    "offensiveOperation.plannedApproaches",
    candidate.plannedApproachRegionIds.length,
  );
  if (candidate.plannedApproachRegionIds.length >= 2) {
    world.offensiveOperations.coordinatedCreatedCount += 1;
    world.instrumentation?.incrementCounter("offensiveOperation.coordinatedCreated");
  } else if (candidate.fellBackToSingleApproach) {
    world.offensiveOperations.singleApproachFallbackCount += 1;
    world.instrumentation?.incrementCounter("offensiveOperation.singleApproachFallbacks");
  }
  return operation;
}

function selectOperationTargets(
  world: WorldState,
  front: OperationalSector,
  plan: NationFrontPlan,
  allocationUnits: UnitState[],
): OperationTargetSelection | null {
  const friendly = getFrontSide(front, plan.nationId);
  const enemy = getOpposingFrontSide(front, plan.nationId);
  if (!friendly || !enemy) {
    return null;
  }
  const mesoById = getMesoById(world);
  const neighborsById = getNeighborsById(world);
  const frontScope = new Set([
    ...friendly.influenceRegionIds,
    ...enemy.influenceRegionIds,
  ]);
  const distanceFromFriendlyBorder = buildBoundedDistanceField(
    friendly.borderRegionIds,
    frontScope,
    neighborsById,
  );
  const enemyBorderSet = new Set(enemy.borderRegionIds);
  const enemyCoverage = getFrontlineCoverage(world, front.id, enemy.nationId);
  const enemyPositionByRegionId = new Map(
    enemyCoverage?.positions.map((position) => [position.friendlyRegionId, position]) ?? [],
  );
  const candidates = enemy.influenceRegionIds
    .filter((regionId) => {
      const meso = mesoById.get(regionId);
      return (
        !!meso &&
        meso.type !== "sea" &&
        distanceFromFriendlyBorder.has(regionId) &&
        isRegionControlledBy(world, regionId, enemy.nationId)
      );
    })
    .map((regionId) => {
      const tactical = assessTargetTactics(
        world,
        regionId,
        front,
        allocationUnits,
        enemyPositionByRegionId.get(regionId),
        enemyCoverage?.breakthroughCount ?? 0,
        frontScope,
        neighborsById,
      );
      const topologyScore = getBattlefieldTopologyTargetScore(
        world, plan.nationId, enemy.nationId, front.id, regionId,
      );
      const closure = getPocketClosureForTarget(
        world, plan.nationId, enemy.nationId, front.id, regionId,
      );
      const closureScore = closure?.tacticallyFeasible
        ? closure.score * (isSchwerpunktSector(world, plan.nationId, front.id)
          ? WORLD_BALANCE.war.landFront.pocketClosure.majorOffensiveMultiplier : 1)
        : 0;
      return {
        regionId,
        score:
          scoreOperationTarget(
            world,
            regionId,
            plan,
            allocationUnits,
            enemy.nationId,
            enemyBorderSet,
            distanceFromFriendlyBorder.get(regionId) ?? 0,
          ) + tactical.score + topologyScore + closureScore,
        nearbyEnemyStrength: getNearbyEnemyStrength(
          world,
          regionId,
          enemy.nationId,
        ),
        tactical,
        topologyScore,
        closure: closure?.tacticallyFeasible ? closure : null,
      };
    })
    .sort((a, b) => b.score - a.score || compareIds(a.regionId, b.regionId));
  const primary = candidates[0];
  if (!primary) {
    return null;
  }
  const stagingRegionId = findNearestStagingRegion(
    primary.regionId,
    friendly.borderRegionIds,
    frontScope,
    neighborsById,
  );
  if (!stagingRegionId) {
    return null;
  }
  const settings = WORLD_BALANCE.war.landFront.offensiveOperation;
  const supportingTargetRegionIds = candidates
    .slice(1)
    .map((candidate) => ({
      candidate,
      distance: getBoundedGraphDistance(
          primary.regionId,
          candidate.regionId,
          settings.supportingTargetRadius,
          frontScope,
          neighborsById,
      ),
    }))
    .filter(
      (item): item is typeof item & { distance: number } =>
        item.distance !== null,
    )
    .sort(
      (a, b) =>
        a.distance - b.distance ||
        b.candidate.score - a.candidate.score ||
        compareIds(a.candidate.regionId, b.candidate.regionId),
    )
    .slice(0, settings.supportingTargetCount)
    .map(({ candidate }) => candidate.regionId);
  return {
    primaryTargetRegionId: primary.regionId,
    supportingTargetRegionIds,
    stagingRegionId,
    nearbyEnemyStrength: primary.nearbyEnemyStrength,
    targetCoverageState: primary.tactical.coverageState,
    targetLocalDefenderStrength: primary.tactical.localDefenderStrength,
    tacticalScore: primary.tactical.score,
    topologyScore: primary.topologyScore,
    pocketClosure: primary.closure,
    tacticalReasons: primary.tactical.reasons,
  };
}

export function planOperationApproaches(
  world: WorldState,
  nationId: NationId,
  targets: OperationTargetSelection,
  assignedUnits: UnitState[],
  isMajorOffensive: boolean,
  requiredOperationStrength = sumUnitStrength(assignedUnits),
): OperationApproachPlan {
  const settings = WORLD_BALANCE.war.landFront.offensiveOperation.multiDirection;
  const single = (fellBackToSingle: boolean): OperationApproachPlan => ({
    regionIds: [targets.stagingRegionId],
    regionByUnitId: new Map(),
    strengthByRegion: new Map([[targets.stagingRegionId, requiredOperationStrength]]),
    fellBackToSingle,
  });
  if (
    assignedUnits.length < settings.minimumAssignedUnits ||
    targets.targetCoverageState === "gap" ||
    targets.targetLocalDefenderStrength <= 0
  ) return single(true);

  const target = getMesoById(world).get(targets.primaryTargetRegionId);
  if (!target) return single(true);
  const distanceField = getControlledDistanceField(world, nationId, [targets.stagingRegionId]);
  const occupiedStrength = new Map<MesoRegionId, number>();
  for (const unit of assignedUnits) {
    occupiedStrength.set(
      unit.regionId,
      (occupiedStrength.get(unit.regionId) ?? 0) + finiteUnitStrength(unit),
    );
  }
  const candidates = target.neighbors
    .map((neighbor) => neighbor.id)
    .filter((regionId) => {
      const region = getMesoById(world).get(regionId);
      const distance = distanceField.distanceByRegionId.get(regionId);
      return !!region && region.type !== "sea" && isRegionControlledBy(world, regionId, nationId) &&
        distance !== undefined && distance <= settings.maximumUnitDetourRegions &&
        canReachControlled(world, nationId, targets.stagingRegionId, regionId);
    })
    .sort((a, b) =>
      (occupiedStrength.get(b) ?? 0) - (occupiedStrength.get(a) ?? 0) ||
      (distanceField.distanceByRegionId.get(a) ?? 0) - (distanceField.distanceByRegionId.get(b) ?? 0) ||
      compareIds(a, b),
    );
  const desiredCount = Math.min(
    candidates.length,
    isMajorOffensive ? settings.majorApproachCount : settings.normalApproachCount,
    Math.floor(assignedUnits.length / 2),
  );
  if (desiredCount < 2) return single(true);
  const regionIds = candidates.slice(0, desiredCount);
  const fractions = settings.approachFractions.slice(0, desiredCount);
  const fractionTotal = fractions.reduce((sum, value) => sum + value, 0) || 1;
  const totalStrength = requiredOperationStrength;
  const desiredStrengths = fractions.map((fraction) => totalStrength * fraction / fractionTotal);
  const strongest = Math.max(...desiredStrengths);
  if (desiredStrengths.some((strength) =>
    strength <= 0 || strength < strongest * settings.minimumApproachStrengthRatio
  )) return single(true);
  return {
    regionIds,
    regionByUnitId: new Map(),
    strengthByRegion: new Map(regionIds.map((regionId, index) => [regionId, desiredStrengths[index]])),
    fellBackToSingle: false,
  };
}

function assessTargetTactics(
  world: WorldState,
  regionId: MesoRegionId,
  front: OperationalSector,
  availableUnits: UnitState[],
  position: FrontlineDefensivePosition | undefined,
  recentBreakthroughCount: number,
  frontScope: ReadonlySet<MesoRegionId>,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
): TargetTacticalAssessment {
  if (!position) {
    return { coverageState: null, localDefenderStrength: 0, score: 0, reasons: [] };
  }
  const settings = WORLD_BALANCE.war.landFront.offensiveOperation.targetScore;
  const localAttackerStrength = availableUnits.reduce((sum, unit) => {
    const distance = getBoundedGraphDistance(
      unit.regionId,
      regionId,
      settings.localAttackerRadius,
      frontScope,
      neighborsById,
    );
    return sum + (distance === null ? 0 : finiteUnitStrength(unit));
  }, 0);
  const requiredStrength = Math.max(1, position.requiredStrength);
  const hasMeaningfulStrength = localAttackerStrength >= requiredStrength * 0.45;
  const localRatio = localAttackerStrength / Math.max(1, position.defenderStrength);
  let score = 0;
  const reasons: OffensiveOperationReason[] = [];
  if (position.state === "gap" && hasMeaningfulStrength) {
    score += settings.frontlineGap;
    reasons.push("enemy-frontline-gap");
  } else if (position.state === "weak" && hasMeaningfulStrength && localRatio >= 1) {
    score += settings.frontlineWeak;
    reasons.push("enemy-frontline-weak");
  }
  if (hasMeaningfulStrength && localRatio >= 1.5) {
    score += settings.localStrengthSuperiority * Math.min(1.5, Math.log2(localRatio) / 2);
    reasons.push("local-strength-superiority");
  } else if (position.defenderStrength > 0 && localRatio < 0.8) {
    score -= settings.localStrengthDisadvantage * (1 - localRatio);
  }
  if (recentBreakthroughCount > 0 && position.state !== "covered") {
    score += settings.recentBreakthrough;
    reasons.push("recent-breakthrough");
  }
  const reserveDeploying = world.strategicReserves.reserves.some((reserve) =>
    reserve.nationId === position.nationId &&
    reserve.deployment?.targetFrontId === front.id &&
    reserve.deployment.status !== "returning",
  );
  if (reserveDeploying) score -= settings.enemyReserveRisk;
  return {
    coverageState: position.state,
    localDefenderStrength: finiteNumber(position.defenderStrength),
    score: finiteNumber(score),
    reasons,
  };
}

function scoreOperationTarget(
  world: WorldState,
  regionId: MesoRegionId,
  plan: NationFrontPlan,
  units: UnitState[],
  enemyNationId: NationId,
  enemyBorderSet: ReadonlySet<MesoRegionId>,
  borderDistance: number,
): number {
  const settings = WORLD_BALANCE.war.landFront.offensiveOperation.targetScore;
  const meso = getMesoById(world).get(regionId);
  const buildingScore =
    meso?.building === "capital"
      ? settings.capital
      : meso?.building === "city"
        ? settings.city
        : 0;
  const borderScore = enemyBorderSet.has(regionId) ? settings.border : 0;
  const averageDistance = averageCenterDistance(units, regionId, world);
  const enemyStrength = getNearbyEnemyStrength(world, regionId, enemyNationId);
  return (
    buildingScore +
    borderScore +
    plan.priority * 0.2 -
    borderDistance * 5 -
    (averageDistance / 50) * settings.distance -
    enemyStrength * settings.enemyStrength
  );
}

function scoreOperationUnit(
  unit: UnitState,
  targetCenter: MesoRegion["center"] | undefined,
  world: WorldState,
): number {
  const unitCenter = getMesoById(world).get(unit.regionId)?.center;
  const distance = targetCenter && unitCenter
    ? Math.sqrt(distanceSq(targetCenter, unitCenter))
    : 0;
  return distance + (1 - clamp(unit.org, 0, 1)) * 80 - Math.log1p(finiteUnitStrength(unit)) * 4;
}

interface ManifestBuildResult {
  manifest: OperationManifestAssignment[];
  onTimeStrengthByApproach: Map<MesoRegionId, number>;
  feasible: boolean;
}

function buildPreflightManifest(
  world: WorldState,
  nationId: NationId,
  _frontId: FrontId,
  approachRegionIds: readonly MesoRegionId[],
  requiredStrengthByApproach: ReadonlyMap<MesoRegionId, number>,
  availableUnits: readonly UnitState[],
  requiredCompletion: number,
  deadlineTick: number,
  existingOperationUnitIds: ReadonlySet<UnitId>,
  isReplacement: boolean,
): ManifestBuildResult {
  const distanceByApproach = new Map(
    approachRegionIds.map((regionId) => [
      regionId,
      getControlledDistanceField(world, nationId, [regionId]).distanceByRegionId,
    ]),
  );
  const candidatesById = new Map(
    availableUnits
      .filter(isOperationalLandUnit)
      .map((unit) => [unit.id, unit]),
  );
  const claimed = new Set<UnitId>();
  const manifest: OperationManifestAssignment[] = [];
  const onTimeStrengthByApproach = new Map(
    approachRegionIds.map((regionId) => [regionId, 0]),
  );

  while (true) {
    const group = [...approachRegionIds]
      .filter((regionId) => {
        const required = requiredStrengthByApproach.get(regionId) ?? 0;
        return (onTimeStrengthByApproach.get(regionId) ?? 0) < required;
      })
      .sort((a, b) => {
        const requiredA = requiredStrengthByApproach.get(a) ?? 0;
        const requiredB = requiredStrengthByApproach.get(b) ?? 0;
        const completionA = requiredA > 0
          ? (onTimeStrengthByApproach.get(a) ?? 0) / requiredA
          : 1;
        const completionB = requiredB > 0
          ? (onTimeStrengthByApproach.get(b) ?? 0) / requiredB
          : 1;
        return completionA - completionB || compareIds(a, b);
      })[0];
    if (!group) break;
    const distanceField = distanceByApproach.get(group);
    if (!distanceField) break;
    const choice = [...candidatesById.values()]
      .filter((unit) => !claimed.has(unit.id))
      .map((unit) => ({
        unit,
        assignment: estimateManifestAssignment(
          world,
          unit,
          group,
          distanceField.get(unit.regionId),
          deadlineTick,
          Math.max(
            0,
            (requiredStrengthByApproach.get(group) ?? 0) -
              (onTimeStrengthByApproach.get(group) ?? 0),
          ),
          existingOperationUnitIds.has(unit.id),
          isReplacement,
        ),
      }))
      .filter((item): item is typeof item & { assignment: OperationManifestAssignment } =>
        !!item.assignment && item.assignment.arrivalSlack >= 0
      )
      .sort((a, b) =>
        a.assignment.controlledDistance - b.assignment.controlledDistance ||
        Number(b.unit.moveTargetId === group || b.unit.moveToId === group) -
          Number(a.unit.moveTargetId === group || a.unit.moveToId === group) ||
        Number(existingOperationUnitIds.has(b.unit.id)) -
          Number(existingOperationUnitIds.has(a.unit.id)) ||
        compareIds(a.unit.id, b.unit.id)
      )[0]?.assignment;
    if (!choice) break;
    manifest.push(choice);
    claimed.add(choice.unitId);
    onTimeStrengthByApproach.set(
      group,
      (onTimeStrengthByApproach.get(group) ?? 0) + choice.strength,
    );
  }

  manifest.sort((a, b) =>
    compareIds(a.approachRegionId, b.approachRegionId) ||
    compareIds(a.unitId, b.unitId)
  );
  const feasible = approachRegionIds.every((regionId) =>
    (onTimeStrengthByApproach.get(regionId) ?? 0) >=
      (requiredStrengthByApproach.get(regionId) ?? 0) * requiredCompletion
  );
  return { manifest, onTimeStrengthByApproach, feasible };
}

function estimateManifestAssignment(
  world: WorldState,
  unit: UnitState,
  approachRegionId: MesoRegionId,
  controlledDistance: number | undefined,
  deadlineTick: number,
  requiredContribution: number,
  _existingOperationMember: boolean,
  isReplacement: boolean,
): OperationManifestAssignment | null {
  if (controlledDistance === undefined) return null;
  const stagingRadius = WORLD_BALANCE.war.landFront.offensiveOperation.stagingRadius;
  const requiredEdges = Math.max(0, controlledDistance - stagingRadius);
  const movingTowardApproach =
    unit.moveTargetId === approachRegionId || unit.moveToId === approachRegionId;
  const moveTicksPerRegion = Math.max(1, Math.round(unit.moveTicksPerRegion));
  const creditedProgressTicks = movingTowardApproach
    ? Math.min(moveTicksPerRegion, unit.moveProgressMs / FAST_TICK_MS)
    : 0;
  const dispatchLatency = requiredEdges > 0 && !movingTowardApproach ? 1 : 0;
  const estimatedTravelTicks = Math.ceil(Math.max(
    0,
    dispatchLatency + requiredEdges * moveTicksPerRegion - creditedProgressTicks,
  ));
  const estimatedArrivalTick = world.time.fastTick + estimatedTravelTicks;
  const strength = finiteUnitStrength(unit);
  return {
    unitId: unit.id,
    approachRegionId,
    controlledDistance,
    estimatedTravelTicks,
    estimatedArrivalTick,
    arrivalSlack: deadlineTick - estimatedArrivalTick,
    requiredContribution: Math.min(strength, requiredContribution),
    strength,
    isReplacement,
    arrivedAtTick: null,
  };
}

function recruitApproachGroups(
  world: WorldState,
  operation: OffensiveOperation,
  allocation: NationFrontAllocation,
  previouslyAssignedIds: ReadonlySet<UnitId>,
): boolean {
  const unitById = new Map(world.units.map((unit) => [unit.id, unit]));
  const allocationUnits = allocation.unitIds
    .map((unitId) => unitById.get(unitId))
    .filter(isOperationalLandUnit);
  const defensiveIds = new Set(
    getFrontlineCoverage(world, operation.frontId, operation.nationId)?.positions.flatMap(
      (position) => position.defenderUnitIds,
    ) ?? [],
  );
  const existingIds = new Set(operation.assignedUnitIds);
  const ownedByOtherOperation = (unitId: UnitId): boolean => {
    const owner = world.offensiveOperations.operationIdByUnitId.get(unitId);
    return owner !== undefined && owner !== operation.id;
  };
  const isUnavailable = (unit: UnitState): boolean =>
    unit.nationId !== operation.nationId || unit.domain !== "land" ||
    world.reorganization.planIdByUnitId.has(unit.id) ||
    world.retreatPlans.retreatIdByUnitId.has(unit.id) ||
    world.collapseAdvances.advanceNationByUnitId.has(unit.id) ||
    ownedByOtherOperation(unit.id);
  const allocationCandidates = allocationUnits.filter((unit) =>
    !isUnavailable(unit) && (!defensiveIds.has(unit.id) || existingIds.has(unit.id))
  );
  const reserve = world.strategicReserves.reservesByNationId.get(operation.nationId);
  const reserveCandidates = reserve?.deployment?.targetFrontId === operation.frontId &&
    reserve.deployment.status !== "returning"
    ? reserve.deployment.unitIds
      .map((unitId) => unitById.get(unitId))
      .filter(isOperationalLandUnit)
      .filter((unit) => !isUnavailable(unit))
    : [];
  const candidatesById = new Map<UnitId, UnitState>();
  for (const unit of [...allocationCandidates, ...reserveCandidates]) {
    candidatesById.set(unit.id, unit);
  }

  const deadlineTick = operation.phaseStartedAtTick +
    WORLD_BALANCE.war.landFront.offensiveOperation.preparationTimeoutTicks;
  const claimed = new Set<UnitId>();
  const assignmentByUnitId = new Map(
    operation.committedManifest.map((assignment) => [assignment.unitId, assignment]),
  );
  for (const group of operation.approachGroups) {
    group.assignedUnitIds = group.assignedUnitIds.filter((unitId) => {
      const unit = unitById.get(unitId);
      if (!unit || isUnavailable(unit)) return false;
      const allocatedFront = world.frontAllocations.frontIdByUnitId.get(unitId);
      if (
        allocatedFront !== undefined &&
        allocatedFront !== operation.frontId &&
        !operation.allocationReclaimedUnitIds.includes(unitId)
      ) {
        operation.allocationReclaimedUnitIds.push(unitId);
        operation.allocationReclaimedUnitIds.sort(compareIds);
        world.offensiveOperations.allocationReclaimCount += 1;
      }
      const distance = getControlledDistanceField(
        world,
        operation.nationId,
        [group.regionId],
      ).distanceByRegionId.get(unit.regionId);
      const estimate = estimateManifestAssignment(
        world,
        unit,
        group.regionId,
        distance,
        deadlineTick,
        group.requiredStrength,
        true,
        assignmentByUnitId.get(unitId)?.isReplacement ?? false,
      );
      if (!estimate || estimate.arrivalSlack < 0) return false;
      const previous = assignmentByUnitId.get(unitId);
      assignmentByUnitId.set(unitId, {
        ...estimate,
        isReplacement: previous?.isReplacement ?? false,
        arrivedAtTick: previous?.arrivedAtTick ?? null,
      });
      claimed.add(unitId);
      return true;
    });
    group.currentAssignedStrength = sumUnitStrength(
      group.assignedUnitIds.map((unitId) => unitById.get(unitId)).filter(isOperationalLandUnit),
    );
    group.feasibleStrength = group.currentAssignedStrength;
  }

  const distanceByApproach = new Map(operation.approachGroups.map((group) => [
    group.regionId,
    getControlledDistanceField(world, operation.nationId, [group.regionId]).distanceByRegionId,
  ]));
  while (true) {
    const group = [...operation.approachGroups]
      .filter((item) =>
        item.feasibleStrength < item.committedStrengthTarget ||
        (operation.approachGroups.length === 1 && claimed.size < 2)
      )
      .sort((a, b) =>
        (a.requiredStrength > 0 ? a.feasibleStrength / a.requiredStrength : 1) -
          (b.requiredStrength > 0 ? b.feasibleStrength / b.requiredStrength : 1) ||
        compareIds(a.regionId, b.regionId)
      )[0];
    if (!group) break;
    const distanceField = distanceByApproach.get(group.regionId)!;
    const item = [...candidatesById.values()]
      .filter((unit) => !claimed.has(unit.id))
      .map((unit) => ({
        unit,
        assignment: estimateManifestAssignment(
          world,
          unit,
          group.regionId,
          distanceField.get(unit.regionId),
          deadlineTick,
          Math.max(0, group.committedStrengthTarget - group.feasibleStrength),
          existingIds.has(unit.id),
          true,
        ),
        movingToAxis: unit.moveTargetId === group.regionId || unit.moveToId === group.regionId,
        alreadyOperation: existingIds.has(unit.id),
        reserve: isStrategicReserveUnit(world, unit.id),
      }))
      .filter((candidate): candidate is typeof candidate & { assignment: OperationManifestAssignment } =>
        !!candidate.assignment && candidate.assignment.arrivalSlack >= 0
      )
      .sort((a, b) =>
        a.assignment.controlledDistance - b.assignment.controlledDistance ||
        Number(b.movingToAxis) - Number(a.movingToAxis) ||
        Number(b.alreadyOperation) - Number(a.alreadyOperation) ||
        compareIds(a.unit.id, b.unit.id)
      )[0];
    if (!item) break;
    if (item.reserve) releaseStrategicReserveUnit(world, item.unit.id);
    group.assignedUnitIds.push(item.unit.id);
    group.assignedUnitIds.sort(compareIds);
    group.currentAssignedStrength += item.assignment.strength;
    group.feasibleStrength += item.assignment.strength;
    group.recruitmentDistanceTotal += item.assignment.controlledDistance;
    group.recruitmentCount += 1;
    operation.recruitmentDistanceTotal += item.assignment.controlledDistance;
    operation.recruitmentCount += 1;
    world.offensiveOperations.recruitmentDistanceTotal += item.assignment.controlledDistance;
    world.offensiveOperations.recruitmentCount += 1;
    if (operation.initialAssignedUnitCount > 0 && !previouslyAssignedIds.has(item.unit.id)) {
      group.replacementRecruitCount += 1;
      operation.replacementRecruitCount += 1;
      world.offensiveOperations.replacementRecruitCount += 1;
      recordArrivalSlack(world, item.assignment.arrivalSlack);
    }
    assignmentByUnitId.set(item.unit.id, item.assignment);
    claimed.add(item.unit.id);
  }

  const nextIds = [...claimed].sort(compareIds);
  const changed = !arraysEqual(operation.assignedUnitIds, nextIds);
  const addedCount = nextIds.filter((unitId) => !previouslyAssignedIds.has(unitId)).length;
  if (addedCount > 0 && operation.initialAssignedUnitCount > 0) {
    world.offensiveOperations.unitAssignmentCount += addedCount;
    world.instrumentation?.incrementCounter(
      "offensiveOperation.unitAssignments",
      addedCount,
    );
  }
  operation.assignedUnitIds = nextIds;
  operation.assignedStrength = sumUnitStrength(nextIds.map((unitId) => unitById.get(unitId)).filter(isOperationalLandUnit));
  operation.approachRegionByUnitId.clear();
  for (const group of operation.approachGroups) {
    for (const unitId of group.assignedUnitIds) operation.approachRegionByUnitId.set(unitId, group.regionId);
  }
  operation.committedManifest = nextIds
    .map((unitId) => assignmentByUnitId.get(unitId))
    .filter((assignment): assignment is OperationManifestAssignment => !!assignment)
    .sort((a, b) =>
      compareIds(a.approachRegionId, b.approachRegionId) ||
      compareIds(a.unitId, b.unitId)
    );
  const requiredCompletion = operation.isMajorOffensive
    ? WORLD_BALANCE.war.landFront.stalemate.majorStagedFraction
    : WORLD_BALANCE.war.landFront.offensiveOperation.stagedFraction;
  operation.preparationFeasible = operation.approachGroups.every((group) => {
    const distanceField = distanceByApproach.get(group.regionId)!;
    let remaining = group.feasibleStrength;
    for (const unit of candidatesById.values()) {
      if (claimed.has(unit.id)) continue;
      const estimate = estimateManifestAssignment(
        world,
        unit,
        group.regionId,
        distanceField.get(unit.regionId),
        deadlineTick,
        group.requiredStrength,
        false,
        true,
      );
      if (estimate && estimate.arrivalSlack >= 0) remaining += estimate.strength;
    }
    group.remainingFeasibleStrength = remaining;
    group.minimumArrivalSlack = minimumSlack(
      operation.committedManifest.filter(
        (assignment) => assignment.approachRegionId === group.regionId,
      ),
    );
    return group.feasibleStrength >= group.requiredStrength * requiredCompletion;
  });
  for (const unitId of [...operation.unitTargetRegionIds.keys()]) {
    if (!nextIds.includes(unitId)) {
      operation.unitTargetRegionIds.delete(unitId);
    }
  }
  if (operation.phase === "attacking") {
    assignStableOperationTargets(operation);
  } else if (operation.phase === "exploiting") {
    operation.exploitationUnitIds = operation.exploitationUnitIds.filter((unitId) =>
      nextIds.includes(unitId),
    );
    const exploitingIds = new Set(operation.exploitationUnitIds);
    operation.exploitationHoldUnitIds = nextIds.filter((unitId) => !exploitingIds.has(unitId));
    assignExploitationTargets(operation);
  }
  return changed;
}

function transitionToAttacking(
  world: WorldState,
  operation: OffensiveOperation,
): void {
  const now = world.time.fastTick;
  endPreparationLease(world, operation);
  const preparingTicks = Math.max(0, now - operation.phaseStartedAtTick);
  world.offensiveOperations.preparingDurationTicks += preparingTicks;
  world.offensiveOperations.preparationSucceededCount += 1;
  world.instrumentation?.incrementCounter(
    "offensiveOperation.preparingTicks",
    preparingTicks,
  );
  operation.phase = "attacking";
  operation.phaseStartedAtTick = now;
  operation.minimumCommitUntilTick =
    now + WORLD_BALANCE.war.landFront.offensiveOperation.minimumCommitTicks;
  operation.expiresAtTick =
    now + WORLD_BALANCE.war.landFront.offensiveOperation.attackTimeoutTicks;
  operation.actualActiveApproachCount = operation.plannedApproachRegionIds.length;
  operation.synchronizationReady = true;
  world.offensiveOperations.achievedApproachCountTotal += operation.actualActiveApproachCount;
  world.offensiveOperations.synchronizationWaitTicks += operation.synchronizationWaitTicks;
  world.instrumentation?.incrementCounter(
    "offensiveOperation.achievedApproaches",
    operation.actualActiveApproachCount,
  );
  world.instrumentation?.incrementCounter(
    "offensiveOperation.synchronizationWaitTicks",
    operation.synchronizationWaitTicks,
  );
  assignStableOperationTargets(operation);
  world.offensiveOperations.phaseTransitionCount += 1;
  world.instrumentation?.incrementCounter("offensiveOperation.phaseTransitions");
  recordEvent(world, operation, "phase-transition", "preparing->attacking");
}

function tryStartExploitation(
  world: WorldState,
  operation: OffensiveOperation,
  successReason: OffensiveOperationCompletionReason,
): boolean {
  if (!world.offensiveOperations.exploitationEnabled) return false;
  if (!isRegionControlledBy(world, operation.primaryTargetRegionId, operation.nationId)) {
    return false;
  }
  if (getCapitalDefenseAssessment(world, operation.nationId)?.threatLevel === "critical") {
    return false;
  }
  const front = findExploitationFront(world, operation);
  if (!front) return false;
  const plan = getFrontPlan(world, front.id, operation.nationId);
  const allocation = getFrontAllocation(world, front.id, operation.nationId);
  if (!plan || plan.posture !== "attack" || !allocation) return false;
  if (
    world.retreatPlans.plansByFrontNation.has(
      createFrontNationKey(front.id, operation.nationId),
    )
  ) {
    return false;
  }
  const settings = WORLD_BALANCE.war.landFront.offensiveOperation;
  const remainingStrength = sumUnitStrength(
    getOperationUnits(world, operation.assignedUnitIds),
  );
  operation.assignedStrength = remainingStrength;
  if (
    operation.initialAssignedStrength <= 0 ||
    remainingStrength / operation.initialAssignedStrength <
      settings.exploitationMinimumRemainingStrengthRatio
  ) {
    return false;
  }
  const exploitationUnits = selectExploitationUnits(world, operation);
  if (exploitationUnits.length === 0 || exploitationUnits.length >= operation.assignedUnitIds.length) {
    return false;
  }
  const target = selectExploitationTarget(world, operation, front, plan, exploitationUnits);
  if (!target) return false;

  const previousFrontId = operation.frontId;
  operation.frontId = target.sectorId;
  if (previousFrontId !== operation.frontId) {
    recordEvent(world, operation, "front-remapped", `${previousFrontId}->${operation.frontId}`);
  }
  operation.attackSuccessReason = successReason;
  operation.exploitationTargetRegionId = target.regionId;
  operation.exploitationTargetCoverageState = target.coverageState;
  operation.exploitationTargetLocalEnemyStrength = target.localEnemyStrength;
  operation.exploitationTargetScore = target.score;
  operation.exploitationDepth = target.depth;
  operation.exploitationUnitIds = exploitationUnits.map((unit) => unit.id).sort(compareIds);
  const exploitationIds = new Set(operation.exploitationUnitIds);
  operation.exploitationHoldUnitIds = operation.assignedUnitIds.filter(
    (unitId) => !exploitationIds.has(unitId),
  );
  operation.exploitationForceStrength = sumUnitStrength(exploitationUnits);
  operation.exploitationStartedAtTick = world.time.fastTick;
  operation.exploitationFrontVersion = world.landFronts.version;
  operation.exploitationStopReason = null;
  const attackingDuration = Math.max(0, world.time.fastTick - operation.phaseStartedAtTick);
  world.offensiveOperations.attackingDurationTicks += attackingDuration;
  world.instrumentation?.incrementCounter("offensiveOperation.attackingTicks", attackingDuration);
  operation.phase = "exploiting";
  operation.phaseStartedAtTick = world.time.fastTick;
  operation.expiresAtTick = world.time.fastTick + settings.exploitationTimeoutTicks;
  assignExploitationTargets(operation);

  const state = world.offensiveOperations;
  state.exploitationStartedCount += 1;
  state.exploitationDepthTotal += target.depth;
  state.exploitationForceUnitTotal += operation.exploitationUnitIds.length;
  state.exploitationForceStrengthTotal += operation.exploitationForceStrength;
  state.phaseTransitionCount += 1;
  world.instrumentation?.incrementCounter("offensiveOperation.phaseTransitions");
  world.instrumentation?.incrementCounter("offensiveOperation.exploitationStarts");
  world.instrumentation?.incrementCounter("offensiveOperation.exploitationDepth", target.depth);
  world.instrumentation?.incrementCounter(
    "offensiveOperation.exploitationForceUnits",
    operation.exploitationUnitIds.length,
  );
  world.instrumentation?.incrementCounter(
    "offensiveOperation.exploitationForceStrength",
    operation.exploitationForceStrength,
  );
  recordEvent(
    world,
    operation,
    "exploitation-started",
    `${target.regionId}:depth-${target.depth}:score-${target.score.toFixed(1)}`,
  );
  return true;
}

function advanceExploitation(
  world: WorldState,
  operation: OffensiveOperation,
): OperationAdvanceResult {
  const startedAt = world.instrumentation ? performance.now() : 0;
  const finish = (reason: ExploitationStopReason): OperationAdvanceResult => {
    stopExploitation(world, operation, reason);
    if (world.instrumentation) {
      world.instrumentation.recordDuration(
        "offensiveOperation.exploitationEvaluation",
        performance.now() - startedAt,
      );
    }
    return { keep: true, changed: true };
  };
  const targetId = operation.exploitationTargetRegionId;
  if (!targetId) return finish("target-invalid");
  if (isRegionControlledBy(world, targetId, operation.nationId)) {
    recordOperationCaptures(world, operation);
    return finish("target-occupied");
  }
  if (!isAtWar(operation.nationId, operation.enemyNationId, buildWarAdjacency(world.wars))) {
    return finish("war-ended");
  }
  if (getCapitalDefenseAssessment(world, operation.nationId)?.threatLevel === "critical") {
    return finish("capital-emergency");
  }
  if (world.time.fastTick >= operation.expiresAtTick) return finish("timeout");

  let front = findExploitationFrontForTarget(world, operation, targetId);
  if (!front) return finish("front-disappeared");
  const retreat = world.retreatPlans.plansByFrontNation.get(
    createFrontNationKey(front.id, operation.nationId),
  );
  const plan = getFrontPlan(world, front.id, operation.nationId);
  if (retreat || plan?.posture === "retreat") return finish("retreat-started");
  if (!plan || plan.posture !== "attack") return finish("local-strength-disadvantage");
  if (!getFrontAllocation(world, front.id, operation.nationId)) {
    return finish("allocation-lost");
  }
  const assignmentChanged = pruneExploitationForce(world, operation);
  if (operation.exploitationUnitIds.length === 0) return finish("force-depleted");
  if (operation.exploitationHoldUnitIds.length === 0) return finish("allocation-lost");

  if (world.landFronts.version !== operation.exploitationFrontVersion) {
    operation.exploitationFrontVersion = world.landFronts.version;
    const targetStillValid = findExploitationCoveragePosition(
      world,
      front.id,
      operation.enemyNationId,
      targetId,
    );
    if (!targetStillValid) {
      const units = getOperationUnits(world, operation.exploitationUnitIds);
      const replacement = selectExploitationTarget(world, operation, front, plan, units);
      if (!replacement) return finish("target-invalid");
      operation.exploitationTargetRegionId = replacement.regionId;
      operation.exploitationTargetCoverageState = replacement.coverageState;
      operation.exploitationTargetLocalEnemyStrength = replacement.localEnemyStrength;
      operation.exploitationTargetScore = replacement.score;
      operation.exploitationDepth = replacement.depth;
      const previousFrontId = operation.frontId;
      operation.frontId = replacement.sectorId;
      front = world.landFronts.operationalSectorsById.get(replacement.sectorId) ?? front;
      assignExploitationTargets(operation);
      if (previousFrontId !== operation.frontId) {
        recordEvent(world, operation, "front-remapped", `${previousFrontId}->${operation.frontId}`);
      }
    }
  }

  const currentTargetId = operation.exploitationTargetRegionId;
  if (!currentTargetId) return finish("target-invalid");
  const position = findExploitationCoveragePosition(
    world,
    operation.frontId,
    operation.enemyNationId,
    currentTargetId,
  );
  if (!position) return finish("target-invalid");
  if (position.state === "covered") return finish("covered-frontline");
  if (hasEnemyReserveNearExploitation(world, operation.enemyNationId, operation.frontId, currentTargetId)) {
    return finish("enemy-reserve-arrival");
  }
  const exploitationUnits = getOperationUnits(world, operation.exploitationUnitIds);
  const currentStrength = sumUnitStrength(exploitationUnits);
  if (
    exploitationUnits.length === 0 ||
    operation.exploitationForceStrength <= 0 ||
    currentStrength / operation.exploitationForceStrength <
      WORLD_BALANCE.war.landFront.offensiveOperation.exploitationMinimumRemainingStrengthRatio
  ) {
    return finish("force-depleted");
  }
  const localEnemyStrength = Math.max(
    position.defenderStrength,
    getExploitationLocalEnemyStrength(world, currentTargetId, operation.enemyNationId),
  );
  if (
    getStrengthRatio(currentStrength, localEnemyStrength) <
    WORLD_BALANCE.war.landFront.offensiveOperation.exploitationStopStrengthRatio
  ) {
    return finish("local-strength-disadvantage");
  }
  if (!isExploitationTargetWithinDepth(world, operation, currentTargetId)) {
    return finish("target-invalid");
  }
  if (world.instrumentation) {
    world.instrumentation.recordDuration(
      "offensiveOperation.exploitationEvaluation",
      performance.now() - startedAt,
    );
  }
  return { keep: true, changed: assignmentChanged };
}

function stopExploitation(
  world: WorldState,
  operation: OffensiveOperation,
  reason: ExploitationStopReason,
): void {
  if (operation.phase !== "exploiting") return;
  const duration = Math.max(0, world.time.fastTick - operation.phaseStartedAtTick);
  const state = world.offensiveOperations;
  state.exploitationDurationTicks += duration;
  state.exploitationStoppedCount += 1;
  state.exploitationStopCounts[reason] += 1;
  if (reason === "target-occupied") state.exploitationSuccessCount += 1;
  operation.exploitationStopReason = reason;
  world.instrumentation?.incrementCounter("offensiveOperation.exploitingTicks", duration);
  world.instrumentation?.incrementCounter("offensiveOperation.exploitationStops");
  world.instrumentation?.incrementCounter(`offensiveOperation.exploitationStop.${reason}`);
  if (reason === "target-occupied") {
    world.instrumentation?.incrementCounter("offensiveOperation.exploitationSuccesses");
  }
  recordEvent(world, operation, "exploitation-stopped", reason);
  finishOperation(
    world,
    operation,
    "success",
    operation.attackSuccessReason ?? "primary-target-occupied",
  );
}

function selectExploitationUnits(
  world: WorldState,
  operation: OffensiveOperation,
): UnitState[] {
  const units = getOperationUnits(world, operation.assignedUnitIds);
  if (units.length < 2) return [];
  const settings = WORLD_BALANCE.war.landFront.offensiveOperation;
  const desiredCount = clamp(
    Math.ceil(units.length * settings.exploitationForceFraction),
    1,
    units.length - 1,
  );
  const primaryCenter = getMesoById(world).get(operation.primaryTargetRegionId)?.center;
  return [...units]
    .sort((a, b) =>
      scoreOperationUnit(a, primaryCenter, world) -
        scoreOperationUnit(b, primaryCenter, world) ||
      compareIds(a.id, b.id),
    )
    .slice(0, desiredCount);
}

function selectExploitationTarget(
  world: WorldState,
  operation: OffensiveOperation,
  front: OperationalSector,
  plan: NationFrontPlan,
  exploitationUnits: UnitState[],
): ExploitationTargetSelection | null {
  if (exploitationUnits.length === 0) return null;
  const settings = WORLD_BALANCE.war.landFront.offensiveOperation;
  const depths = collectShallowExploitationDepths(
    world,
    operation.primaryTargetRegionId,
    operation.nationId,
    operation.enemyNationId,
    settings.exploitationMaximumDepth,
  );
  const forceStrength = sumUnitStrength(exploitationUnits);
  const candidates: ExploitationTargetSelection[] = [];
  for (const [regionId, depth] of depths) {
    if (!isRegionControlledBy(world, regionId, operation.enemyNationId)) continue;
    const sector = findExploitationSectorForRegion(world, operation, regionId, front.id);
    if (!sector) continue;
    if (operation.isSchwerpunktOperation && sector.id !== front.id) continue;
    const position = findExploitationCoveragePosition(
      world,
      sector.id,
      operation.enemyNationId,
      regionId,
    );
    if (!position) continue;
    world.offensiveOperations.exploitationCandidateEvaluatedCounts[position.state] += 1;
    if (position.state === "covered") continue;
    if (hasEnemyReserveNearExploitation(world, operation.enemyNationId, sector.id, regionId)) {
      world.offensiveOperations.exploitationRejectionCounts.reserveThreat += 1;
      continue;
    }
    const localEnemyStrength = Math.max(
      position.defenderStrength,
      getExploitationLocalEnemyStrength(world, regionId, operation.enemyNationId),
    );
    const localRatio = getStrengthRatio(forceStrength, localEnemyStrength);
    if (localRatio < settings.exploitationStartStrengthRatio) {
      world.offensiveOperations.exploitationRejectionCounts.insufficientLocalStrength += 1;
      continue;
    }
    const enemySide = getOpposingFrontSide(sector, operation.nationId);
    if (!enemySide) continue;
    const coverageScore = position.state === "gap"
      ? settings.targetScore.frontlineGap
      : settings.targetScore.frontlineWeak;
    const localScore = localRatio >= 1.5
      ? settings.targetScore.localStrengthSuperiority *
        Math.min(1.5, Math.log2(localRatio) / 2)
      : 0;
    const recentBreakthroughScore =
      getFrontlineCoverage(world, sector.id, operation.enemyNationId)?.breakthroughCount
        ? settings.targetScore.recentBreakthrough
        : 0;
    const sameSectorScore = sector.id === front.id ? settings.exploitationSameSectorBonus : 0;
    const scoringStartedAt = world.instrumentation ? performance.now() : 0;
    const score = scoreOperationTarget(
      world,
      regionId,
      plan,
      exploitationUnits,
      operation.enemyNationId,
      new Set(enemySide.borderRegionIds),
      depth,
    ) + coverageScore + localScore + recentBreakthroughScore + sameSectorScore;
    if (world.instrumentation) {
      world.instrumentation.recordDuration(
        "offensiveOperation.exploitationCandidateScoring",
        performance.now() - scoringStartedAt,
      );
    }
    candidates.push({
      regionId,
      sectorId: sector.id,
      depth,
      score: finiteNumber(score),
      coverageState: position.state,
      localEnemyStrength: finiteNumber(localEnemyStrength),
    });
  }
  const selected = candidates.sort((a, b) =>
    b.score - a.score || a.depth - b.depth || compareIds(a.regionId, b.regionId),
  )[0] ?? null;
  if (selected) {
    world.offensiveOperations.exploitationSelectedCounts[selected.coverageState] += 1;
  }
  return selected;
}

function collectShallowExploitationDepths(
  world: WorldState,
  startId: MesoRegionId,
  nationId: NationId,
  enemyNationId: NationId,
  maximumDepth: number,
): Map<MesoRegionId, number> {
  const result = new Map<MesoRegionId, number>();
  const visited = new Set<MesoRegionId>([startId]);
  let frontier = [startId];
  const mesoById = getMesoById(world);
  const neighborsById = getNeighborsById(world);
  for (let depth = 1; depth <= maximumDepth; depth += 1) {
    const next: MesoRegionId[] = [];
    for (const currentId of frontier.sort(compareIds)) {
      for (const regionId of [...(neighborsById.get(currentId) ?? [])].sort(compareIds)) {
        if (visited.has(regionId)) continue;
        visited.add(regionId);
        const meso = mesoById.get(regionId);
        if (!meso || meso.type === "sea") continue;
        const traversable =
          isRegionControlledBy(world, regionId, nationId) ||
          isRegionControlledBy(world, regionId, enemyNationId);
        if (!traversable) continue;
        next.push(regionId);
        if (isRegionControlledBy(world, regionId, enemyNationId)) {
          result.set(regionId, depth);
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return result;
}

function findExploitationFront(
  world: WorldState,
  operation: OffensiveOperation,
): OperationalSector | undefined {
  const current = world.landFronts.operationalSectorsById.get(operation.frontId);
  if (
    current &&
    getFrontSide(current, operation.nationId)?.influenceRegionIds.includes(
      operation.primaryTargetRegionId,
    )
  ) {
    return current;
  }
  return world.landFronts.operationalSectors
    .filter((sector) => {
      const samePair =
        (sector.nationAId === operation.nationId && sector.nationBId === operation.enemyNationId) ||
        (sector.nationBId === operation.nationId && sector.nationAId === operation.enemyNationId);
      return samePair && !!getFrontSide(sector, operation.nationId)?.influenceRegionIds.includes(
        operation.primaryTargetRegionId,
      );
    })
    .sort((a, b) => compareIds(a.id, b.id))[0];
}

function findExploitationFrontForTarget(
  world: WorldState,
  operation: OffensiveOperation,
  targetId: MesoRegionId,
): OperationalSector | undefined {
  return findExploitationSectorForRegion(world, operation, targetId, operation.frontId);
}

function findExploitationSectorForRegion(
  world: WorldState,
  operation: OffensiveOperation,
  regionId: MesoRegionId,
  preferredSectorId: FrontId,
): OperationalSector | undefined {
  return world.landFronts.operationalSectors
    .filter((sector) => {
      const samePair =
        (sector.nationAId === operation.nationId && sector.nationBId === operation.enemyNationId) ||
        (sector.nationBId === operation.nationId && sector.nationAId === operation.enemyNationId);
      return samePair && !!getOpposingFrontSide(sector, operation.nationId)?.influenceRegionIds.includes(regionId);
    })
    .sort((a, b) =>
      Number(b.id === preferredSectorId) - Number(a.id === preferredSectorId) ||
      compareIds(a.id, b.id),
    )[0];
}

function findExploitationCoveragePosition(
  world: WorldState,
  sectorId: FrontId,
  enemyNationId: NationId,
  regionId: MesoRegionId,
): FrontlineDefensivePosition | undefined {
  const startedAt = world.instrumentation ? performance.now() : 0;
  const result = getFrontlineCoverage(world, sectorId, enemyNationId)?.positions.find(
    (position) => position.friendlyRegionId === regionId,
  );
  if (world.instrumentation) {
    world.instrumentation.recordDuration(
      "offensiveOperation.exploitationCoverageLookup",
      performance.now() - startedAt,
    );
  }
  return result;
}

function getExploitationLocalEnemyStrength(
  world: WorldState,
  targetId: MesoRegionId,
  enemyNationId: NationId,
): number {
  const startedAt = world.instrumentation ? performance.now() : 0;
  const strength = getNearbyEnemyStrength(world, targetId, enemyNationId);
  if (world.instrumentation) {
    world.instrumentation.recordDuration(
      "offensiveOperation.exploitationLocalStrength",
      performance.now() - startedAt,
    );
  }
  return strength;
}

function hasEnemyReserveNearExploitation(
  world: WorldState,
  enemyNationId: NationId,
  sectorId: FrontId,
  targetId: MesoRegionId,
): boolean {
  const neighboringIds = new Set([targetId, ...(getNeighborsById(world).get(targetId) ?? [])]);
  return world.strategicReserves.reserves.some((reserve) => {
    const deployment = reserve.deployment;
    return reserve.nationId === enemyNationId &&
      !!deployment &&
      deployment.status !== "returning" &&
      (deployment.targetFrontId === sectorId ||
        deployment.targetRegionIds.some((regionId) => neighboringIds.has(regionId)));
  });
}

function getOperationUnits(world: WorldState, unitIds: readonly UnitId[]): UnitState[] {
  const ids = new Set(unitIds);
  return world.units.filter(
    (unit) => ids.has(unit.id) && unit.domain === "land",
  );
}

function isExploitationTargetWithinDepth(
  world: WorldState,
  operation: OffensiveOperation,
  targetId: MesoRegionId,
): boolean {
  return collectShallowExploitationDepths(
    world,
    operation.primaryTargetRegionId,
    operation.nationId,
    operation.enemyNationId,
    WORLD_BALANCE.war.landFront.offensiveOperation.exploitationMaximumDepth,
  ).has(targetId);
}

function assignExploitationTargets(operation: OffensiveOperation): void {
  const targetId = operation.exploitationTargetRegionId;
  if (!targetId) return;
  operation.unitTargetRegionIds.clear();
  for (const unitId of operation.exploitationUnitIds) {
    operation.unitTargetRegionIds.set(unitId, targetId);
  }
  for (const unitId of operation.exploitationHoldUnitIds) {
    operation.unitTargetRegionIds.set(unitId, operation.primaryTargetRegionId);
  }
}

function pruneExploitationForce(
  world: WorldState,
  operation: OffensiveOperation,
): boolean {
  const liveIds = new Set(getOperationUnits(world, operation.assignedUnitIds).map((unit) => unit.id));
  const assignedUnitIds = operation.assignedUnitIds.filter((unitId) => liveIds.has(unitId));
  const exploitationUnitIds = operation.exploitationUnitIds.filter((unitId) => liveIds.has(unitId));
  const exploitationHoldUnitIds = operation.exploitationHoldUnitIds.filter((unitId) => liveIds.has(unitId));
  const changed =
    !arraysEqual(operation.assignedUnitIds, assignedUnitIds) ||
    !arraysEqual(operation.exploitationUnitIds, exploitationUnitIds) ||
    !arraysEqual(operation.exploitationHoldUnitIds, exploitationHoldUnitIds);
  operation.assignedUnitIds = assignedUnitIds;
  operation.exploitationUnitIds = exploitationUnitIds;
  operation.exploitationHoldUnitIds = exploitationHoldUnitIds;
  operation.assignedStrength = sumUnitStrength(getOperationUnits(world, assignedUnitIds));
  if (changed) assignExploitationTargets(operation);
  return changed;
}

function finishOperation(
  world: WorldState,
  operation: OffensiveOperation,
  outcome: OffensiveOperationOutcome,
  completionReason: OffensiveOperationCompletionReason,
): void {
  const now = world.time.fastTick;
  if (operation.phase === "preparing") {
    const automaticOverride = preparationLeaseOverrideForCompletion(completionReason);
    if (automaticOverride) {
      recordPreparationLeaseOverride(world, operation, automaticOverride);
    }
    endPreparationLease(world, operation);
  }
  const duration = Math.max(0, now - operation.phaseStartedAtTick);
  if (operation.phase === "preparing") {
    world.offensiveOperations.preparingDurationTicks += duration;
    world.instrumentation?.incrementCounter(
      "offensiveOperation.preparingTicks",
      duration,
    );
  } else if (operation.phase === "attacking") {
    world.offensiveOperations.attackingDurationTicks += duration;
    world.instrumentation?.incrementCounter(
      "offensiveOperation.attackingTicks",
      duration,
    );
  }
  operation.phase = "recovering";
  operation.phaseStartedAtTick = now;
  operation.expiresAtTick =
    now + WORLD_BALANCE.war.landFront.offensiveOperation.recoveryTicks;
  operation.outcome = outcome;
  operation.completionReason = completionReason;
  operation.completedAtTick = now;
  if (operation.isSchwerpunktOperation) {
    recordMajorOffensiveOutcome(
      world,
      operation.nationId,
      operation.enemyNationId,
      outcome === "success",
      operation.isMajorOffensive,
    );
  }
  world.offensiveOperations.phaseTransitionCount += 1;
  world.instrumentation?.incrementCounter("offensiveOperation.phaseTransitions");
  if (outcome === "success") {
    recordOperationCaptures(world, operation);
    world.offensiveOperations.successfulCapturedRegionCount += operation.capturedRegionIds.length;
    world.offensiveOperations.completedCount += 1;
    world.instrumentation?.incrementCounter("offensiveOperation.completed");
    recordEvent(world, operation, "success", completionReason);
  } else if (outcome === "failure") {
    world.offensiveOperations.failedCount += 1;
    world.instrumentation?.incrementCounter("offensiveOperation.failed");
    recordEvent(world, operation, "failure", completionReason);
  } else {
    world.offensiveOperations.cancelledCount += 1;
    world.instrumentation?.incrementCounter("offensiveOperation.cancelled");
    recordEvent(world, operation, "cancelled", completionReason);
  }
}

function preparationLeaseOverrideForCompletion(
  reason: OffensiveOperationCompletionReason,
): PreparationLeaseOverrideReason | null {
  if (reason === "capital-emergency") return "capital-emergency";
  if (
    reason === "front-disappeared" ||
    reason === "target-invalid" ||
    reason === "target-unreachable" ||
    reason === "allocation-lost" ||
    reason === "war-ended"
  ) return "front-invalid";
  if (reason === "posture-changed") return "operation-cancelled";
  return null;
}

function recordPreparationLeaseOverride(
  world: WorldState,
  operation: OffensiveOperation,
  reason: PreparationLeaseOverrideReason,
): void {
  if (operation.leaseOverrideReasons.includes(reason)) return;
  operation.leaseOverrideReasons.push(reason);
  world.offensiveOperations.leaseOverrideCount += 1;
  world.offensiveOperations.leaseOverrideCounts[reason] += 1;
  world.instrumentation?.incrementCounter(
    `offensiveOperation.leaseOverride.${reason}`,
  );
  recordEvent(world, operation, "lease-override", reason);
}

function endPreparationLease(
  world: WorldState,
  operation: OffensiveOperation,
): void {
  if (operation.preparationLeaseEndedAtTick !== null) return;
  operation.preparationLeaseEndedAtTick = world.time.fastTick;
  const lifetime = Math.max(
    0,
    world.time.fastTick - operation.preparationLeaseStartedAtTick,
  );
  world.offensiveOperations.preparationLeaseLifetimeTotal += lifetime;
  world.offensiveOperations.preparationLeaseLifetimeCount += 1;
  world.instrumentation?.incrementCounter(
    "offensiveOperation.preparationLeaseLifetimeTicks",
    lifetime,
  );
}

function assignStableOperationTargets(operation: OffensiveOperation): void {
  if (operation.plannedApproachRegionIds.length >= 2) {
    operation.unitTargetRegionIds.clear();
    for (const unitId of operation.assignedUnitIds) {
      operation.unitTargetRegionIds.set(unitId, operation.primaryTargetRegionId);
    }
    return;
  }
  const targets = [
    operation.primaryTargetRegionId,
    ...operation.supportingTargetRegionIds,
  ];
  const validExisting = new Map<UnitId, MesoRegionId>();
  for (const unitId of operation.assignedUnitIds) {
    const targetId = operation.unitTargetRegionIds.get(unitId);
    if (targetId && targets.includes(targetId)) {
      validExisting.set(unitId, targetId);
    }
  }
  const desiredCounts = distributeCounts(
    operation.assignedUnitIds.length,
    targets.length,
    WORLD_BALANCE.war.landFront.offensiveOperation.targetFractions,
  );
  const counts = new Map<MesoRegionId, number>();
  for (const targetId of validExisting.values()) {
    counts.set(targetId, (counts.get(targetId) ?? 0) + 1);
  }
  for (const unitId of operation.assignedUnitIds) {
    if (validExisting.has(unitId)) {
      continue;
    }
    let bestIndex = 0;
    let bestNeed = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < targets.length; index += 1) {
      const targetId = targets[index];
      const need = desiredCounts[index] - (counts.get(targetId) ?? 0);
      if (need > bestNeed) {
        bestIndex = index;
        bestNeed = need;
      }
    }
    const targetId = targets[bestIndex];
    operation.unitTargetRegionIds.set(unitId, targetId);
    counts.set(targetId, (counts.get(targetId) ?? 0) + 1);
  }
}

function distributeCounts(
  total: number,
  targetCount: number,
  configuredFractions: readonly number[],
): number[] {
  if (targetCount <= 0) {
    return [];
  }
  if (targetCount === 1) {
    return [total];
  }
  const fractions = configuredFractions.slice(0, targetCount);
  const fractionTotal = fractions.reduce((sum, value) => sum + value, 0) || 1;
  const raw = fractions.map((fraction) => (total * fraction) / fractionTotal);
  const counts = raw.map((value) => Math.floor(value));
  let remaining = total - counts.reduce((sum, value) => sum + value, 0);
  const remainderOrder = raw
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let index = 0; index < remainderOrder.length && remaining > 0; index += 1) {
    counts[remainderOrder[index].index] += 1;
    remaining -= 1;
  }
  return counts;
}

export function getApproachReadiness(
  world: WorldState,
  operation: OffensiveOperation,
): {
  readyCount: number;
  ready: boolean;
  operationCompletion: number;
  stagedStrengthByApproach: Map<MesoRegionId, number>;
} {
  const unitById = new Map(world.units.map((unit) => [unit.id, unit]));
  const neighborsById = getNeighborsById(world);
  const radius = WORLD_BALANCE.war.landFront.offensiveOperation.stagingRadius;
  const stagedStrengthByApproach = new Map(
    operation.plannedApproachRegionIds.map((regionId) => [regionId, 0]),
  );
  for (const unitId of operation.assignedUnitIds) {
    const unit = unitById.get(unitId);
    const approach = operation.approachRegionByUnitId.get(unitId);
    if (!unit || !approach || getBoundedGraphDistance(
      unit.regionId,
      approach,
      radius,
      undefined,
      neighborsById,
    ) === null) continue;
    stagedStrengthByApproach.set(
      approach,
      (stagedStrengthByApproach.get(approach) ?? 0) + finiteUnitStrength(unit),
    );
    const assignment = operation.committedManifest?.find(
      (item) => item.unitId === unitId,
    );
    if (assignment && assignment.arrivedAtTick === null) {
      assignment.arrivedAtTick = world.time.fastTick;
      if (assignment.isReplacement) {
        world.offensiveOperations.replacementArrivalCount += 1;
        world.instrumentation?.incrementCounter(
          "offensiveOperation.replacementArrivals",
        );
      }
    }
  }
  const requiredCompletion = operation.isMajorOffensive
    ? WORLD_BALANCE.war.landFront.stalemate.majorStagedFraction
    : WORLD_BALANCE.war.landFront.offensiveOperation.stagedFraction;
  let readyCount = 0;
  let operationCompletion = 1;
  for (const approach of operation.plannedApproachRegionIds) {
    const planned = operation.plannedStrengthByApproach.get(approach) ?? 0;
    const staged = stagedStrengthByApproach.get(approach) ?? 0;
    const completion = planned > 0 ? Math.min(1, staged / planned) : 0;
    operationCompletion = Math.min(operationCompletion, completion);
    if (completion >= requiredCompletion) readyCount += 1;
    const group = operation.approachGroups?.find((item) => item.regionId === approach);
    if (group) {
      group.currentAssignedStrength = sumUnitStrength(
        group.assignedUnitIds.map((unitId) => unitById.get(unitId)).filter(isOperationalLandUnit),
      );
      group.readyStrength = staged;
      group.completion = completion;
    }
  }
  return {
    readyCount,
    ready: readyCount === operation.plannedApproachRegionIds.length,
    operationCompletion,
    stagedStrengthByApproach,
  };
}

function getLaunchLocalStrength(
  world: WorldState,
  operation: OffensiveOperation,
): { attackerStrength: number; defenderStrength: number } {
  const readiness = getApproachReadiness(world, operation);
  const attackerStrength = [...readiness.stagedStrengthByApproach.values()]
    .reduce((sum, strength) => sum + strength, 0);
  const coverage = getFrontlineCoverage(world, operation.frontId, operation.enemyNationId);
  const positionStrength = coverage?.positions.find(
    (position) => position.friendlyRegionId === operation.primaryTargetRegionId,
  )?.defenderStrength ?? 0;
  const defenderStrength = Math.max(
    positionStrength,
    getNearbyEnemyStrength(world, operation.primaryTargetRegionId, operation.enemyNationId),
  );
  return { attackerStrength, defenderStrength };
}

function isTargetReachableWithinFront(
  world: WorldState,
  operation: OffensiveOperation,
  front: OperationalSector,
): boolean {
  const friendly = getFrontSide(front, operation.nationId);
  const enemy = getOpposingFrontSide(front, operation.nationId);
  if (!friendly || !enemy) {
    return false;
  }
  const scope = new Set([
    ...friendly.influenceRegionIds,
    ...enemy.influenceRegionIds,
  ]);
  return (
    getBoundedGraphDistance(
      operation.stagingRegionId,
      operation.primaryTargetRegionId,
      scope.size,
      scope,
      getNeighborsById(world),
    ) !== null
  );
}

function hasOccupiedSupportingMajority(
  world: WorldState,
  operation: OffensiveOperation,
): boolean {
  if (operation.supportingTargetRegionIds.length === 0) {
    return false;
  }
  const occupied = operation.supportingTargetRegionIds.filter((regionId) =>
    isRegionControlledBy(world, regionId, operation.nationId),
  ).length;
  return occupied > operation.supportingTargetRegionIds.length / 2;
}

function collectOperationReasons(
  world: WorldState,
  plan: NationFrontPlan,
  front: OperationalSector,
  targets: OperationTargetSelection,
  strengthRatio: number,
): OffensiveOperationReason[] {
  const reasons: OffensiveOperationReason[] = [];
  const settings = WORLD_BALANCE.war.landFront.offensiveOperation;
  const target = targets.primaryTargetRegionId;
  const targetBuilding = getMesoById(world).get(target)?.building;
  reasons.push(...targets.tacticalReasons);
  if (targets.pocketClosure) reasons.push("pocket-closure");
  if (strengthRatio > 1.4) {
    reasons.push("front-superiority");
  }
  if (targetBuilding === "capital") {
    reasons.push("enemy-capital-opportunity");
  } else if (targetBuilding === "city") {
    reasons.push("enemy-city-opportunity");
  }
  if (plan.priority >= settings.highPriorityThreshold) {
    reasons.push("high-front-priority");
  }
  if (targets.nearbyEnemyStrength < Math.max(1, frontSideStrength(front, plan.nationId))) {
    reasons.push("weak-enemy-presence");
  }
  return reasons.length > 0 ? reasons : ["high-front-priority"];
}

function sampleOperationMetrics(world: WorldState): void {
  const state = world.offensiveOperations;
  const active = state.operations.filter((operation) => operation.phase !== "recovering");
  world.instrumentation?.incrementCounter(
    "offensiveOperation.activeSamples",
    active.length,
  );
  world.instrumentation?.incrementCounter("offensiveOperation.activeSampleCount");
  world.instrumentation?.incrementCounter(
    "offensiveOperation.targetChanges",
    0,
  );
  for (const operation of active) {
    if (operation.phase === "preparing") {
      for (const group of operation.approachGroups) {
        state.approachCompletionSampleTotal += group.completion;
        state.approachCompletionSampleCount += 1;
      }
    }
    if (operation.phase !== "attacking" && operation.phase !== "exploiting") {
      continue;
    }
    const targetCounts = new Map<MesoRegionId, number>();
    for (const targetId of operation.unitTargetRegionIds.values()) {
      targetCounts.set(targetId, (targetCounts.get(targetId) ?? 0) + 1);
    }
    const concentration = Math.max(0, ...targetCounts.values());
    world.instrumentation?.incrementCounter(
      "offensiveOperation.targetConcentrationTotal",
      concentration,
    );
    world.instrumentation?.incrementCounter(
      "offensiveOperation.targetConcentrationSamples",
    );
    if (concentration > state.maxTargetConcentration) {
      const increase = concentration - state.maxTargetConcentration;
      state.maxTargetConcentration = concentration;
      world.instrumentation?.incrementCounter(
        "offensiveOperation.targetConcentrationMax",
        increase,
      );
    }
  }
}

function rebuildOperationIndexes(state: OffensiveOperationState): void {
  state.operations.sort(compareOperations);
  state.operationsById = new Map(
    state.operations.map((operation) => [operation.id, operation]),
  );
  state.operationsByNationId = new Map();
  state.operationsByFrontNation = new Map();
  state.operationIdByUnitId = new Map();
  for (const operation of state.operations) {
    const byNation = state.operationsByNationId.get(operation.nationId);
    if (byNation) {
      byNation.push(operation);
    } else {
      state.operationsByNationId.set(operation.nationId, [operation]);
    }
    state.operationsByFrontNation.set(
      createFrontNationKey(operation.frontId, operation.nationId),
      operation,
    );
    if (operation.phase === "recovering") {
      continue;
    }
    for (const unitId of operation.assignedUnitIds) {
      if (!state.operationIdByUnitId.has(unitId)) {
        state.operationIdByUnitId.set(unitId, operation.id);
      }
    }
  }
}

function archiveOperation(world: WorldState, operation: OffensiveOperation): void {
  const state = world.offensiveOperations;
  state.history.push(cloneOperation(operation));
  const limit = WORLD_BALANCE.war.landFront.offensiveOperation.historyLimit;
  if (state.history.length > limit) {
    state.history.splice(0, state.history.length - limit);
  }
}

function recordEvent(
  world: WorldState,
  operation: OffensiveOperation,
  type: OffensiveOperationEventType,
  detail: string,
): void {
  const timeline = world.offensiveOperations.timeline;
  timeline.push({
    tick: world.time.fastTick,
    operationId: operation.id,
    nationId: operation.nationId,
    frontId: operation.frontId,
    type,
    phase: operation.phase,
    detail,
  });
  const limit = WORLD_BALANCE.war.landFront.offensiveOperation.timelineLimit;
  if (timeline.length > limit) {
    timeline.splice(0, timeline.length - limit);
  }
}

function cloneOperation(operation: OffensiveOperation): OffensiveOperation {
  return {
    ...operation,
    supportingTargetRegionIds: [...operation.supportingTargetRegionIds],
    assignedUnitIds: [...operation.assignedUnitIds],
    initialAssignedUnitIds: [...operation.initialAssignedUnitIds],
    exploitationUnitIds: [...operation.exploitationUnitIds],
    exploitationHoldUnitIds: [...operation.exploitationHoldUnitIds],
    capturedRegionIds: [...operation.capturedRegionIds],
    unitTargetRegionIds: new Map(operation.unitTargetRegionIds),
    plannedApproachRegionIds: [...operation.plannedApproachRegionIds],
    approachRegionByUnitId: new Map(operation.approachRegionByUnitId),
    plannedStrengthByApproach: new Map(operation.plannedStrengthByApproach),
    approachGroups: operation.approachGroups.map((group) => ({
      ...group,
      assignedUnitIds: [...group.assignedUnitIds],
    })),
    committedManifest: operation.committedManifest.map((assignment) => ({
      ...assignment,
    })),
    leaseOverrideReasons: [...operation.leaseOverrideReasons],
    allocationReclaimedUnitIds: [...operation.allocationReclaimedUnitIds],
    reasonFlags: [...operation.reasonFlags],
    pocketClosureObjective: operation.pocketClosureObjective
      ? clonePocketClosureOpportunity(operation.pocketClosureObjective) : null,
    pocketClosureConfirmation: operation.pocketClosureConfirmation
      ? { ...operation.pocketClosureConfirmation,
        trappedRegionIds: [...operation.pocketClosureConfirmation.trappedRegionIds] }
      : null,
  };
}

function recordOperationCaptures(world: WorldState, operation: OffensiveOperation): void {
  const captured = new Set(operation.capturedRegionIds);
  for (const regionId of [
    operation.primaryTargetRegionId,
    ...operation.supportingTargetRegionIds,
    ...(operation.exploitationTargetRegionId ? [operation.exploitationTargetRegionId] : []),
  ]) {
    if (isRegionControlledBy(world, regionId, operation.nationId)) captured.add(regionId);
  }
  operation.capturedRegionIds = [...captured].sort(compareIds);
}

function createExploitationStopCounts(): Record<ExploitationStopReason, number> {
  return {
    "target-occupied": 0,
    "covered-frontline": 0,
    "local-strength-disadvantage": 0,
    "enemy-reserve-arrival": 0,
    "retreat-started": 0,
    "capital-emergency": 0,
    "front-disappeared": 0,
    timeout: 0,
    "force-depleted": 0,
    "allocation-lost": 0,
    "war-ended": 0,
    "target-invalid": 0,
  };
}

function buildBoundedDistanceField(
  sourceIds: MesoRegionId[],
  scope: ReadonlySet<MesoRegionId>,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
): Map<MesoRegionId, number> {
  const distances = new Map<MesoRegionId, number>();
  const queue: MesoRegionId[] = [];
  for (const sourceId of [...sourceIds].sort(compareIds)) {
    if (!scope.has(sourceId) || distances.has(sourceId)) {
      continue;
    }
    distances.set(sourceId, 0);
    queue.push(sourceId);
  }
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    const distance = distances.get(current) ?? 0;
    for (const neighborId of neighborsById.get(current) ?? []) {
      if (!scope.has(neighborId) || distances.has(neighborId)) {
        continue;
      }
      distances.set(neighborId, distance + 1);
      queue.push(neighborId);
    }
  }
  return distances;
}

function findNearestStagingRegion(
  targetId: MesoRegionId,
  stagingCandidates: MesoRegionId[],
  scope: ReadonlySet<MesoRegionId>,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
): MesoRegionId | null {
  const candidateSet = new Set(stagingCandidates);
  const queue: MesoRegionId[] = [targetId];
  const visited = new Set<MesoRegionId>([targetId]);
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    if (candidateSet.has(current)) {
      return current;
    }
    for (const neighborId of [...(neighborsById.get(current) ?? [])].sort(compareIds)) {
      if (!scope.has(neighborId) || visited.has(neighborId)) {
        continue;
      }
      visited.add(neighborId);
      queue.push(neighborId);
    }
  }
  return null;
}

function getBoundedGraphDistance(
  startId: MesoRegionId,
  targetId: MesoRegionId,
  maxDistance: number,
  scope: ReadonlySet<MesoRegionId> | undefined,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
): number | null {
  if (startId === targetId) {
    return 0;
  }
  const queue: Array<{ id: MesoRegionId; distance: number }> = [
    { id: startId, distance: 0 },
  ];
  const visited = new Set<MesoRegionId>([startId]);
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    if (current.distance >= maxDistance) {
      continue;
    }
    for (const neighborId of neighborsById.get(current.id) ?? []) {
      if (visited.has(neighborId) || (scope && !scope.has(neighborId))) {
        continue;
      }
      if (neighborId === targetId) {
        return current.distance + 1;
      }
      visited.add(neighborId);
      queue.push({ id: neighborId, distance: current.distance + 1 });
    }
  }
  return null;
}

function getNearbyEnemyStrength(
  world: WorldState,
  targetId: MesoRegionId,
  enemyNationId: NationId,
): number {
  const regionIds = new Set([
    targetId,
    ...(getNeighborsById(world).get(targetId) ?? []),
  ]);
  let strength = 0;
  for (const unit of world.units) {
    if (
      unit.domain === "land" &&
      unit.nationId === enemyNationId &&
      regionIds.has(unit.regionId)
    ) {
      strength += finiteUnitStrength(unit);
    }
  }
  return finiteNumber(strength);
}

function averageCenterDistance(
  units: UnitState[],
  targetId: MesoRegionId,
  world: WorldState,
): number {
  const mesoById = getMesoById(world);
  const targetCenter = mesoById.get(targetId)?.center;
  if (!targetCenter || units.length === 0) {
    return 0;
  }
  let total = 0;
  let count = 0;
  for (const unit of units) {
    const center = mesoById.get(unit.regionId)?.center;
    if (!center) {
      continue;
    }
    total += Math.sqrt(distanceSq(center, targetCenter));
    count += 1;
  }
  return count > 0 ? total / count : 0;
}

function isRegionControlledBy(
  world: WorldState,
  regionId: MesoRegionId,
  nationId: NationId,
): boolean {
  const owner = getOwnerByMesoId(world).get(regionId);
  const occupier = world.occupation.mesoById.get(regionId);
  return (occupier ?? owner) === nationId;
}

function frontSideStrength(front: OperationalSector, nationId: NationId): number {
  return finiteNumber(getFrontSide(front, nationId)?.strength ?? 0);
}

function getStrengthRatio(friendlyStrength: number, enemyStrength: number): number {
  const friendly = finiteNumber(friendlyStrength);
  const enemy = finiteNumber(enemyStrength);
  if (enemy <= 0) {
    return friendly > 0 ? 100 : 1;
  }
  return Math.min(100, friendly / enemy);
}

function isOperationalLandUnit(unit: UnitState | undefined): unit is UnitState {
  return (
    !!unit &&
    unit.domain === "land" &&
    Number.isFinite(unit.moveTicksPerRegion) &&
    unit.moveTicksPerRegion > 0 &&
    unit.org > 0 &&
    getUnitCombatStrength(unit) > 0
  );
}

function sumUnitStrength(units: UnitState[]): number {
  return finiteNumber(
    units.reduce((total, unit) => total + finiteUnitStrength(unit), 0),
  );
}

function finiteUnitStrength(unit: UnitState): number {
  return finiteNumber(getUnitCombatStrength(unit));
}

function finiteNumber(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function minimumSlack(
  assignments: readonly OperationManifestAssignment[],
): number | null {
  if (assignments.length === 0) return null;
  return assignments.reduce(
    (minimum, assignment) => Math.min(minimum, assignment.arrivalSlack),
    Number.POSITIVE_INFINITY,
  );
}

function recordArrivalSlack(world: WorldState, slack: number): void {
  const state = world.offensiveOperations;
  state.arrivalSlackTotal += slack;
  state.arrivalSlackCount += 1;
  state.minimumArrivalSlack = state.minimumArrivalSlack === null
    ? slack
    : Math.min(state.minimumArrivalSlack, slack);
  world.instrumentation?.incrementCounter(
    "offensiveOperation.arrivalSlackTicks",
    slack,
  );
}

function recordPreparationTimeout(
  world: WorldState,
  operation: OffensiveOperation,
): void {
  const requiredCompletion = operation.isMajorOffensive
    ? WORLD_BALANCE.war.landFront.stalemate.majorStagedFraction
    : WORLD_BALANCE.war.landFront.offensiveOperation.stagedFraction;
  const unitIds = new Set(world.units.map((unit) => unit.id));
  for (const group of operation.approachGroups) {
    const requiredReady = group.requiredStrength * requiredCompletion;
    const missing = Math.max(0, requiredReady - group.readyStrength);
    world.offensiveOperations.preparationTimeoutMissingStrength += missing;
    const travelling = operation.committedManifest
      .filter((assignment) =>
        assignment.approachRegionId === group.regionId &&
        assignment.arrivedAtTick === null &&
        unitIds.has(assignment.unitId)
      )
      .reduce((sum, assignment) => sum + assignment.strength, 0);
    world.offensiveOperations.preparationTimeoutTravellingStrength +=
      Math.min(missing, travelling);
  }
}

function createOperationId(index: number): OperationId {
  return `operation-${index}` as OperationId;
}

function createFrontNationKey(frontId: FrontId, nationId: NationId): string {
  return `${frontId}::${nationId}`;
}

function compareOperationCandidatePlans(
  a: NationFrontPlan,
  b: NationFrontPlan,
): number {
  return b.priority - a.priority || compareIds(a.frontId, b.frontId);
}

function isOperationPlanEligible(
  world: WorldState,
  nationId: NationId,
  plan: NationFrontPlan,
): boolean {
  if (plan.posture === "attack") return true;
  const closure = bestPocketClosure(world, nationId, plan.frontId);
  if (closure?.tacticallyFeasible &&
      closure.score >= WORLD_BALANCE.war.landFront.pocketClosure.dedicatedOperationThreshold) {
    return true;
  }
  if (!isSchwerpunktSector(world, nationId, plan.frontId)) return false;
  const pressure = world.stalematePressure.assessments.find((assessment) =>
    assessment.nationId === nationId &&
    assessment.schwerpunktSectorId === plan.frontId
  )?.pressure ?? 0;
  return pressure >=
    WORLD_BALANCE.war.landFront.stalemate.majorOffensiveThreshold;
}

function bestPocketClosure(
  world: WorldState,
  nationId: NationId,
  frontId: FrontId,
): PocketClosureOpportunity | undefined {
  return world.battlefieldTopology.assessments
    .filter((assessment) => assessment.attackerNationId === nationId)
    .flatMap((assessment) => assessment.pocketClosureOpportunities)
    .filter((opportunity) => opportunity.sectorId === frontId)
    .sort((a, b) => b.score - a.score || compareIds(a.candidateRegionId, b.candidateRegionId))[0];
}

function bestPocketClosureScore(world: WorldState, nationId: NationId, frontId: FrontId): number {
  const opportunity = bestPocketClosure(world, nationId, frontId);
  return opportunity?.tacticallyFeasible ? opportunity.score : 0;
}

function getPocketClosureForTarget(
  world: WorldState,
  attackerNationId: NationId,
  enemyNationId: NationId,
  sectorId: FrontId,
  regionId: MesoRegionId,
): PocketClosureOpportunity | undefined {
  return getBattlefieldTopologyAssessment(world, attackerNationId, enemyNationId)
    ?.pocketClosureOpportunities.find((opportunity) =>
      opportunity.sectorId === sectorId && opportunity.candidateRegionId === regionId
    );
}

function getBattlefieldTopologyTargetScore(
  world: WorldState,
  attackerNationId: NationId,
  enemyNationId: NationId,
  sectorId: FrontId,
  regionId: MesoRegionId,
): number {
  const assessment = getBattlefieldTopologyAssessment(world, attackerNationId, enemyNationId);
  const collapse = assessment?.collapseOpportunities.find((opportunity) =>
    opportunity.sectorId === sectorId && opportunity.targetRegionId === regionId
  );
  const articulation = assessment?.articulationRegions.find((item) => item.regionId === regionId);
  return (collapse?.score ?? 0) * 4 + Math.min(12, articulation?.affectedRegionCount ?? 0);
}

function clonePocketClosureOpportunity(opportunity: PocketClosureOpportunity): PocketClosureOpportunity {
  return {
    ...opportunity,
    affectedRegionIds: [...opportunity.affectedRegionIds],
    scoreComponents: { ...opportunity.scoreComponents },
  };
}

function isPocketClosureStillValid(world: WorldState, operation: OffensiveOperation): boolean {
  const objective = operation.pocketClosureObjective;
  if (!objective) return true;
  const assessment = getBattlefieldTopologyAssessment(
    world, operation.nationId, operation.enemyNationId,
  );
  return assessment?.pocketClosureOpportunities.some((opportunity) =>
    opportunity.candidateRegionId === objective.candidateRegionId &&
    opportunity.expectedExitsAfterCapture === 0 &&
    opportunity.affectedRegionIds.some((id) => objective.affectedRegionIds.includes(id))
  ) ?? false;
}

function confirmPocketClosure(world: WorldState, operation: OffensiveOperation): void {
  const objective = operation.pocketClosureObjective;
  if (!objective || operation.pocketClosureConfirmation) return;
  const assessment = getBattlefieldTopologyAssessment(
    world, operation.nationId, operation.enemyNationId,
  );
  const expected = new Set(objective.affectedRegionIds);
  const resulting = assessment?.enemyComponents
    .map((component) => ({
      component,
      overlap: component.regionIds.filter((regionId) => expected.has(regionId)).length,
    }))
    .filter((item) => item.overlap > 0 && !item.component.connectsToStrategicRear)
    .sort((a, b) => b.overlap - a.overlap || compareIds(a.component.id, b.component.id))[0];
  operation.pocketClosureConfirmation = resulting ? {
    status: "success",
    confirmedAtTick: world.time.fastTick,
    resultingPocketId: resulting.component.id,
    trappedStrength: resulting.component.enemyStrength,
    trappedRegionIds: [...resulting.component.regionIds],
    trappedCities: resulting.component.cities,
  } : {
    status: "failed",
    confirmedAtTick: world.time.fastTick,
    resultingPocketId: null,
    trappedStrength: 0,
    trappedRegionIds: [],
    trappedCities: 0,
  };
  if (resulting) world.offensiveOperations.pocketClosureSuccessCount += 1;
  else world.offensiveOperations.pocketClosureFailureCount += 1;
}

function compareOperations(
  a: OffensiveOperation,
  b: OffensiveOperation,
): number {
  return compareIds(a.nationId, b.nationId) || compareIds(a.id, b.id);
}

function areAssignmentMapsEqual(
  a: Map<UnitId, OperationId>,
  b: Map<UnitId, OperationId>,
): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const [unitId, operationId] of a.entries()) {
    if (b.get(unitId) !== operationId) {
      return false;
    }
  }
  return true;
}

function arraysEqual<T>(a: T[], b: T[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function distanceSq(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
