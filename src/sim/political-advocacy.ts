import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import { clamp } from "../utils/math";
import { getInfluence, getRelation, hasTreaty, spendInfluence } from "./diplomacy";
import { FIRST_FOREIGN_ADVOCACY_TICK } from "./foreign-advocacy-schedule";
import { getRegionalIdentityGrievance, grievanceLevel } from "./identity-grievances";
import type { ForeignAdvocacyExclusion } from "./instrumentation";
import { identityGroupIndex } from "./identity-policy";
import { ideologyCompatibility } from "./ideology-relations";
import { isNationActive } from "./nation-active";
import { getNationCharacter } from "./nation-character";
import { getNationIdeology } from "./nation-identity";
import type { NationRuntime } from "./nation-runtime";
import { POPULATION_GROUPS } from "./regional-population";
import type { ForeignBacking, RegionalNegotiation } from "./regional-negotiations";
import { getWarDeclarationMode, hasPoliticalTurbulence, recordSimulationEvent } from "./simulation-settings";
import { getSubjectOverlord } from "./subject-governments";
import { getTerritorialClaim } from "./territorial-claims";
import { findWar } from "./war-state";
import { getOwnerByMesoId } from "./world-cache";
import type { WorldState } from "./world-state";

/** Diplomatic influence spent to recognize and support an existing political demand. */
export const POLITICAL_ADVOCACY_COST = 22;
export const ADVOCACY_INFLUENCE_REQUIRED = POLITICAL_ADVOCACY_COST + 20;
export const POLITICAL_ADVOCACY_RENEWAL_COST = 12;
/** Slow ticks between renewals of an active commitment (160 slow ticks = 1,600 days). */
export const ADVOCACY_RENEWAL_INTERVAL = 160;
/** A sponsor that has just intervened waits before starting another campaign. */
const SPONSOR_COOLDOWN = 200;
/** A movement that turned a sponsor down will not reconsider at once. */
const REFUSAL_COOLDOWN = 300;
/** Simultaneous commitments one sponsor may hold. */
export const MAX_ACTIVE_PER_SPONSOR = 2;
/** Support fades unless the sponsor renews it. Applied every ten slow ticks. */
const BACKING_DECAY = 0.985;
const MINIMUM_BACKING = 0.05;
/** Interest below this threshold is not worth a diplomatic commitment. */
const INTEREST_THRESHOLD = 0.22;
const LIVE_STATUSES: ReadonlySet<RegionalNegotiation["status"]> = new Set(["demand", "deferred", "offer"]);

interface Interest {
  score: number;
  kinship: number;
  share: number;
  treatyCost: number;
  subjectOverlordCost: number;
}

interface AdvocacyOffer {
  id: MesoRegionId;
  owner: NationRuntime;
  sponsor: NationRuntime;
  talks: RegionalNegotiation;
  strength: number;
  backlash: number;
  interest: Interest;
}

function preferredGroup(nation: NationRuntime, dimension: "ancestry" | "culture" | "faith"): number {
  const name = nation.identityGovernment?.favored[dimension];
  return name ? identityGroupIndex(dimension, name) : -1;
}

function treatyCost(world: WorldState, sponsor: NationId, partner: NationId, readOnly: boolean): number {
  if (hasTreaty(world, sponsor, partner, "alliance", readOnly)) return 0.9;
  if (hasTreaty(world, sponsor, partner, "non-aggression", readOnly) || hasTreaty(world, sponsor, partner, "trade", readOnly)) return 0.45;
  return 0;
}

/**
 * Would this government care about the demand on its own merits? Interests come only
 * from current world state: shared identity, territorial claims, rivalry, and the
 * political character of the cabinet.
 */
