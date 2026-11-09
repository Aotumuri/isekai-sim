import { getDomesticUnrest, getRevolutionRisk } from "./domestic-unrest";
import { ideologyCompatibility } from "./ideology-relations";
import { isNationActive } from "./nation-active";
import { getNationCharacter, type NationCharacter } from "./nation-character";
import { BUILTIN_IDEOLOGIES, getIdeologies, getNationIdeology, identityHash } from "./nation-identity";
import type { NationRuntime } from "./nation-runtime";
import { getWarDeclarationMode, hasPoliticalTurbulence, recordSimulationEvent } from "./simulation-settings";
import type { WorldState } from "./world-state";

export type GovernmentSystem = "democracy" | "monarchy";
export interface NationalPolitics {
  system: GovernmentSystem;
  governingIdeologyId: string;
  coalition: string[];
  support: Map<string, number>;
  seats: Map<string, number>;
  nextMandateAt: number;
  consecutiveMandates: number;
  nextSupportReviewAt: number;
  nextForeignCampaignAt?: number;
  nextIncomingCampaignAt?: number;
  suppression?: { ideologyId: string; until: number };
  nextSuppressionAt?: number;
}

const ELECTION_INTERVAL = 420;
const SUCCESSION_INTERVAL = 900;
const SUPPORT_REVIEW_INTERVAL = 30;
const POLICY_PROFILES: Record<string, NationCharacter> = {
  capitalism: { doctrine: "merchant", aggression: 0.25, cooperation: 0.85, innovation: 0.7, thrift: 0.85 },
  communism: { doctrine: "guardian", aggression: 0.45, cooperation: 0.65, innovation: 0.65, thrift: 0.55 },
  cohesionism: { doctrine: "pragmatist", aggression: 0.4, cooperation: 0.85, innovation: 0.6, thrift: 0.65 },
  "avian-supremacy": { doctrine: "expansionist", aggression: 0.9, cooperation: 0.3, innovation: 0.55, thrift: 0.35 },
};

function initialSupport(incumbent: string, seed: number): Map<string, number> {
  const opposition = BUILTIN_IDEOLOGIES.filter(({ id }) => id !== incumbent);
  const incumbentShare = 37 + seed % 17;
  const remaining = 100 - incumbentShare;
  const share = Math.floor(remaining / opposition.length);
  return new Map([[incumbent, incumbentShare], ...opposition.map(({ id }, index): [string, number] =>
    [id, share + Number(index < remaining % opposition.length)])]);
}

function rankedParties(support: ReadonlyMap<string, number>, incumbent: string): [string, number][] {
  return [...support].filter(([, share]) => share > 0)
    .sort(([a, shareA], [b, shareB]) => shareB - shareA ||
      Number(b === incumbent) - Number(a === incumbent) || a.localeCompare(b));
}

function formCoalition(seats: ReadonlyMap<string, number>, incumbent: string): string[] {
  const coalition: string[] = [];
  let total = 0;
  for (const [id, count] of rankedParties(seats, incumbent)) {
    coalition.push(id);
    total += count;
    if (total > 50) break;
  }
  return coalition;
}

export function getNationalPolitics(world: WorldState, nation: NationRuntime): NationalPolitics {
  if (nation.politics) return nation.politics;
  const hash = identityHash(`${world.worldSeed ?? 0}:${nation.id}:government`);
  const system = hash % 3 === 0 ? "monarchy" : "democracy";
  const incumbent = getNationIdeology(world, nation.id).id;
  const support = initialSupport(incumbent, hash >>> 16);
  const seats = system === "democracy" ? new Map(support) : new Map<string, number>();
  const now = world.time.slowTick;
  return nation.politics = {
    system, governingIdeologyId: incumbent,
    coalition: system === "democracy" ? formCoalition(seats, incumbent) : [incumbent],
    support, seats, consecutiveMandates: 1,
    nextMandateAt: now + (system === "democracy" ? ELECTION_INTERVAL : SUCCESSION_INTERVAL) + (hash >>> 8) % 120,
    nextSupportReviewAt: now + SUPPORT_REVIEW_INTERVAL,
  };
}

