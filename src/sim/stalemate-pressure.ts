import { WORLD_BALANCE } from "../data/balance";
import type { NationId } from "../worldgen/nation";
import { getCapitalDefenseAssessment } from "./capital-defense";
import { getFrontlineCoverage } from "./frontline-coverage";
import {
  getFrontSide,
  getOpposingFrontSide,
  type FrontId,
  type OperationalSector,
} from "./land-fronts";
import { getFrontAllocation } from "./nation-front-allocations";
import { getSectorPlan } from "./nation-front-plans";
import { FAST_TICK_MS, SLOW_TICK_MS } from "./time";
import type { WorldState } from "./world-state";
import { getUnitCombatStrength } from "./unit-strength";
import { getStrategicProgressAssessment } from "./strategic-progress";
import { getMesoById, getOwnerByMesoId } from "./world-cache";

export type StalemateReason =
  | "no-strategic-progress"
  | "no-breakthrough-progress"
  | "repeated-operation-cancel"
  | "balanced-strength"
  | "continuous-coverage"
  | "artificial-inactivity";
export type ArtificialInactivityBlocker = "posture" | "allocation" | "target-validity" | null;
export type TargetValidityFailureReason = "no-enemy-influence-target" | "no-valid-frontline-position" | "target-outside-current-sector" | "target-already-occupied" | "ownership-mismatch" | "unreachable-target" | "geometry-invalidated" | "depth-radius-restriction" | "no-candidate-after-filtering" | "other";
export type InactivityCategory = "healthy-waiting" | "expected-waiting" | "natural-stalemate" | "artificial-inactivity" | "unknown";
export type InactivityReason =
  | "capital-emergency" | "retreat" | "preparing" | "attacking" | "exploiting" | "recovering"
  | "reorganization" | "reserve-deployment" | "collapse-advance" | "collapse-opportunity"
  | "natural-stalemate" | "operation-cooldown" | "operation-limit" | "no-offensive-surplus"
  | "temporary-posture" | "scheduled-operation" | "allocation-deadlock" | "no-valid-target"
  | "stale-geometry" | "inconsistent-ownership" | "unreachable" | "planner-failure" | "unknown";

export interface InactivityTransition {
  tick: number;
  nationId: NationId;
  enemyNationId: NationId;
  category: InactivityCategory;
  reason: InactivityReason;
}

export interface StalemateAssessment {
  nationId: NationId;
  enemyNationId: NationId;
  pressure: number;
  staticTicks: number;
  reasonFlags: StalemateReason[];
  artificialInactivity: boolean;
  artificialInactivityBlocker: ArtificialInactivityBlocker;
  /** Behavior-preserving internal trigger; intentionally independent of diagnostics. */
  collapseAdvanceCandidate: boolean;
  inactivityCategory: InactivityCategory;
  inactivityReason: InactivityReason;
  nextEvaluationTick: number;
  targetValidityFailureReason: TargetValidityFailureReason | null;
  targetValidityOtherReason: keyof StalematePressureState["targetValidityOtherCounts"] | null;
  schwerpunktSectorId: FrontId | null;
  selectedAtTick: number | null;
  cooldownUntilTick: number;
  lastOperationSuccessCount: number;
  lastOperationFailureCount: number;
  releasedSecondaryStrength: number;
}

export interface StalematePressureState {
  assessments: StalemateAssessment[];
  byNationEnemy: Map<string, StalemateAssessment>;
  schwerpunktByNationId: Map<NationId, StalemateAssessment>;
  version: number;
  allocationVersion: number;
  detections: number;
  selections: number;
  selectionChanges: number;
  artificialInactivitySamples: number;
  artificialInactivityByBlocker: Record<Exclude<ArtificialInactivityBlocker, null>, number>;
  targetValidityFailureCounts: Record<TargetValidityFailureReason, number>;
  targetValidityOtherCounts: { recoveryCooldown: number; validCandidatePending: number; unknown: number };
  inactivitySamplesByCategory: Record<InactivityCategory, number>;
  inactivitySamplesByReason: Record<InactivityReason, number>;
  inactivityTimeline: InactivityTransition[];
  pressureSampleTotal: number;
  pressureSampleCount: number;
  maxPressure: number;
  staticTickSampleTotal: number;
  staticTickSampleCount: number;
  maxStaticTicks: number;
  majorOffensivesLaunched: number;
  majorOffensiveSuccesses: number;
  majorOffensiveFailures: number;
  activeFocusSamples: number;
  concentrationRatioTotal: number;
  allocatedOffensiveStrengthTotal: number;
  reserveContributionTotal: number;
}