function evaluateInterest(world: WorldState, id: MesoRegionId, talks: RegionalNegotiation,
  owner: NationRuntime, sponsor: NationRuntime, readOnly = false): Interest & { factors?: Record<string, number> } {
  const character = getNationCharacter(world, sponsor.id, readOnly);
  const affinity = ideologyCompatibility(getNationIdeology(world, sponsor.id, readOnly).id, getNationIdeology(world, owner.id, readOnly).id);
  const population = world.regionalPopulations?.get(id);
  const share = population?.size ? population[talks.dimension][talks.group]! / population.size : 0;
  const kinship = preferredGroup(sponsor, talks.dimension) === talks.group ? 1 : 0;
  // Culture ties can follow the administrative alignment recorded by governance.
  const alignedCulture = talks.dimension === "culture" && sponsor.governance?.alignmentCulture === POPULATION_GROUPS.culture[talks.group];
  const claim = getTerritorialClaim(world, sponsor.id, id, readOnly) / 100;
  const relation = getRelation(world, sponsor.id, owner.id, readOnly);
  const rivalry = relation.opinion < 0 ? Math.min(1, -relation.opinion / 100) : 0;
  const directCost = treatyCost(world, sponsor.id, owner.id, readOnly);
  const overlord = getSubjectOverlord(world, owner.id);
  const subjectOverlordCost = overlord ? treatyCost(world, sponsor.id, overlord, readOnly) : 0;
  const score = kinship * 0.55 + (alignedCulture && !kinship ? 0.18 : 0) + claim * 0.30 + rivalry * 0.30 +
    Math.max(0, -affinity) * 0.16 + share * 0.16 + character.aggression * 0.18 - character.cooperation * 0.22 -
    directCost * 0.55 - subjectOverlordCost * 0.35;
  const factors = readOnly ? {
    kinship, alignedCulture: Number(alignedCulture && !kinship), claim, rivalry,
    ideology: Math.max(0, -affinity), share, aggression: character.aggression, cooperation: character.cooperation,
    directTreaty: directCost, overlordTreaty: subjectOverlordCost,
  } : undefined;
  return { score, kinship, share, treatyCost: directCost, subjectOverlordCost, factors };
}

/** How strongly the target government can portray the sponsor as an illegitimate meddler. */
function repudiation(world: WorldState, talks: RegionalNegotiation, owner: NationRuntime, sponsor: NationRuntime,
  interest: Interest, readOnly = false): number {
  const affinity = ideologyCompatibility(getNationIdeology(world, sponsor.id, readOnly).id, getNationIdeology(world, owner.id, readOnly).id);
  const relation = getRelation(world, sponsor.id, owner.id, readOnly);
  const legitimacy = (owner.identityStability?.legitimacy ?? 100) / 100;
  return clamp(0.15 + legitimacy * 0.35 + (1 - Math.max(0, affinity)) * 0.15 +
    (interest.kinship ? -0.22 : 0.12) + (relation.opinion < 0 ? 0.12 : 0) +
    Math.max(0, talks.distrust) * 0.25, 0, 1);
}

/**
 * The movement decides for itself. It values recognition only when it has a real
 * constituency, and it refuses support that would cost local legitimacy or
 * undercut a credible domestic settlement.
 */
export function evaluateMovementSupport(world: WorldState, id: MesoRegionId, talks: RegionalNegotiation,
  owner: NationRuntime, sponsor: NationRuntime, strength: number, backlash: number, interest: Interest, readOnly = false) {
  const relation = getRelation(world, sponsor.id, owner.id, readOnly);
  const grievance = Math.max(talks.grievance,
    grievanceLevel(getRegionalIdentityGrievance(world, id, owner.id)));
  const domesticPath = talks.status === "offer" && talks.offer === talks.requested;
  const value = strength * (0.35 + grievance * 0.9) * (0.55 + interest.share * 0.75) +
    relation.trust / 100 * 0.18 + (interest.kinship ? 0.10 : 0);
  const cost = backlash * 0.42 + (interest.kinship ? 0 : 0.10) + (domesticPath ? 0.40 : 0) +
    (relation.opinion > 30 ? 0.12 : 0) - (talks.distrust > 0.15 ? 0.05 : 0);
  // A movement that already won a full domestic settlement has nothing to gain from
  // a foreign patron, and accepting one would put the settlement at risk.
  return { accepted: !domesticPath && value > cost + 0.02, value, cost, grievance, domesticPath };
}

/** Why the movement decided as it did, for observation. */
export function describeSupportDecision(decision: ReturnType<typeof evaluateMovementSupport>): string {
  if (decision.domesticPath) return "The movement preferred the domestic settlement already on offer.";
  if (decision.value <= decision.cost) {
    return decision.grievance < 0.20 ? "The movement judged that outside backing added little to a weak local cause." :
      "The movement judged that association with the sponsor would cost more local legitimacy than it gained.";
  }
  return "The movement accepted recognition to reinforce its negotiating position.";
}