/** Moves percentage points from other parties while preserving a total of 100. */
export function increasePoliticalSupport(politics: NationalPolitics, ideologyId: string, points: number): number {
  const before = politics.support.get(ideologyId) ?? 0;
  for (let remaining = Math.min(points, 100 - before); remaining > 0; remaining--) {
    const donor = rankedParties(politics.support, politics.governingIdeologyId).find(([id]) => id !== ideologyId);
    if (!donor) break;
    politics.support.set(donor[0], donor[1] - 1);
    politics.support.set(ideologyId, (politics.support.get(ideologyId) ?? 0) + 1);
  }
  return (politics.support.get(ideologyId) ?? 0) - before;
}

function adoptGovernmentIdeology(world: WorldState, nation: NationRuntime, ideologyId: string): void {
  if (nation.ideologyId !== ideologyId && nation.politics) delete nation.politics.suppression;
  const base = nation.preGovernmentCharacter ??= { ...getNationCharacter(world, nation.id) };
  const policy = POLICY_PROFILES[ideologyId];
  nation.ideologyId = ideologyId;
  nation.character = policy ? {
    doctrine: policy.doctrine,
    aggression: base.aggression * 0.25 + policy.aggression * 0.75,
    cooperation: base.cooperation * 0.25 + policy.cooperation * 0.75,
    innovation: base.innovation * 0.25 + policy.innovation * 0.75,
    thrift: base.thrift * 0.25 + policy.thrift * 0.75,
  } : { ...base };
}

/** Existing sandbox ideology controls establish a fresh mandate. */
export function setPoliticalMandate(world: WorldState, nation: NationRuntime, ideologyId: string): void {
  const politics = getNationalPolitics(world, nation);
  if (politics.governingIdeologyId === ideologyId && nation.ideologyId === ideologyId) return;
  installPoliticalMandate(world, nation, politics, ideologyId);
}

function installPoliticalMandate(world: WorldState, nation: NationRuntime, politics: NationalPolitics, ideologyId: string): void {
  politics.governingIdeologyId = ideologyId;
  politics.support = initialSupport(ideologyId, identityHash(`${nation.id}:${ideologyId}:mandate`));
  politics.consecutiveMandates = 1;
  politics.nextMandateAt = world.time.slowTick + (politics.system === "democracy" ? ELECTION_INTERVAL : SUCCESSION_INTERVAL);
  politics.nextSupportReviewAt = world.time.slowTick + SUPPORT_REVIEW_INTERVAL;
  politics.seats = politics.system === "democracy" ? new Map(politics.support) : new Map();
  politics.coalition = politics.system === "democracy" ? formCoalition(politics.seats, ideologyId) : [ideologyId];
  adoptGovernmentIdeology(world, nation, ideologyId);
}

export function establishRevolutionaryGovernment(world: WorldState, parent: NationRuntime, rebel: NationRuntime): void {
  if (getWarDeclarationMode(world) !== "diplomacy") return;
  const parentPolitics = getNationalPolitics(world, parent);
  const incumbent = parentPolitics.governingIdeologyId;
  const ideology = rankedParties(parentPolitics.support, incumbent).find(([id]) => id !== incumbent)?.[0] ??
    BUILTIN_IDEOLOGIES.find(({ id }) => id !== incumbent)!.id;
  const politics = getNationalPolitics(world, rebel);
  politics.system = "democracy";
  installPoliticalMandate(world, rebel, politics, ideology);
  const ideologyName = getNationIdeology(world, rebel.id).name;
  recordSimulationEvent(world, { category: "politics", nationIds: [parent.id, rebel.id],
    message: `${rebel.id} founded a parliamentary government led by ${ideologyName}, formerly in opposition in ${parent.id}.` });
}