export function createStalematePressureState(): StalematePressureState {
  return {
    assessments: [], byNationEnemy: new Map(), schwerpunktByNationId: new Map(),
    version: 0, allocationVersion: 0, detections: 0, selections: 0, selectionChanges: 0,
    artificialInactivitySamples: 0,
    artificialInactivityByBlocker: { posture: 0, allocation: 0, "target-validity": 0 },
    targetValidityFailureCounts: { "no-enemy-influence-target": 0, "no-valid-frontline-position": 0, "target-outside-current-sector": 0, "target-already-occupied": 0, "ownership-mismatch": 0, "unreachable-target": 0, "geometry-invalidated": 0, "depth-radius-restriction": 0, "no-candidate-after-filtering": 0, other: 0 },
    targetValidityOtherCounts: { recoveryCooldown: 0, validCandidatePending: 0, unknown: 0 },
    inactivitySamplesByCategory: { "healthy-waiting": 0, "expected-waiting": 0, "natural-stalemate": 0, "artificial-inactivity": 0, unknown: 0 },
    inactivitySamplesByReason: createInactivityReasonCounts(),
    inactivityTimeline: [],
    pressureSampleTotal: 0, pressureSampleCount: 0,
    maxPressure: 0, staticTickSampleTotal: 0, staticTickSampleCount: 0, maxStaticTicks: 0,
    majorOffensivesLaunched: 0, majorOffensiveSuccesses: 0,
    majorOffensiveFailures: 0,
    activeFocusSamples: 0, concentrationRatioTotal: 0,
    allocatedOffensiveStrengthTotal: 0, reserveContributionTotal: 0,
  };
}

export function getStalemateAssessment(
  world: WorldState, nationId: NationId, enemyNationId: NationId,
): StalemateAssessment | undefined {
  return world.stalematePressure.byNationEnemy.get(key(nationId, enemyNationId));
}

export function getNationSchwerpunkt(
  world: WorldState, nationId: NationId,
): StalemateAssessment | undefined {
  return world.stalematePressure.schwerpunktByNationId.get(nationId);
}

export function getSchwerpunktForEnemy(
  world: WorldState,
  nationId: NationId,
  enemyNationId: NationId,
): StalemateAssessment | undefined {
  const assessment = getStalemateAssessment(world, nationId, enemyNationId);
  return assessment?.schwerpunktSectorId ? assessment : undefined;
}

export function isSchwerpunktSector(
  world: WorldState, nationId: NationId, sectorId: FrontId,
): boolean {
  return world.stalematePressure.assessments.some(
    (assessment) => assessment.nationId === nationId &&
      assessment.schwerpunktSectorId === sectorId,
  );
}

