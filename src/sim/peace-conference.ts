import type { NationId } from "../worldgen/nation";
import { hasTreaty } from "./diplomacy";
import { concludePeace, warFatigueKey } from "./diplomatic-peace";
import { areFactionPartners } from "./factions";
import { isNationActive } from "./nation-active";
import { getWarDeclarationMode, recordSimulationEvent } from "./simulation-settings";
import { areSubjectPartners } from "./subject-governments";
import { assessPeaceOffer, getWarNegotiation, whitePeaceTerms } from "./war-negotiations";
import { findWar, type WarState } from "./war-state";
import type { WorldState } from "./world-state";

export interface PeaceConference {
  id: number;
  proposer: NationId;
  participants: NationId[];
  wars: { a: NationId; b: NationId; key: string }[];
  approvals: Set<NationId>;
  expiresAt: number;
}

function alliedWith(world: WorldState, leader: NationId, candidate: NationId): boolean {
  return leader === candidate || areFactionPartners(world, leader, candidate) ||
    areSubjectPartners(world, leader, candidate) || hasTreaty(world, leader, candidate, "alliance");
}

export function getConferenceWars(world: WorldState, proposer: NationId, opponent: NationId): WarState[] {
  if (getWarDeclarationMode(world) !== "diplomacy" || !findWar(world.wars, proposer, opponent)) return [];
  const left = new Set<NationId>([proposer]), right = new Set<NationId>([opponent]);
  for (const nation of world.nations) {
    if (!isNationActive(nation) || nation.id === proposer || nation.id === opponent) continue;
    const onLeft = alliedWith(world, proposer, nation.id), onRight = alliedWith(world, opponent, nation.id);
    if (onLeft && !onRight) left.add(nation.id);
    if (onRight && !onLeft) right.add(nation.id);
  }
  return world.wars.filter((war) => (left.has(war.nationAId) && right.has(war.nationBId)) ||
    (left.has(war.nationBId) && right.has(war.nationAId)));
}

export function hasConferenceWar(world: WorldState, war: WarState): boolean {
  const key = warFatigueKey(war);
  return world.peaceConferences?.some((item) => item.wars.some((pair) => pair.key === key)) ?? false;
}

export function openPeaceConference(world: WorldState, proposer: NationId, opponent: NationId): boolean {
  const wars = getConferenceWars(world, proposer, opponent);
  const participants = [...new Set(wars.flatMap((war) => [war.nationAId, war.nationBId]))];
  if (participants.length < 3 || wars.some((war) => hasConferenceWar(world, war)) ||
    !participants.every((id) => world.nations.some((nation) => nation.id === id && isNationActive(nation)))) return false;
  const id = world.nextPeaceConferenceId ?? 1;
  world.nextPeaceConferenceId = id + 1;
  (world.peaceConferences ??= []).push({ id, proposer, participants, approvals: new Set([proposer]),
    wars: wars.map((war) => ({ a: war.nationAId, b: war.nationBId, key: warFatigueKey(war) })),
    expiresAt: world.time.slowTick + 90 });
  recordSimulationEvent(world, { category: "diplomacy", nationIds: participants,
    message: `${proposer} opened a joint peace conference covering ${wars.length} wars.` });
  return true;
}

function conferenceIssue(world: WorldState, conference: PeaceConference): string | null {
  if (world.time.slowTick >= conference.expiresAt) return "the invitation expired";
  if (getWarDeclarationMode(world) !== "diplomacy") return "diplomacy is disabled";
  if (conference.participants.some((id) => !world.nations.some((nation) => nation.id === id && isNationActive(nation)))) return "a participant lost its government";
  if (conference.wars.some(({ a, b, key }) => {
    const war = findWar(world.wars, a, b);
    return !war || warFatigueKey(war) !== key;
  })) return "a listed war ended separately";
  return null;
}

function finishConference(world: WorldState, conference: PeaceConference, issue?: string): void {
  world.peaceConferences = world.peaceConferences?.filter((item) => item !== conference);
  if (!issue) for (const { a, b } of conference.wars) concludePeace(world, a, b, "joint peace conference");
  recordSimulationEvent(world, { category: "diplomacy", nationIds: conference.participants,
    message: issue ? `Joint peace conference closed: ${issue}.` : `Joint peace signed in all ${conference.wars.length} listed wars.` });
}

export function respondToPeaceConference(world: WorldState, id: number, nation: NationId, accept: boolean): boolean {
  const conference = world.peaceConferences?.find((item) => item.id === id);
  if (!conference?.participants.includes(nation)) return false;
  const issue = conferenceIssue(world, conference);
  if (issue) { finishConference(world, conference, issue); return false; }
  if (!accept) finishConference(world, conference, `${nation} withdrew consent`);
  else {
    conference.approvals.add(nation);
    if (conference.approvals.size === conference.participants.length) finishConference(world, conference);
  }
  return true;
}

export function updatePeaceConferences(world: WorldState): void {
  if (!world.peaceConferences?.length || world.time.slowTick % 5 !== 0) return;
  for (const conference of world.peaceConferences) {
    const issue = conferenceIssue(world, conference);
    if (issue) { finishConference(world, conference, issue); continue; }
    for (const id of conference.participants) {
      if (conference.approvals.has(id)) continue;
      const accepts = conference.wars.filter(({ a, b }) => a === id || b === id).every(({ a, b }) => {
        const opponent = a === id ? b : a;
        const war = findWar(world.wars, id, opponent)!;
        return getWarNegotiation(world, war).automatic.get(id) &&
          assessPeaceOffer(world, id, opponent, whitePeaceTerms()).accepts;
      });
      if (accepts) respondToPeaceConference(world, conference.id, id, true);
    }
  }
}
