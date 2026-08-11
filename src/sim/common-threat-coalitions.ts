import type { NationId } from "../worldgen/nation";
import { isNationActive } from "./nation-active";
import type { StrategicExposureObservation, StrategicNationObservation } from "./strategic-threat-observation";
import { buildWarAdjacency, isAtWar } from "./war-state";
import type { WorldState } from "./world-state";

const FORMATION_THREAT_SCORE = 22;
const FORMATION_EXPOSURE_SCORE = 25;
const SUSTAIN_THREAT_SCORE = 16;
const SUSTAIN_EXPOSURE_SCORE = 15;
const DISSOLUTION_HYSTERESIS_TICKS = 3;

export type CoalitionFormationReason = "shared-land-threat" | "shared-maritime-threat" | "shared-mixed-threat";
export type CoalitionDissolutionReason = "threat-reduced" | "threat-eliminated" | "threat-replaced" | "member-war" | "exposure-disappeared";

export interface CommonThreatCoalition {
  id: string;
  targetNationId: NationId;
  memberNationIds: NationId[];
  formedAtSlowTick: number;
  age: number;
  formationReason: CoalitionFormationReason;
  pendingDissolutionReason: CoalitionDissolutionReason | null;
  unstableTicks: number;
}

export interface CoalitionDissolutionRecord {
  coalitionId: string;
  targetNationId: NationId;
  memberNationIds: NationId[];
  duration: number;
  reason: CoalitionDissolutionReason;
  dissolvedAtSlowTick: number;
}

export interface CommonThreatCoalitionState {
  coalitions: CommonThreatCoalition[];
  coalitionByMemberNationId: Map<NationId, CommonThreatCoalition>;
  largestThreatByNationId: Map<NationId, NationId>;
  lastDissolutions: CoalitionDissolutionRecord[];
  version: number;
  coalitionsFormed: number;
  coalitionsDissolved: number;
  totalCoalitionDuration: number;
  suppressedDeclarations: number;
  threatDrivenDeclarations: number;
}

interface ThreatChoice {
  targetNationId: NationId;
  perceivedScore: number;
  exposure: StrategicExposureObservation;
}

export function createCommonThreatCoalitionState(): CommonThreatCoalitionState {
  return { coalitions: [], coalitionByMemberNationId: new Map(), largestThreatByNationId: new Map(),
    lastDissolutions: [], version: 0, coalitionsFormed: 0, coalitionsDissolved: 0,
    totalCoalitionDuration: 0, suppressedDeclarations: 0, threatDrivenDeclarations: 0 };
}

export function updateCommonThreatCoalitions(world: WorldState): void {
  const state = world.commonThreatCoalitions;
  const wars = buildWarAdjacency(world.wars);
  const choices = chooseLargestThreats(world, FORMATION_THREAT_SCORE, FORMATION_EXPOSURE_SCORE);
  const sustainChoices = chooseLargestThreats(world, SUSTAIN_THREAT_SCORE, SUSTAIN_EXPOSURE_SCORE);
  state.largestThreatByNationId = new Map([...choices].map(([id, choice]) => [id, choice.targetNationId]));
  const retained: CommonThreatCoalition[] = [];
  const occupiedMembers = new Set<NationId>();
  for (const coalition of state.coalitions) {
    coalition.age = Math.max(0, world.time.slowTick - coalition.formedAtSlowTick);
    const failure = coalitionFailure(world, coalition, sustainChoices, wars);
    if (!failure) {
      const currentMembers = coalition.memberNationIds.filter((id) =>
        sustainChoices.get(id)?.targetNationId === coalition.targetNationId
      );
      if (currentMembers.length >= 2) coalition.memberNationIds = currentMembers;
      coalition.unstableTicks = 0;
      coalition.pendingDissolutionReason = null;
    } else {
      coalition.unstableTicks += 1;
      coalition.pendingDissolutionReason = failure;
    }
    const immediate = failure === "threat-eliminated" || failure === "member-war";
    if (failure && (immediate || coalition.unstableTicks >= DISSOLUTION_HYSTERESIS_TICKS)) {
      dissolveCoalition(world, coalition, failure);
      continue;
    }
    retained.push(coalition);
    coalition.memberNationIds.forEach((id) => occupiedMembers.add(id));
  }
  const targetIds = [...new Set([...choices.values()].map((choice) => choice.targetNationId))].sort(compareIds);
  for (const targetId of targetIds) {
    const availableChoices = new Map([...choices].filter(([id]) => !occupiedMembers.has(id)));
    const members = compatibleMembersForTarget(targetId, availableChoices, wars);
    if (members.length < 2) continue;
    const coalition: CommonThreatCoalition = {
      id: `coalition-${targetId}-${world.time.slowTick}`, targetNationId: targetId,
      memberNationIds: members, formedAtSlowTick: world.time.slowTick, age: 0,
      formationReason: formationReason(members, choices), pendingDissolutionReason: null,
      unstableTicks: 0,
    };
    retained.push(coalition);
    state.coalitionsFormed += 1;
    world.instrumentation?.incrementCounter("coalitions.formed");
    members.forEach((id) => occupiedMembers.add(id));
  }
  retained.sort((a, b) => compareIds(a.targetNationId, b.targetNationId));
  state.coalitions = retained;
  state.coalitionByMemberNationId = new Map();
  for (const coalition of retained) for (const id of coalition.memberNationIds) {
    state.coalitionByMemberNationId.set(id, coalition);
  }
  state.version += 1;
}