export function updateStalematePressure(world: WorldState): void {
  const state = world.stalematePressure;
  const startedAt = world.instrumentation ? performance.now() : 0;
  const previousFocus = state.assessments
    .filter((item) => item.schwerpunktSectorId)
    .map((item) => `${item.nationId}:${item.enemyNationId}:${item.schwerpunktSectorId}`)
    .sort().join("|");
  const settings = WORLD_BALANCE.war.landFront.stalemate;
  const previous = state.byNationEnemy;
  const operationProgress = indexOperationProgress(world);
  const sectorsByPair = new Map<string, OperationalSector[]>();
  for (const sector of world.landFronts.operationalSectors) {
    for (const [nationId, enemyId] of [[sector.nationAId, sector.nationBId], [sector.nationBId, sector.nationAId]] as const) {
      const list = sectorsByPair.get(key(nationId, enemyId));
      if (list) list.push(sector); else sectorsByPair.set(key(nationId, enemyId), [sector]);
    }
  }
  const next: StalemateAssessment[] = [];
  for (const pairKey of [...sectorsByPair.keys()].sort()) {
    const sectors = sectorsByPair.get(pairKey)!;
    const first = sectors[0];
    const nationId = pairKey.slice(0, pairKey.indexOf("|")) as NationId;
    const enemyNationId = (first.nationAId === nationId ? first.nationBId : first.nationAId);
    const before = previous.get(pairKey);
    const friendlyStrength = sumSides(sectors, nationId, true);
    const enemyStrength = sumSides(sectors, nationId, false);
    const ratio = friendlyStrength / Math.max(1, enemyStrength);
    const bothCapable = friendlyStrength >= settings.minimumMeaningfulStrength && enemyStrength >= settings.minimumMeaningfulStrength;
    const balanced = ratio >= settings.balancedMinimumRatio && ratio <= settings.balancedMaximumRatio;
    const progress = operationProgress.get(pairKey) ?? { success: 0, failure: 0 };
    const success = progress.success;
    const failure = progress.failure;
    const strategicProgress = getStrategicProgressAssessment(
      world,
      nationId,
      enemyNationId,
    );
    const meaningfulProgress = strategicProgress?.resetsPressure ?? false;
    const critical = getCapitalDefenseAssessment(world, nationId)?.threatLevel === "critical";
    const retreating = sectors.some((sector) => getSectorPlan(world, sector.id, nationId)?.posture === "retreat");
    const continuous = sectors.every((sector) => {
      const ours = getFrontlineCoverage(world, sector.id, nationId);
      const theirs = getFrontlineCoverage(world, sector.id, enemyNationId);
      return !!ours && !!theirs && ours.gapSegments === 0 && theirs.gapSegments === 0;
    });
    const pairOperations = world.offensiveOperations.operationsByNationId.get(nationId)?.filter((op) => op.enemyNationId === enemyNationId) ?? [];
    const noOperation = !pairOperations.some((op) => op.phase !== "recovering") &&
      world.collapseAdvances.advanceByNationId.get(nationId)?.enemyNationId !== enemyNationId;
    const surplus = sectors.reduce((sum, sector) => sum + (getFrontAllocation(world, sector.id, nationId)?.surplus ?? 0), 0);
    const enemyLineStrength = sectors.reduce((sum, sector) => sum + (getFrontlineCoverage(world, sector.id, enemyNationId)?.defenderStrength ?? 0), 0);
    const hasAllocatedForce = sectors.some((sector) => (getFrontAllocation(world, sector.id, nationId)?.unitIds.length ?? 0) > 0);
    const attackOpportunity = noOperation && hasAllocatedForce && friendlyStrength >= settings.minimumMeaningfulStrength &&
      (enemyStrength < settings.minimumMeaningfulStrength * 0.25 || enemyLineStrength <= 0 || surplus > enemyStrength * 0.75);
    let pressure = before?.pressure ?? 0;
    let staticTicks = before?.staticTicks ?? 0;
    if (meaningfulProgress) {
      pressure = Math.max(0, pressure - settings.pressureDecayOnProgress);
      staticTicks = 0;
    } else if (bothCapable && balanced && !critical && !retreating) {
      pressure = Math.min(settings.maximumPressure, pressure + settings.pressureGainPerSlowTick);
      staticTicks += 1;
    } else {
      pressure = Math.max(0, pressure - settings.pressureGainPerSlowTick);
      staticTicks = 0;
    }
    const reasons: StalemateReason[] = [];
    if (!meaningfulProgress) reasons.push("no-strategic-progress");
    if (before?.lastOperationSuccessCount === success) reasons.push("no-breakthrough-progress");
    if (balanced) reasons.push("balanced-strength");
    if (continuous) reasons.push("continuous-coverage");
    if (before && failure > before.lastOperationFailureCount) reasons.push("repeated-operation-cancel");
    const targetDiagnostic = attackOpportunity
      ? classifyTargetValidityFailure(world, sectors, nationId, enemyNationId)
      : null;
    const inactivity = classifyInactivity({
      world, sectors, nationId, enemyNationId, pairOperations, critical, retreating,
      bothCapable, balanced, continuous, staticTicks, progressCount: success + failure,
      attackOpportunity, hasAllocatedForce, surplus, targetDiagnostic,
      cooldownUntilTick: before?.cooldownUntilTick ?? 0,
    });
    const artificial = inactivity.category === "artificial-inactivity";
    const artificialBlocker: ArtificialInactivityBlocker = !artificial ? null
      : inactivity.reason === "allocation-deadlock" ? "allocation" : "target-validity";
    if (artificial) reasons.push("artificial-inactivity");
    let schwerpunktSectorId = before?.schwerpunktSectorId ?? null;
    let selectedAtTick = before?.selectedAtTick ?? null;
    const cooldownUntilTick = before?.cooldownUntilTick ?? 0;
    const selectedStillExists = !!schwerpunktSectorId && sectors.some((sector) => sector.id === schwerpunktSectorId);
    if (critical || retreating) {
      schwerpunktSectorId = null; selectedAtTick = null;
    } else if (selectedStillExists) {
      const bestSectorId = selectSector(world, sectors, nationId);
      const selectedSector = sectors.find((sector) => sector.id === schwerpunktSectorId)!;
      const bestSector = sectors.find((sector) => sector.id === bestSectorId)!;
      const selectionAge = world.time.fastTick - (selectedAtTick ?? world.time.fastTick);
      if (
        bestSectorId !== schwerpunktSectorId &&
        selectionAge >= settings.minimumSelectionTicks &&
        scoreSector(world, bestSector, nationId) >=
          scoreSector(world, selectedSector, nationId) + settings.reselectionScoreMargin
      ) {
        schwerpunktSectorId = bestSectorId;
        selectedAtTick = world.time.fastTick;
        state.selectionChanges += 1;
      }
    } else if (
      pressure >= settings.selectionThreshold &&
      world.time.fastTick >= cooldownUntilTick
    ) {
      schwerpunktSectorId = selectSector(world, sectors, nationId);
      selectedAtTick = world.time.fastTick;
      state.selections += 1;
      if (before?.schwerpunktSectorId) state.selectionChanges += 1;
    }
    const assessment: StalemateAssessment = {
      nationId, enemyNationId, pressure, staticTicks, reasonFlags: reasons,
      artificialInactivity: artificial, artificialInactivityBlocker: artificialBlocker,
      collapseAdvanceCandidate: attackOpportunity && sectors.some((sector) => getSectorPlan(world, sector.id, nationId)?.posture === "attack"),
      inactivityCategory: inactivity.category, inactivityReason: inactivity.reason,
      nextEvaluationTick: inactivity.nextEvaluationTick,
      targetValidityFailureReason: targetDiagnostic?.reason ?? null,
      targetValidityOtherReason: targetDiagnostic?.other ?? null,
      schwerpunktSectorId, selectedAtTick,
      cooldownUntilTick, lastOperationSuccessCount: success,
      lastOperationFailureCount: failure, releasedSecondaryStrength: before?.releasedSecondaryStrength ?? 0,
    };
    if (schwerpunktSectorId) {
      assessment.releasedSecondaryStrength = sectors
        .filter((sector) => sector.id !== schwerpunktSectorId)
        .reduce((sum, sector) => sum + (getSectorPlan(world, sector.id, nationId)?.desiredStrength ?? 0) * (1 - settings.secondaryDesiredStrengthRatio), 0);
    }
    if (pressure >= settings.selectionThreshold && (before?.pressure ?? 0) < settings.selectionThreshold) state.detections += 1;
    state.inactivitySamplesByCategory[inactivity.category] += 1;
    state.inactivitySamplesByReason[inactivity.reason] += 1;
    if (!before || before.inactivityCategory !== inactivity.category || before.inactivityReason !== inactivity.reason) {
      state.inactivityTimeline.push({ tick: world.time.fastTick, nationId, enemyNationId, category: inactivity.category, reason: inactivity.reason });
    }
    if (artificial) {
      state.artificialInactivitySamples += 1;
      if (artificialBlocker) state.artificialInactivityByBlocker[artificialBlocker] += 1;
      if (artificialBlocker === "target-validity") {
        const diagnostic = targetDiagnostic ?? { reason: "other" as const, other: "unknown" as const };
        state.targetValidityFailureCounts[diagnostic.reason] += 1;
        if (diagnostic.other) state.targetValidityOtherCounts[diagnostic.other] += 1;
      }
    }
    state.pressureSampleTotal += pressure; state.pressureSampleCount += 1;
    state.maxPressure = Math.max(state.maxPressure, pressure);
    state.staticTickSampleTotal += staticTicks; state.staticTickSampleCount += 1;
    state.maxStaticTicks = Math.max(state.maxStaticTicks, staticTicks);
    next.push(assessment);
  }
  const nextByKey = new Map(next.map((item) => [key(item.nationId, item.enemyNationId), item]));
  const schwerpunktByNationId = new Map<NationId, StalemateAssessment>();
  for (const item of next.sort(compareAssessment)) {
    if (item.schwerpunktSectorId && !schwerpunktByNationId.has(item.nationId)) schwerpunktByNationId.set(item.nationId, item);
  }
  state.assessments = next; state.byNationEnemy = nextByKey;
  state.schwerpunktByNationId = schwerpunktByNationId; state.version += 1;
  if (state.inactivityTimeline.length > 512) state.inactivityTimeline.splice(0, state.inactivityTimeline.length - 512);
  sampleSchwerpunktConcentration(world, next);
  const nextFocus = next
    .filter((item) => item.schwerpunktSectorId)
    .map((item) => `${item.nationId}:${item.enemyNationId}:${item.schwerpunktSectorId}`)
    .sort().join("|");
  if (previousFocus !== nextFocus) state.allocationVersion += 1;
  world.instrumentation?.recordDuration("stalemate.evaluation", performance.now() - startedAt);
}