export function liveNegotiations(world: WorldState, districts?: readonly MesoRegionId[]): [MesoRegionId, RegionalNegotiation][] {
  const negotiations = world.regionalNegotiations;
  if (!negotiations?.size || districts?.length === 0) return [];
  const owners = world.regionalPopulations ? getOwnerByMesoId(world) : undefined;
  const result: [MesoRegionId, RegionalNegotiation][] = [];
  const consider = (talks: RegionalNegotiation, id: MesoRegionId) => {
    if (!LIVE_STATUSES.has(talks.status) || (owners && owners.get(id) !== talks.owner)) return;
    result.push([id, talks]);
  };
  if (districts) {
    for (const id of districts) {
      const talks = negotiations.get(id);
      if (talks) consider(talks, id);
    }
  } else negotiations.forEach(consider);
  return result.sort((a, b) => a[0].localeCompare(b[0]));
}

export function activeSponsorships(world: WorldState): Map<NationId, number> {
  const counts = new Map<NationId, number>();
  // Only live negotiations consume a sponsor's capacity. A commitment left on a
  // closed or superseded case must not block new legitimate commitments.
  for (const [, talks] of liveNegotiations(world)) {
    const sponsor = talks.foreign?.sponsorId;
    if (sponsor) counts.set(sponsor, (counts.get(sponsor) ?? 0) + 1);
  }
  return counts;
}

/**
 * A candidate list is a snapshot. Before every proposal, re-read the state that
 * authorizes it: the negotiation may have closed, the sponsor may have committed
 * to another movement or entered its cooldown, and influence may already be spent.
 */
function canCommitNow(world: WorldState, offer: AdvocacyOffer, now: number,
  sponsorships: ReadonlyMap<NationId, number>): boolean {
  const { id, owner, sponsor, talks } = offer;
  if (world.regionalNegotiations?.get(id) !== talks ||
    (world.regionalPopulations && getOwnerByMesoId(world).get(id) !== owner.id)) return false;
  if (!LIVE_STATUSES.has(talks.status) || talks.foreign || talks.owner !== owner.id) return false;
  if (!isNationActive(owner) || !isNationActive(sponsor)) return false;
  if (findWar(world.wars, sponsor.id, owner.id) || getRelation(world, sponsor.id, owner.id).crisis) return false;
  if (getSubjectOverlord(world, sponsor.id) === owner.id || getSubjectOverlord(world, owner.id) === sponsor.id) return false;
  if ((sponsor.politics?.nextForeignAdvocacyAt ?? 0) > now) return false;
  if ((talks.foreignRefusals?.[sponsor.id] ?? 0) > now) return false;
  if ((sponsorships.get(sponsor.id) ?? 0) >= MAX_ACTIVE_PER_SPONSOR) return false;
  // Contacts and interest were read for this cycle. Proposals in the same
  // batch can spend the screened reserve without changing either of those inputs.
  return getInfluence(world, sponsor.id) >= POLITICAL_ADVOCACY_COST;
}

function endBacking(world: WorldState, id: MesoRegionId, talks: RegionalNegotiation, reason: string) {
  const sponsor = talks.foreign?.sponsorId;
  if (!sponsor) return;
  delete talks.foreign;
  world.instrumentation?.incrementCounter("foreignAdvocacy.expired");
  recordSimulationEvent(world, { category: "politics", nationIds: [sponsor, talks.owner],
    message: `${sponsor} ended its support for the ${POPULATION_GROUPS[talks.dimension][talks.group]} demand in district ${id} (${talks.owner}). ${reason}` });
}