export function areCoalitionMembers(world: WorldState, a: NationId, b: NationId): boolean {
  return world.commonThreatCoalitions.coalitionByMemberNationId.get(a)?.memberNationIds.includes(b) ?? false;
}

function chooseLargestThreats(world: WorldState, minimumThreat: number, minimumExposure: number): Map<NationId, ThreatChoice> {
  const result = new Map<NationId, ThreatChoice>();
  for (const exposure of world.strategicThreatObservation.exposures) {
    if (exposure.score < minimumExposure) continue;
    const threat = observation(world, exposure.threatNationId);
    const observer = observation(world, exposure.observerNationId);
    if (!threat || !observer || threat.threatScore < minimumThreat) continue;
    const balance = clamp(threat.power.score / Math.max(1, observer.power.score), 0.5, 1.5);
    const perceivedScore = threat.threatScore * exposure.score / 100 * balance;
    const current = result.get(exposure.observerNationId);
    if (!current || perceivedScore > current.perceivedScore ||
      (perceivedScore === current.perceivedScore && compareIds(exposure.threatNationId, current.targetNationId) < 0)) {
      result.set(exposure.observerNationId, { targetNationId: exposure.threatNationId, perceivedScore, exposure });
    }
  }
  return result;
}

function compatibleMembersForTarget(targetId: NationId, choices: ReadonlyMap<NationId, ThreatChoice>, wars: ReturnType<typeof buildWarAdjacency>): NationId[] {
  const candidates = [...choices].filter(([, choice]) => choice.targetNationId === targetId)
    .map(([id]) => id).sort(compareIds);
  const members: NationId[] = [];
  for (const candidate of candidates) if (members.every((member) => !isAtWar(candidate, member, wars))) members.push(candidate);
  return members;
}

function coalitionFailure(world: WorldState, coalition: CommonThreatCoalition,
  choices: ReadonlyMap<NationId, ThreatChoice>, wars: ReturnType<typeof buildWarAdjacency>): CoalitionDissolutionReason | null {
  const target = world.nations.find((nation) => nation.id === coalition.targetNationId);
  if (!target || !isNationActive(target)) return "threat-eliminated";
  for (let i = 0; i < coalition.memberNationIds.length; i += 1) for (let j = i + 1; j < coalition.memberNationIds.length; j += 1) {
    if (isAtWar(coalition.memberNationIds[i], coalition.memberNationIds[j], wars)) return "member-war";
  }
  const memberChoices = coalition.memberNationIds.map((id) => choices.get(id));
  if (memberChoices.filter((choice) => choice?.targetNationId === coalition.targetNationId).length >= 2) return null;
  if (memberChoices.every((choice) => !choice)) return "exposure-disappeared";
  if (memberChoices.some((choice) => choice && choice.targetNationId !== coalition.targetNationId)) return "threat-replaced";
  return "threat-reduced";
}

function formationReason(members: NationId[], choices: ReadonlyMap<NationId, ThreatChoice>): CoalitionFormationReason {
  const landCount = members.filter((id) => choices.get(id)?.exposure.landAdjacent).length;
  return landCount === members.length ? "shared-land-threat" : landCount === 0 ? "shared-maritime-threat" : "shared-mixed-threat";
}

function dissolveCoalition(world: WorldState, coalition: CommonThreatCoalition, reason: CoalitionDissolutionReason): void {
  const duration = Math.max(0, world.time.slowTick - coalition.formedAtSlowTick);
  const state = world.commonThreatCoalitions;
  state.coalitionsDissolved += 1;
  state.totalCoalitionDuration += duration;
  state.lastDissolutions.unshift({ coalitionId: coalition.id, targetNationId: coalition.targetNationId,
    memberNationIds: [...coalition.memberNationIds], duration, reason, dissolvedAtSlowTick: world.time.slowTick });
  state.lastDissolutions.length = Math.min(state.lastDissolutions.length, 6);
  world.instrumentation?.incrementCounter("coalitions.dissolved");
}

function observation(world: WorldState, nationId: NationId): StrategicNationObservation | undefined {
  return world.strategicThreatObservation.observationByNationId.get(nationId);
}
function compareIds(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