function sampleSchwerpunktConcentration(
  world: WorldState,
  assessments: readonly StalemateAssessment[],
): void {
  const unitById = new Map(world.units.map((unit) => [unit.id, unit]));
  for (const assessment of assessments) {
    const sectorId = assessment.schwerpunktSectorId;
    if (!sectorId) continue;
    const allocation = getFrontAllocation(world, sectorId, assessment.nationId);
    const coverage = getFrontlineCoverage(world, sectorId, assessment.nationId);
    const pairStrength = world.frontAllocations.allocations
      .filter((candidate) => {
        if (candidate.nationId !== assessment.nationId) return false;
        const sector = world.landFronts.operationalSectorsById.get(candidate.frontId);
        return !!sector && getOpposingFrontSide(sector, assessment.nationId)?.nationId === assessment.enemyNationId;
      })
      .reduce((sum, candidate) => sum + candidate.allocatedStrength, 0);
    const reserve = world.strategicReserves.reservesByNationId.get(assessment.nationId);
    const reserveContribution = reserve?.deployment?.targetFrontId === sectorId &&
      reserve.deployment.status !== "returning"
      ? reserve.deployment.unitIds.reduce((sum, unitId) =>
        sum + (unitById.get(unitId) ? getUnitCombatStrength(unitById.get(unitId)!) : 0), 0)
      : 0;
    const allocated = allocation?.allocatedStrength ?? 0;
    const offensive = Math.max(0, allocated - (coverage?.minimumRequiredStrength ?? 0));
    const concentration = (allocated + reserveContribution) / Math.max(1, pairStrength + reserveContribution);
    world.stalematePressure.activeFocusSamples += 1;
    world.stalematePressure.concentrationRatioTotal += concentration;
    world.stalematePressure.allocatedOffensiveStrengthTotal += offensive;
    world.stalematePressure.reserveContributionTotal += reserveContribution;
    world.instrumentation?.incrementCounter("stalemate.focusSamples");
    world.instrumentation?.incrementCounter("stalemate.concentrationRatio", concentration);
    world.instrumentation?.incrementCounter("stalemate.allocatedOffensiveStrength", offensive);
    world.instrumentation?.incrementCounter("stalemate.reserveContribution", reserveContribution);
  }
}