function applyAdvocacy(world: WorldState, offer: AdvocacyOffer, accepted: boolean,
  decision: ReturnType<typeof evaluateMovementSupport>, now: number, reassessment: boolean): void {
  const { id, owner, sponsor, talks, backlash } = offer;
  const relation = getRelation(world, sponsor.id, owner.id);
  // Public advocacy is visible: even a refused offer strains the bilateral relationship.
  let changedRelations = Number(relation.tension < 100 || relation.trust > 0);
  const friction = accepted ? 5 + backlash * 8 : 2 + backlash * 4;
  relation.tension = clamp(relation.tension + friction, 0, 100);
  relation.trust = clamp(relation.trust - (accepted ? 2 + backlash * 5 : 1 + backlash * 2), 0, 100);
  const overlord = getSubjectOverlord(world, owner.id);
  if (overlord) {
    const guardian = getRelation(world, overlord, sponsor.id);
    if (guardian.tension < 100) changedRelations++;
    guardian.tension = clamp(guardian.tension + 4 + backlash * 6, 0, 100);
    const loyalty = getRelation(world, overlord, owner.id);
    if (loyalty.trust > 0) changedRelations++;
    loyalty.trust = clamp(loyalty.trust - (accepted ? 1.5 : 0.5), 0, 100);
  }
  world.instrumentation?.incrementCounter("foreignAdvocacy.relationshipChanges", changedRelations);
  world.instrumentation?.observeRegionalAdvocacy?.({ kind: "offer", id, talks, accepted,
    sponsorId: sponsor.id, domesticSettlement: decision.domesticPath, relationshipChanges: changedRelations, reassessment });
  const group = POPULATION_GROUPS[talks.dimension][talks.group];
  const demand = talks.requested === "autonomous" ? "local control of institutions" : "institutional protection";
  if (!accepted) {
    (talks.foreignRefusals ??= {})[sponsor.id] = now + REFUSAL_COOLDOWN;
    world.instrumentation?.incrementCounter("foreignAdvocacy.refused");
    recordSimulationEvent(world, { category: "politics", nationIds: [sponsor.id, owner.id],
      message: `${sponsor.id} offered support for the ${group} demand in district ${id} (${owner.id}); the movement declined. ${describeSupportDecision(decision)}` });
    return;
  }
  const backing: ForeignBacking = {
    sponsorId: sponsor.id, strength: offer.strength, backlash, since: now,
    renewAt: now + ADVOCACY_RENEWAL_INTERVAL,
  };
  talks.foreign = backing;
  if (sponsor.politics) sponsor.politics.nextForeignAdvocacyAt = now + SPONSOR_COOLDOWN;
  world.instrumentation?.incrementCounter("foreignAdvocacy.accepted");
  recordSimulationEvent(world, { category: "politics", nationIds: [sponsor.id, owner.id],
    message: `${sponsor.id} recognized the ${group} demand for ${demand} in district ${id} (${owner.id}). The movement accepted the diplomatic backing. ${describeSupportDecision(decision)}` });
}

// The first failure preserves the production screening order. Diagnostics can
// continue through the same checks to distinguish simultaneous blockers.
function* sponsorBlockers(world: WorldState, owner: NationRuntime, sponsor: NationRuntime,
  talks: RegionalNegotiation, sponsorships: ReadonlyMap<NationId, number>, readOnly: boolean): Generator<ForeignAdvocacyExclusion> {
  const now = world.time.slowTick;
  const sponsorId = sponsor.id;
  if (!isNationActive(sponsor)) yield "sponsorInactive";
  if (talks.foreign?.sponsorId === sponsorId) yield "alreadySupported";
  if (findWar(world.wars, sponsorId, owner.id) || getRelation(world, sponsorId, owner.id, readOnly).crisis) yield "warOrCrisis";
  if (getSubjectOverlord(world, sponsorId) === owner.id || getSubjectOverlord(world, owner.id) === sponsorId) yield "subjectRelationship";
  if ((sponsorships.get(sponsorId) ?? 0) >= MAX_ACTIVE_PER_SPONSOR) yield "capacity";
  if ((sponsor.politics?.nextForeignAdvocacyAt ?? 0) > now) yield "cooldown";
  if ((talks.foreignRefusals?.[sponsorId] ?? 0) > now) yield "previousRefusal";
}

function buildOffer(world: WorldState, id: MesoRegionId, talks: RegionalNegotiation, owner: NationRuntime,
  sponsor: NationRuntime, interest: Interest, influence: number, readOnly = false): AdvocacyOffer {
  const character = getNationCharacter(world, sponsor.id, readOnly);
  const credibility = clamp(0.15 + influence / 250 + getRelation(world, sponsor.id, owner.id, readOnly).trust / 250 +
    character.cooperation * 0.2, 0, 1);
  const strength = clamp(0.2 + interest.score * 0.55 + credibility * 0.35 - interest.treatyCost * 0.25, 0.05, 0.85);
  const backlash = repudiation(world, talks, owner, sponsor, interest, readOnly);
  return { id, owner, sponsor, talks, strength, backlash, interest };
}

export interface AdvocacyEligibility {
  blockers: ForeignAdvocacyExclusion[];
  score: number;
  factors?: Record<string, number>;
  influence: number;
  movement: "willing" | "domesticSettlement" | "movementRejected";
}