export function updateNationalPolitics(world: WorldState): void {
  if (getWarDeclarationMode(world) !== "diplomacy") return;
  const now = world.time.slowTick;
  for (const nation of world.nations) {
    if (!isNationActive(nation)) continue;
    const politics = getNationalPolitics(world, nation);
    const incumbent = politics.governingIdeologyId;
    if (now >= politics.nextSupportReviewAt) {
      politics.nextSupportReviewAt = now + SUPPORT_REVIEW_INTERVAL;
      if (hasPoliticalTurbulence(world)) reviewSuppression(world, nation, politics);
      const opposition = rankedParties(politics.support, incumbent).find(([id]) => id !== incumbent)?.[0];
      const crisis = Math.max(getRevolutionRisk(world, nation.id), 1 - nation.warCooperation);
      const pressure = politics.system === "democracy" ? 4 : 2;
      if (politics.suppression && hasPoliticalTurbulence(world)) {
        increasePoliticalSupport(politics, politics.suppression.ideologyId, 3);
      } else if (opposition && crisis >= 0.35) {
        increasePoliticalSupport(politics, opposition, Math.ceil(crisis * pressure));
      } else if (opposition && politics.system === "democracy" && politics.consecutiveMandates >= 2) {
        increasePoliticalSupport(politics, opposition, 2);
      } else if ((politics.support.get(incumbent) ?? 0) < 55) {
        increasePoliticalSupport(politics, incumbent, 1);
      }
    }
    if (now < politics.nextMandateAt) continue;
    const democratic = politics.system === "democracy";
    politics.nextMandateAt = now + (democratic ? ELECTION_INTERVAL : SUCCESSION_INTERVAL);
    const banned = hasPoliticalTurbulence(world) && (politics.suppression?.until ?? 0) > now ? politics.suppression?.ideologyId : undefined;
    const eligible = rankedParties(politics.support, incumbent).filter(([id]) => id !== banned);
    const leader = eligible[0]?.[0] ?? incumbent;
    if (democratic) {
      politics.seats = banned ? redistributeSeats(eligible) : new Map(politics.support);
      politics.coalition = formCoalition(politics.seats, incumbent);
      politics.governingIdeologyId = politics.coalition[0] ?? incumbent;
    } else if ((politics.support.get(leader) ?? 0) >= (politics.support.get(incumbent) ?? 0) + 8) {
      politics.governingIdeologyId = leader;
      politics.coalition = [leader];
    }
    politics.consecutiveMandates = incumbent === politics.governingIdeologyId ? politics.consecutiveMandates + 1 : 1;
    if (nation.ideologyId !== politics.governingIdeologyId) adoptGovernmentIdeology(world, nation, politics.governingIdeologyId);
    const name = getIdeologies(world).find(({ id }) => id === politics.governingIdeologyId)?.name ?? politics.governingIdeologyId;
    recordSimulationEvent(world, { category: "politics", nationIds: [nation.id],
      message: `${nation.id}: ${democratic ? "election" : "royal succession"} ${incumbent === politics.governingIdeologyId ? "retained" : "brought to power"} ${name}.` });
  }
}

function reviewSuppression(world: WorldState, nation: NationRuntime, politics: NationalPolitics): void {
  const now = world.time.slowTick;
  const name = (id: string) => getIdeologies(world).find((ideology) => ideology.id === id)?.name ?? id;
  if (politics.suppression && politics.suppression.until <= now) {
    recordSimulationEvent(world, { category: "politics", nationIds: [nation.id],
      message: `${nation.id} lifted its ban on ${name(politics.suppression.ideologyId)}. The movement can contest the next mandate.` });
    delete politics.suppression;
  }
  if (now < 120 || politics.suppression || (politics.nextSuppressionAt ?? 0) > now ||
    (politics.system !== "monarchy" && getNationCharacter(world, nation.id).aggression < 0.6)) return;
  const target = rankedParties(politics.support, politics.governingIdeologyId)
    .find(([id, share]) => share >= 18 && ideologyCompatibility(id, politics.governingIdeologyId) <= -0.65);
  if (!target) return;
  politics.suppression = { ideologyId: target[0], until: now + 240 };
  politics.nextSuppressionAt = now + 660;
  const unrest = getDomesticUnrest(world, nation.id);
  unrest.pressure = Math.min(100, unrest.pressure + 18);
  recordSimulationEvent(world, { category: "politics", nationIds: [nation.id],
    message: `${nation.id} banned ${name(target[0])}. Underground organizing and domestic unrest are rising.` });
}

function redistributeSeats(parties: [string, number][]): Map<string, number> {
  const total = parties.reduce((sum, [, support]) => sum + support, 0);
  const quotas = parties.map(([id, support]) => ({ id, quota: 100 * support / total }));
  const seats = new Map(quotas.map(({ id, quota }) => [id, Math.floor(quota)]));
  const remainder = 100 - [...seats.values()].reduce((sum, count) => sum + count, 0);
  quotas.sort((a, b) => (b.quota % 1) - (a.quota % 1));
  for (const { id } of quotas.slice(0, remainder)) seats.set(id, seats.get(id)! + 1);
  return seats;
}
