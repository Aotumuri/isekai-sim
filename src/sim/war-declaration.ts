import { WORLD_BALANCE } from "../data/balance";
import type { NationId } from "../worldgen/nation";
import { isNationActive } from "./nation-active";
import { nextScheduledTickRange } from "./schedule";
import type { StrategicNationObservation } from "./strategic-threat-observation";
import type {
  WarIntentAssessment, WarIntentReason, WarIntentRejectionReason,
} from "./war-intent";
import { buildWarAdjacency, declareWar, isAtWar } from "./war-state";
import type { WorldState } from "./world-state";
import { getMesoById, getPortTargetsByNation } from "./world-cache";
import { areCoalitionMembers } from "./common-threat-coalitions";

const EPSILON = 0.000_001;

export interface WarIntentCandidate {
  aggressorId: NationId;
  targetNationId: NationId;
  route: "land" | "maritime";
}

export function updateWarDeclarations(world: WorldState): void {
  const settings = WORLD_BALANCE.war.declare;
  const range = settings.slowTickRange;
  if (range.min <= 0 || range.max <= 0) return;
  const ready = new Set<NationId>();
  for (const nation of world.nations) {
    if (isNationActive(nation) && world.time.slowTick >= nation.nextWarDeclarationTick) {
      ready.add(nation.id);
    }
  }
  if (ready.size === 0) return;
  scheduleNextWarDeclarations(world, ready, range);

  // The first slow tick has no completed strategic snapshot yet.
  if (world.strategicThreatObservation.version === 0) {
    publishAssessments(world, []);
    return;
  }
  const startedAt = world.instrumentation ? performance.now() : 0;
  const candidates = generateWarDeclarationCandidates(world, ready);
  const assessments = candidates.map((candidate) => assessWarIntent(world, candidate));
  assessments.sort(compareAssessments);
  recordRankingChanges(world, assessments);

  const warAdjacency = buildWarAdjacency(world.wars);
  const maxWars = Math.max(0, Math.round(settings.maxWarsPerTick));
  let declarationsThisTick = 0;
  for (const intent of assessments) {
    if (!intent.aboveThreshold || declarationsThisTick >= maxWars) continue;
    if (isAtWar(intent.aggressorId, intent.targetNationId, warAdjacency)) continue;
    // One deliberate declaration per ready nation per evaluation avoids a
    // same-tick multi-war burst while retaining continuous commitment costs.
    if (assessments.some((other) => other.declared && other.aggressorId === intent.aggressorId)) {
      continue;
    }
    const aggressorWars = countWars(world, intent.aggressorId);
    const targetWars = countWars(world, intent.targetNationId);
    const war = declareWar(world.wars, intent.aggressorId, intent.targetNationId,
      world.time.fastTick);
    if (!war) continue;
    intent.declared = true;
    declarationsThisTick += 1;
    let enemies = warAdjacency.get(intent.aggressorId);
    if (!enemies) { enemies = new Set(); warAdjacency.set(intent.aggressorId, enemies); }
    enemies.add(intent.targetNationId);
    let reverse = warAdjacency.get(intent.targetNationId);
    if (!reverse) { reverse = new Set(); warAdjacency.set(intent.targetNationId, reverse); }
    reverse.add(intent.aggressorId);
    recordDeclaration(world, intent, aggressorWars, targetWars);
    console.info(`[War] ${war.nationAId} vs ${war.nationBId} (${intent.dominantReason}, ${intent.score.toFixed(1)}) @${world.time.fastTick}`);
  }
  publishAssessments(world, assessments);
  if (world.instrumentation) {
    const elapsed = performance.now() - startedAt;
    world.warIntent.evaluationCpuMs += elapsed;
    world.instrumentation.recordDuration("warIntent.evaluation", elapsed);
  }
}

export function generateWarDeclarationCandidates(
  world: WorldState,
  ready: ReadonlySet<NationId>,
): WarIntentCandidate[] {
  const result: WarIntentCandidate[] = [];
  const wars = buildWarAdjacency(world.wars);
  for (const exposure of world.strategicThreatObservation.exposures) {
    if (!ready.has(exposure.observerNationId) ||
      isAtWar(exposure.observerNationId, exposure.threatNationId, wars)) continue;
    const route = exposure.landAdjacent ? "land" : "maritime";
    if (route === "maritime" && !exposure.sharedSeaComponent) continue;
    result.push({ aggressorId: exposure.observerNationId,
      targetNationId: exposure.threatNationId, route });
  }
  return result.sort((a, b) => compareIds(a.aggressorId, b.aggressorId) ||
    compareIds(a.targetNationId, b.targetNationId));
}