export function inspectAdvocacyCandidate(world: WorldState, id: MesoRegionId, talks: RegionalNegotiation,
  owner: NationRuntime, sponsor: NationRuntime, sponsorships: ReadonlyMap<NationId, number>): AdvocacyEligibility {
  const blockers = [...sponsorBlockers(world, owner, sponsor, talks, sponsorships, true)];
  const interest = evaluateInterest(world, id, talks, owner, sponsor, true);
  const influence = getInfluence(world, sponsor.id, true);
  if (interest.score < INTEREST_THRESHOLD) blockers.push("interest");
  if (influence < ADVOCACY_INFLUENCE_REQUIRED) blockers.push("influence");
  if (talks.foreign && !blockers.includes("alreadySupported")) blockers.push("alreadySupported");
  const { strength, backlash } = buildOffer(world, id, talks, owner, sponsor, interest, influence, true);
  const decision = evaluateMovementSupport(world, id, talks, owner, sponsor, strength, backlash, interest, true);
  return { blockers, score: interest.score, factors: interest.factors, influence,
    movement: decision.domesticPath ? "domesticSettlement" : decision.accepted ? "willing" : "movementRejected" };
}

const rejectionCounters = {
  alreadySupported: "relation", warOrCrisis: "relation", subjectRelationship: "relation",
  capacity: "cooldown", cooldown: "cooldown", previousRefusal: "cooldown", interest: "interest", influence: "cost",
} as const;

export type AdvocacySelection = ReadonlyMap<MesoRegionId, {
  talks: RegionalNegotiation;
  sponsors: ReadonlySet<NationId>;
}>;

function candidates(world: WorldState, contacts: ReadonlyMap<NationId, ReadonlySet<NationId>>,
  negotiations: readonly [MesoRegionId, RegionalNegotiation][], sponsorships: ReadonlyMap<NationId, number>,
  selection?: AdvocacySelection) {
  const nations = new Map(world.nations.map((nation) => [nation.id, nation]));
  const instrumentation = world.instrumentation;
  const rejected = { interest: 0, cost: 0, relation: 0, cooldown: 0 };
  const offers = new Map<MesoRegionId, AdvocacyOffer[]>();
  for (const [id, talks] of negotiations) {
    const selected = selection?.get(id);
    if (selection && selected?.talks !== talks) continue;
    const exclude = (reason: ForeignAdvocacyExclusion, count = true) => {
      instrumentation?.incrementCounter(`foreignAdvocacy.excluded.${reason}`);
      instrumentation?.observeRegionalAdvocacy?.({ kind: "excluded", id, talks, reason });
      const key = rejectionCounters[reason as keyof typeof rejectionCounters];
      if (count && key) rejected[key]++;
    };
    instrumentation?.observeRegionalAdvocacy?.({ kind: "screened", id, talks });
    const owner = nations.get(talks.owner);
    if (!owner || !isNationActive(owner)) {
      exclude("targetInactive");
      continue;
    }
    const partners = contacts.get(owner.id);
    if (!partners?.size) {
      exclude("noContact");
      continue;
    }
    for (const sponsorId of [...partners].sort()) {
      if (sponsorId === owner.id || (selected && !selected.sponsors.has(sponsorId))) continue;
      const sponsor = nations.get(sponsorId);
      if (!sponsor || !isNationActive(sponsor)) {
        exclude("sponsorInactive");
        continue;
      }
      instrumentation?.incrementCounter("foreignAdvocacy.candidates");
      const blocker = sponsorBlockers(world, owner, sponsor, talks, sponsorships, false).next();
      if (!blocker.done) {
        exclude(blocker.value);
        continue;
      }
      const interest = evaluateInterest(world, id, talks, owner, sponsor);
      if (interest.score < INTEREST_THRESHOLD) {
        exclude("interest");
        continue;
      }
      const influence = getInfluence(world, sponsorId);
      if (influence < ADVOCACY_INFLUENCE_REQUIRED) {
        exclude("influence");
        continue;
      }
      const list = offers.get(id);
      const offer = buildOffer(world, id, talks, owner, sponsor, interest, influence);
      if (!talks.foreign) {
        instrumentation?.incrementCounter("foreignAdvocacy.eligible");
        instrumentation?.observeRegionalAdvocacy?.({ kind: "eligible", id, talks });
      } else exclude("alreadySupported", false);
      if (list) list.push(offer);
      else offers.set(id, [offer]);
    }
  }
  for (const key of Object.keys(rejected) as (keyof typeof rejected)[]) {
    if (rejected[key]) instrumentation?.incrementCounter(`foreignAdvocacy.rejected.${key}`, rejected[key]);
  }
  return offers;
}