/** Re-labels a same-tick Collapse Advance detection without affecting its trigger. */
export function recordCollapseOpportunityDiagnostic(world: WorldState, nationId: NationId, enemyNationId: NationId): void {
  const state = world.stalematePressure;
  const assessment = getStalemateAssessment(world, nationId, enemyNationId) ??
    state.assessments.find((item) => item.nationId === nationId && item.enemyNationId === enemyNationId);
  if (!assessment || assessment.inactivityCategory !== "artificial-inactivity") return;
  state.inactivitySamplesByCategory["artificial-inactivity"] = Math.max(0, state.inactivitySamplesByCategory["artificial-inactivity"] - 1);
  state.inactivitySamplesByCategory["healthy-waiting"] += 1;
  state.inactivitySamplesByReason[assessment.inactivityReason] = Math.max(0, state.inactivitySamplesByReason[assessment.inactivityReason] - 1);
  state.inactivitySamplesByReason["collapse-opportunity"] += 1;
  state.artificialInactivitySamples = Math.max(0, state.artificialInactivitySamples - 1);
  if (assessment.artificialInactivityBlocker) state.artificialInactivityByBlocker[assessment.artificialInactivityBlocker] = Math.max(0, state.artificialInactivityByBlocker[assessment.artificialInactivityBlocker] - 1);
  if (assessment.artificialInactivityBlocker === "target-validity" && assessment.targetValidityFailureReason) {
    state.targetValidityFailureCounts[assessment.targetValidityFailureReason] = Math.max(0, state.targetValidityFailureCounts[assessment.targetValidityFailureReason] - 1);
    if (assessment.targetValidityOtherReason) state.targetValidityOtherCounts[assessment.targetValidityOtherReason] = Math.max(0, state.targetValidityOtherCounts[assessment.targetValidityOtherReason] - 1);
  }
  assessment.inactivityCategory = "healthy-waiting";
  assessment.inactivityReason = "collapse-opportunity";
  assessment.artificialInactivity = false;
  assessment.artificialInactivityBlocker = null;
  assessment.reasonFlags = assessment.reasonFlags.filter((reason) => reason !== "artificial-inactivity");
  state.inactivityTimeline.push({ tick: world.time.fastTick, nationId, enemyNationId, category: "healthy-waiting", reason: "collapse-opportunity" });
  if (state.inactivityTimeline.length > 512) state.inactivityTimeline.splice(0, state.inactivityTimeline.length - 512);
}