export function assessWarIntent(world: WorldState, candidate: WarIntentCandidate): WarIntentAssessment {
  const settings = WORLD_BALANCE.war.declare;
  const attacker = observation(world, candidate.aggressorId);
  const target = observation(world, candidate.targetNationId);
  if (!attacker || !target) return rejectedMissingAssessment(world, candidate);
  const attackerLand = attacker.power.landStrength;
  const targetLand = target.power.landStrength;
  const strengthRatio = attackerLand / Math.max(1, targetLand);
  const opportunity = clamp((strengthRatio - 0.65) * 32 +
    target.vulnerability.score * 0.22 + target.existingWars * 7 -
    Math.max(0, target.momentum.score) * 0.08, 0, 50);
  let threatResponse = clamp(target.threatScore * 0.22 +
    Math.max(0, target.momentum.score) * 0.1 + target.intent.score * 0.06, 0, 32);
  const coalition = world.commonThreatCoalitions.coalitionByMemberNationId
    .get(candidate.aggressorId);
  const targetsCommonThreat = coalition?.targetNationId === candidate.targetNationId;
  if (targetsCommonThreat) threatResponse = clamp(threatResponse + 10, 0, 42);
  const ports = getPortTargetsByNation(world).get(candidate.targetNationId)?.length ?? 0;
  const capitalValue = world.nations.find((nation) =>
    nation.id === candidate.targetNationId)?.capitalMesoId ? 7 : 0;
  const strategicValue = clamp(target.cityCount * 3 + ports * 2 + capitalValue +
    Math.min(8, target.territoryCount * 0.3), 0, 28);

  let expectedCost = clamp(Math.max(0, 1.15 - strengthRatio) * 38 +
    Math.max(0, target.power.score - attacker.power.score) * 0.16, 0, 48);
  const rejection = new Set<WarIntentRejectionReason>();
  if (attackerLand < settings.minimumLandStrength || strengthRatio < 0.55) {
    rejection.add("insufficient-strength");
  }
  if (candidate.route === "maritime") {
    const transportDeficit = Math.max(0,
      settings.maritimeMinimumTransports - attacker.power.transports);
    const combatShipDeficit = Math.max(0,
      settings.maritimeMinimumCombatShips - attacker.power.combatShips);
    expectedCost += 10 + transportDeficit * 5 + combatShipDeficit * 5 +
      maritimeDistanceCost(world, candidate.aggressorId, candidate.targetNationId) +
      Math.max(0, target.power.navalCombatStrength - attacker.power.navalCombatStrength) /
        Math.max(1, target.power.navalCombatStrength) * 12;
    if (attackerLand < settings.maritimeMinimumLandStrength ||
      attacker.power.productionCapability <= 0) rejection.add("maritime-infeasible");
  }
  expectedCost = clamp(expectedCost, 0, 72);

  const activeWars = attacker.existingWars;
  const activeOperations = world.offensiveOperations.operationsByNationId
    .get(candidate.aggressorId)?.length ?? 0;
  const navalMissions = world.supplyAssessment.navalStrategy.missions.filter((mission) =>
    mission.nationId === candidate.aggressorId).length;
  const coverage = world.frontlineCoverage.coverages.filter((item) =>
    item.nationId === candidate.aggressorId);
  const frontDeficitRatio = coverage.length === 0 ? 0 : coverage.reduce((sum, item) =>
    sum + item.weakSegments + item.gapSegments, 0) /
      Math.max(1, coverage.reduce((sum, item) => sum + item.positions.length, 0));
  const reserve = world.strategicReserves.reservesByNationId.get(candidate.aggressorId);
  const reservePressure = reserve?.desiredReserveStrength
    ? clamp(1 - reserve.totalStrength / reserve.desiredReserveStrength, 0, 1) : 0;
  const capitalEmergency = world.capitalDefense.assessmentsByNationId
    .get(candidate.aggressorId)?.threatLevel === "critical";
  const existingCommitment = clamp(activeWars * 30 + activeOperations * 6 +
    navalMissions * 1.5 + frontDeficitRatio * 18 + reservePressure * 12 +
    (capitalEmergency ? 55 : 0), 0, 90);
  if (activeWars > 0 || activeOperations > 1 || frontDeficitRatio > 0.35) {
    rejection.add("overextended");
  }
  if (capitalEmergency) rejection.add("capital-emergency");

  const rawExternalExposure = calculateExternalExposure(world, attacker, target);
  const externalExposure = targetsCommonThreat ? rawExternalExposure * 0.85 : rawExternalExposure;
  if (externalExposure >= 18) rejection.add("external-threat");
  const coalitionMemberTarget = areCoalitionMembers(world, candidate.aggressorId,
    candidate.targetNationId);
  if (coalitionMemberTarget) rejection.add("common-threat-coalition");
  if (strategicValue < 8) rejection.add("strategic-value-low");
  const score = opportunity + threatResponse + strategicValue - expectedCost -
    existingCommitment - externalExposure;
  const hardRejected = rejection.has("maritime-infeasible") ||
    rejection.has("capital-emergency") || rejection.has("insufficient-strength");
  // Maritime readiness already pays a substantial transport, escort, and
  // distance premium, so its confidence threshold can be slightly lower.
  const threshold = settings.intentThreshold - (candidate.route === "maritime" ? 10 : 0);
  const aboveThreshold = !hardRejected && !coalitionMemberTarget && score + EPSILON >= threshold;
  if (!aboveThreshold && rejection.size === 0) rejection.add("below-threshold");
  const dominantReason = chooseDominantReason(candidate.route, opportunity,
    threatResponse, strategicValue, target, ports, externalExposure);
  return { ...candidate, score, opportunity, threatResponse, strategicValue,
    expectedCost, existingCommitment, externalExposure, dominantReason,
    rejectedReasons: [...rejection], aboveThreshold, declared: false,
    evaluatedAtTick: world.time.fastTick };
}