/** Sponsor renewal, withdrawal, and the gradual decay of political backing. */
export function updateForeignBacking(world: WorldState): void {
  for (const [id, talks] of liveNegotiations(world)) {
    const backing = talks.foreign;
    if (!backing) continue;
    backing.strength *= BACKING_DECAY;
    if (backing.strength < MINIMUM_BACKING) {
      endBacking(world, id, talks, "The commitment lapsed without renewal.");
      continue;
    }
    if (world.time.slowTick < backing.renewAt) continue;
    const sponsor = world.nations.find((nation) => nation.id === backing.sponsorId);
    if (!sponsor || !isNationActive(sponsor)) {
      endBacking(world, id, talks, "The sponsoring government is no longer in a position to continue.");
      continue;
    }
    const owner = world.nations.find((nation) => nation.id === talks.owner);
    if (!owner || !isNationActive(owner)) {
      endBacking(world, id, talks, "The target government has changed.");
      continue;
    }
    const interest = evaluateInterest(world, id, talks, owner, sponsor);
    if (interest.score < INTEREST_THRESHOLD * 0.8 || !spendInfluence(world, sponsor.id, POLITICAL_ADVOCACY_RENEWAL_COST)) {
      endBacking(world, id, talks, interest.score < INTEREST_THRESHOLD * 0.8 ?
        "The sponsor's interest in the dispute faded." : "The sponsor could not sustain the diplomatic cost.");
      continue;
    }
    backing.strength = clamp(backing.strength + 0.25, 0, 0.9);
    backing.renewAt = world.time.slowTick + ADVOCACY_RENEWAL_INTERVAL;
    world.instrumentation?.incrementCounter("foreignAdvocacy.renewed");
    recordSimulationEvent(world, { category: "diplomacy", nationIds: [sponsor.id, owner.id],
      message: `${sponsor.id} renewed its diplomatic support for the demand in district ${id} (${owner.id}).` });
  }
}

/**
 * Governments consider whether to recognize an existing regional demand. Only
 * movements that already mobilized can be supported; influence cannot create one.
 */
export function updatePoliticalAdvocacy(world: WorldState, contacts: ReadonlyMap<NationId, ReadonlySet<NationId>>,
  negotiations = liveNegotiations(world), selection?: AdvocacySelection): void {
  if (!hasPoliticalTurbulence(world) || getWarDeclarationMode(world) !== "diplomacy") return;
  const now = world.time.slowTick;
  if (now < FIRST_FOREIGN_ADVOCACY_TICK || !negotiations.length) return;
  // Successful commitments update this cycle's availability immediately.
  const sponsorships = activeSponsorships(world);
  const offers = candidates(world, contacts, negotiations, sponsorships, selection);
  for (const [id, list] of [...offers].sort((a, b) => a[0].localeCompare(b[0]))) {
    const talks = list[0]!.talks;
    if (talks.foreign) continue;
    // Candidates are already ordered by sponsor id; pick the sponsor the movement values most.
    const ranked = list.map((offer) => ({ offer,
      decision: evaluateMovementSupport(world, id, talks, offer.owner, offer.sponsor,
        offer.strength, offer.backlash, offer.interest) }))
      .sort((a, b) => (b.decision.value - b.decision.cost) - (a.decision.value - a.decision.cost) ||
        a.offer.sponsor.id.localeCompare(b.offer.sponsor.id));
    // Prefer a sponsor the movement would accept. If none would be accepted, still make
    // the single best offer so a refusal is recorded honestly rather than silently skipped.
    const willing = ranked.filter(({ decision }) => decision.accepted);
    const ordered = willing.length ? willing : ranked.slice(0, 1);
    const best = ordered.find(({ offer }) => canCommitNow(world, offer, now, sponsorships));
    if (!best) {
      world.instrumentation?.incrementCounter("foreignAdvocacy.skipped.stale");
      continue;
    }
    world.instrumentation?.incrementCounter("foreignAdvocacy.proposals");
    if (!spendInfluence(world, best.offer.sponsor.id, POLITICAL_ADVOCACY_COST)) {
      world.instrumentation?.incrementCounter("foreignAdvocacy.rejected.spend");
      continue;
    }
    applyAdvocacy(world, best.offer, best.decision.accepted, best.decision, now, !!selection);
    if (best.decision.accepted) {
      sponsorships.set(best.offer.sponsor.id, (sponsorships.get(best.offer.sponsor.id) ?? 0) + 1);
    }
  }
}