interface InactivityClassificationInput {
  world: WorldState;
  sectors: OperationalSector[];
  nationId: NationId;
  enemyNationId: NationId;
  pairOperations: WorldState["offensiveOperations"]["operations"];
  critical: boolean;
  retreating: boolean;
  bothCapable: boolean;
  balanced: boolean;
  continuous: boolean;
  staticTicks: number;
  progressCount: number;
  attackOpportunity: boolean;
  hasAllocatedForce: boolean;
  surplus: number;
  targetDiagnostic: ReturnType<typeof classifyTargetValidityFailure> | null;
  cooldownUntilTick: number;
}

function classifyInactivity(input: InactivityClassificationInput): { category: InactivityCategory; reason: InactivityReason; nextEvaluationTick: number } {
  const { world, nationId, enemyNationId } = input;
  const remainingSlowMs = SLOW_TICK_MS - (world.time.elapsedMs % SLOW_TICK_MS);
  const nextSlowTick = world.time.fastTick + Math.max(1, Math.ceil(remainingSlowMs / FAST_TICK_MS));
  const result = (category: InactivityCategory, reason: InactivityReason, nextEvaluationTick = nextSlowTick) => ({ category, reason, nextEvaluationTick });
  if (input.critical) return result("healthy-waiting", "capital-emergency");
  if (input.retreating || world.retreatPlans.plansByNationId.get(nationId)?.some((plan) => input.sectors.some((sector) => sector.id === plan.frontId))) return result("healthy-waiting", "retreat");
  const operation = input.pairOperations.sort((a, b) => a.id.localeCompare(b.id))[0];
  if (operation) {
    if (operation.phase === "recovering") return result("healthy-waiting", "recovering", operation.expiresAtTick);
    return result("healthy-waiting", operation.phase);
  }
  if (input.bothCapable && input.balanced && input.continuous && input.staticTicks > 0 && input.progressCount > 0) return result("natural-stalemate", "natural-stalemate");
  if (world.time.fastTick < input.cooldownUntilTick) return result("expected-waiting", "operation-cooldown", input.cooldownUntilTick);
  const collapse = world.collapseAdvances.advanceByNationId.get(nationId);
  if (collapse?.enemyNationId === enemyNationId) return result("healthy-waiting", "collapse-advance");
  const otherOperations = world.offensiveOperations.operationsByNationId.get(nationId) ?? [];
  if (otherOperations.length >= WORLD_BALANCE.war.landFront.offensiveOperation.maxActivePerNation) return result("expected-waiting", "operation-limit");
  if ((world.reorganization.plansByNationId.get(nationId)?.length ?? 0) > 0) return result("healthy-waiting", "reorganization");
  if (world.strategicReserves.reservesByNationId.get(nationId)?.deployment) return result("healthy-waiting", "reserve-deployment");
  const diagnostic = input.targetDiagnostic;
  if (diagnostic?.other === "validCandidatePending") return result("expected-waiting", "scheduled-operation");
  if (!input.hasAllocatedForce || input.surplus <= 0) return result("expected-waiting", "no-offensive-surplus");
  if (!input.attackOpportunity) return result("expected-waiting", "temporary-posture");
  if (diagnostic?.reason === "no-candidate-after-filtering") return result("artificial-inactivity", "allocation-deadlock");
  if (diagnostic?.reason === "geometry-invalidated") return result("artificial-inactivity", "stale-geometry");
  if (diagnostic?.reason === "ownership-mismatch" || diagnostic?.reason === "target-already-occupied") return result("artificial-inactivity", "inconsistent-ownership");
  if (diagnostic?.reason === "unreachable-target") return result("artificial-inactivity", "unreachable");
  if (diagnostic && diagnostic.reason !== "other") return result("artificial-inactivity", "no-valid-target");
  return result("unknown", "unknown");
}