function calculateExternalExposure(
  world: WorldState,
  attacker: StrategicNationObservation,
  target: StrategicNationObservation,
): number {
  let danger = 0;
  for (const exposure of world.strategicThreatObservation.exposures) {
    if (exposure.observerNationId !== attacker.nationId ||
      exposure.threatNationId === target.nationId) continue;
    const third = observation(world, exposure.threatNationId);
    if (!third) continue;
    const dominance = clamp((third.power.score - attacker.power.score * 0.85) / 35, 0, 1);
    const relevance = exposure.score / 100;
    danger = Math.max(danger, third.threatScore * 0.42 * dominance * relevance);
  }
  return clamp(danger, 0, 36);
}

function maritimeDistanceCost(world: WorldState, attackerId: NationId,
  targetId: NationId): number {
  const ports = getPortTargetsByNation(world);
  const meso = getMesoById(world);
  let minimum = Number.POSITIVE_INFINITY;
  for (const attackerPort of ports.get(attackerId) ?? []) {
    const a = meso.get(attackerPort)?.center;
    if (!a) continue;
    for (const targetPort of ports.get(targetId) ?? []) {
      const b = meso.get(targetPort)?.center;
      if (!b) continue;
      minimum = Math.min(minimum, Math.hypot(a.x - b.x, a.y - b.y));
    }
  }
  if (!Number.isFinite(minimum)) return 16;
  return clamp(minimum / Math.max(1, Math.hypot(world.width, world.height)) * 16, 0, 16);
}

function chooseDominantReason(
  route: WarIntentCandidate["route"], opportunity: number, threat: number, value: number,
  target: StrategicNationObservation, ports: number, externalExposure: number,
): WarIntentReason {
  if (threat >= opportunity && threat >= value && target.threatRank <= 2) return "threat-response";
  if (externalExposure > 12 && target.threatRank <= 2) return "balance-of-power";
  if (route === "maritime") return ports > 0 && value >= 14 ? "strategic-port" : "maritime-expansion";
  if (target.vulnerability.score >= 45 || target.existingWars > 0) return "weakened-enemy";
  return "opportunistic-expansion";
}

function publishAssessments(world: WorldState, assessments: WarIntentAssessment[]): void {
  const state = world.warIntent;
  state.assessments = assessments;
  const byNation = new Map<NationId, WarIntentAssessment[]>();
  for (const assessment of assessments) {
    const list = byNation.get(assessment.aggressorId);
    if (list) list.push(assessment); else byNation.set(assessment.aggressorId, [assessment]);
    state.candidateEvaluations += 1;
    if (assessment.route === "land") state.landCandidates += 1;
    else state.maritimeCandidates += 1;
    if (assessment.aboveThreshold) state.intentsAboveThreshold += 1;
    else {
      state.suppressedDeclarations += 1;
      if (assessment.rejectedReasons.includes("common-threat-coalition")) {
        world.commonThreatCoalitions.suppressedDeclarations += 1;
        world.instrumentation?.incrementCounter("coalitions.suppressedDeclarations");
      }
      if (assessment.rejectedReasons.includes("external-threat")) state.suppressionByExternalThreat += 1;
      if (assessment.rejectedReasons.includes("overextended")) state.suppressionByExistingWars += 1;
      if (assessment.rejectedReasons.includes("capital-emergency")) state.suppressionByCapitalEmergency += 1;
    }
    state.totalIntent += assessment.score;
    state.totalOpportunity += assessment.opportunity;
    state.totalThreatResponse += assessment.threatResponse;
    state.totalExpectedCost += assessment.expectedCost;
    state.totalExternalExposure += assessment.externalExposure;
  }
  state.assessmentsByNationId = byNation;
  state.version += 1;
}

function recordDeclaration(world: WorldState, intent: WarIntentAssessment,
  aggressorWars: number, targetWars: number): void {
  const state = world.warIntent;
  state.declarations += 1;
  state.declarationsByReason[intent.dominantReason] += 1;
  if (world.commonThreatCoalitions.coalitionByMemberNationId
    .get(intent.aggressorId)?.targetNationId === intent.targetNationId) {
    world.commonThreatCoalitions.threatDrivenDeclarations += 1;
    world.instrumentation?.incrementCounter("coalitions.threatDrivenDeclarations");
  }
  if (intent.route === "maritime") state.maritimeDeclarations += 1;
  if (targetWars > 0) {
    state.warsAgainstAlreadyFightingNations += 1;
    if (aggressorWars === 0) state.thirdPartyOpportunisticInvasions += 1;
  }
  if (aggressorWars > 0) state.multiWarStarts += 1;
  const target = observation(world, intent.targetNationId);
  const attacker = observation(world, intent.aggressorId);
  if (target?.threatRank === 1) state.declarationsAgainstTopThreat += 1;
  if (target && attacker && target.power.score < attacker.power.score && target.threatRank > 2) {
    state.declarationsAgainstWeakerNonThreatTargets += 1;
  }
}

function recordRankingChanges(world: WorldState, next: WarIntentAssessment[]): void {
  for (const [nationId, previous] of world.warIntent.assessmentsByNationId) {
    const current = next.filter((item) => item.aggressorId === nationId);
    const previousRanks = new Map(previous.map((item, index) => [item.targetNationId, index]));
    for (let index = 0; index < current.length; index += 1) {
      const old = previousRanks.get(current[index].targetNationId);
      if (old !== undefined && old !== index) world.warIntent.rankingChanges += 1;
    }
  }
}

function rejectedMissingAssessment(world: WorldState, candidate: WarIntentCandidate): WarIntentAssessment {
  return { ...candidate, score: Number.NEGATIVE_INFINITY, opportunity: 0,
    threatResponse: 0, strategicValue: 0, expectedCost: 0, existingCommitment: 0,
    externalExposure: 0, dominantReason: "opportunistic-expansion",
    rejectedReasons: ["insufficient-strength"], aboveThreshold: false,
    declared: false, evaluatedAtTick: world.time.fastTick };
}

function observation(world: WorldState, nationId: NationId): StrategicNationObservation | undefined {
  return world.strategicThreatObservation.observationByNationId.get(nationId);
}
function countWars(world: WorldState, nationId: NationId): number {
  return world.wars.reduce((count, war) => count +
    (war.nationAId === nationId || war.nationBId === nationId ? 1 : 0), 0);
}
function compareAssessments(a: WarIntentAssessment, b: WarIntentAssessment): number {
  return compareIds(a.aggressorId, b.aggressorId) || b.score - a.score ||
    compareIds(a.targetNationId, b.targetNationId);
}
function compareIds(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
function scheduleNextWarDeclarations(world: WorldState, ready: Set<NationId>,
  range: { min: number; max: number }): void {
  for (const nation of world.nations) if (ready.has(nation.id)) {
    nation.nextWarDeclarationTick = nextScheduledTickRange(world.time.slowTick,
      range.min, range.max, world.simRng);
  }
}