function createInactivityReasonCounts(): Record<InactivityReason, number> {
  return Object.fromEntries([
    "capital-emergency", "retreat", "preparing", "attacking", "exploiting", "recovering",
    "reorganization", "reserve-deployment", "collapse-advance", "collapse-opportunity",
    "natural-stalemate", "operation-cooldown", "operation-limit", "no-offensive-surplus",
    "temporary-posture", "scheduled-operation", "allocation-deadlock", "no-valid-target",
    "stale-geometry", "inconsistent-ownership", "unreachable", "planner-failure", "unknown",
  ].map((reason) => [reason, 0])) as Record<InactivityReason, number>;
}

function classifyTargetValidityFailure(world: WorldState, sectors: OperationalSector[], nationId: NationId, enemyNationId: NationId): { reason: TargetValidityFailureReason; other?: keyof StalematePressureState["targetValidityOtherCounts"] } {
  if (world.offensiveOperations.operationsByNationId.get(nationId)?.some((operation) => operation.enemyNationId === enemyNationId && operation.phase === "recovering")) return { reason: "other", other: "recoveryCooldown" };
  const attackSectors = sectors.filter((sector) => getSectorPlan(world, sector.id, nationId)?.posture === "attack");
  if (attackSectors.length === 0) return { reason: "other", other: "unknown" };
  const mesoById = getMesoById(world);
  let sawEnemyInfluence = false;
  let sawEnemyControlled = false;
  let sawLand = false;
  let sawCoveragePosition = false;
  let sawInsufficientForce = false;
  for (const sector of attackSectors) {
    const friendly = getFrontSide(sector, nationId);
    const enemy = getOpposingFrontSide(sector, nationId);
    if (!friendly || !enemy) return { reason: "geometry-invalidated" };
    const allocation = getFrontAllocation(world, sector.id, nationId);
    if (!allocation || allocation.unitIds.length < WORLD_BALANCE.war.landFront.offensiveOperation.minimumFrontUnits) sawInsufficientForce = true;
    if (enemy.influenceRegionIds.length > 0) sawEnemyInfluence = true;
    const coverage = getFrontlineCoverage(world, sector.id, enemyNationId);
    if ((coverage?.positions.length ?? 0) > 0) sawCoveragePosition = true;
    for (const id of enemy.influenceRegionIds) {
      const meso = mesoById.get(id);
      if (meso?.type !== "sea") sawLand = true;
      if ((world.occupation.mesoById.get(id) ?? getOwnerByMesoId(world).get(id)) === enemyNationId) sawEnemyControlled = true;
    }
  }
  if (sawInsufficientForce) return { reason: "no-candidate-after-filtering" };
  if (!sawEnemyInfluence || !sawLand) return { reason: "no-enemy-influence-target" };
  if (!sawEnemyControlled) {
    const occupiedByUs = attackSectors.some((sector) => getOpposingFrontSide(sector, nationId)?.influenceRegionIds.some((id) => world.occupation.mesoById.get(id) === nationId));
    return { reason: occupiedByUs ? "target-already-occupied" : "ownership-mismatch" };
  }
  if (!sawCoveragePosition) return { reason: "no-valid-frontline-position" };
  return { reason: "other", other: "validCandidatePending" };
}

export function recordMajorOffensiveOutcome(
  world: WorldState,
  nationId: NationId,
  enemyId: NationId,
  success: boolean,
  countAsMajor = true,
): void {
  const assessment = getStalemateAssessment(world, nationId, enemyId);
  if (!assessment) return;
  const settings = WORLD_BALANCE.war.landFront.stalemate;
  assessment.pressure = Math.max(0, assessment.pressure - settings.pressureDecayOnFailure);
  assessment.cooldownUntilTick = world.time.fastTick + settings.failedOffensiveCooldownTicks;
  assessment.schwerpunktSectorId = null; assessment.selectedAtTick = null;
  if (countAsMajor) {
    if (success) world.stalematePressure.majorOffensiveSuccesses += 1;
    else world.stalematePressure.majorOffensiveFailures += 1;
  }
}

function selectSector(world: WorldState, sectors: OperationalSector[], nationId: NationId): FrontId {
  return [...sectors].sort((a, b) => scoreSector(world, b, nationId) - scoreSector(world, a, nationId) || a.id.localeCompare(b.id))[0].id;
}
function scoreSector(world: WorldState, sector: OperationalSector, nationId: NationId): number {
  const plan = getSectorPlan(world, sector.id, nationId);
  const friendly = getFrontSide(sector, nationId); const enemy = getOpposingFrontSide(sector, nationId);
  const enemyCoverage = enemy ? getFrontlineCoverage(world, sector.id, enemy.nationId) : undefined;
  const ratio = (friendly?.strength ?? 0) / Math.max(1, enemy?.strength ?? 0);
  return (plan?.priority ?? 0) + ratio * 20 + (enemyCoverage?.gapSegments ?? 0) * 25 + (enemyCoverage?.weakSegments ?? 0) * 10;
}
function sumSides(sectors: OperationalSector[], nationId: NationId, friendly: boolean): number {
  return sectors.reduce((sum, sector) => sum + ((friendly ? getFrontSide(sector, nationId) : getOpposingFrontSide(sector, nationId))?.strength ?? 0), 0);
}
function compareAssessment(a: StalemateAssessment, b: StalemateAssessment): number { return a.nationId.localeCompare(b.nationId) || b.pressure - a.pressure || a.enemyNationId.localeCompare(b.enemyNationId); }
function key(a: NationId, b: NationId): string { return `${a}|${b}`; }

function indexOperationProgress(world: WorldState): Map<string, { success: number; failure: number }> {
  const result = new Map<string, { success: number; failure: number }>();
  for (const operation of [...world.offensiveOperations.history, ...world.offensiveOperations.operations]) {
    if (!operation.outcome) continue;
    const item = result.get(key(operation.nationId, operation.enemyNationId)) ?? { success: 0, failure: 0 };
    if (operation.outcome === "success") item.success += 1; else item.failure += 1;
    result.set(key(operation.nationId, operation.enemyNationId), item);
  }
  return result;
}
