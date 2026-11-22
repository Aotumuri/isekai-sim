import assert from "node:assert/strict";
import test from "node:test";
import { getDiplomacyState, getInfluence, getRelation } from "../../src/sim/diplomacy";
import { getRegionalIdentityGrievance, grievanceLevel } from "../../src/sim/identity-grievances";
import { updatePopulationPolitics } from "../../src/sim/population-politics";
import { getNationalPolitics } from "../../src/sim/politics";
import {
  getPoliticalContacts,
  launchPoliticalCampaign,
  updateForeignPoliticalInfluence,
} from "../../src/sim/political-influence";
import {
  ADVOCACY_RENEWAL_INTERVAL,
  MAX_ACTIVE_PER_SPONSOR,
  POLITICAL_ADVOCACY_COST,
  describeSupportDecision,
  evaluateMovementSupport,
  updateForeignBacking,
  updatePoliticalAdvocacy,
} from "../../src/sim/political-advocacy";
import { createFaction, joinFaction } from "../../src/sim/factions";
import { getNationIdeology } from "../../src/sim/nation-identity";
import {
  getRegionalMandate,
  openRegionalNegotiation,
  reviewRegionalNegotiation,
  type RegionalNegotiation,
} from "../../src/sim/regional-negotiations";
import { installSubjectGovernment } from "../../src/sim/subject-governments";
import { updateSubjectAutonomy } from "../../src/sim/subject-autonomy";
import { updateTerritorialGovernance } from "../../src/sim/territorial-governance";
import { getOwnerByMesoId } from "../../src/sim/world-cache";
import { getAdjacentNationPairs } from "../../src/sim/world-cache";
import { createFixedSocietyWorld, fixedSocietyDistrict } from "../helpers/fixed-society-world";

const district = fixedSocietyDistrict(3, 1);

/** Target nation A, neighbour B, sponsor C, and a fourth government D. */
function scene({ cooperation = 0.9, ideology = "capitalism", exclude = true } = {}) {
  const world = createFixedSocietyWorld();
  world.settings!.politicalTurbulenceEnabled = true;
  updatePopulationPolitics(world);
  const [target, rival, sponsor, fourth] = world.nations;
  target.character = { doctrine: "merchant", cooperation, aggression: 0.25, innovation: 0.5, thrift: 0.85 };
  const cabinet = getNationalPolitics(world, target);
  getNationalPolitics(world, sponsor);
  cabinet.governingIdeologyId = ideology;
  cabinet.system = "monarchy";
  cabinet.support.set(ideology, 80);
  const government = target.identityGovernment!;
  government.nextReviewAt = Infinity;
  government.favored.culture = "reed-courts";
  const sponsorIdentity = sponsor.identityGovernment!;
  sponsorIdentity.nextReviewAt = Infinity;
  sponsorIdentity.favored.culture = "tide-guilds";
  if (exclude) government.treatments.culture["tide-guilds"] = "assimilation";
  for (const [id, population] of world.regionalPopulations!) {
    if (getOwnerByMesoId(world).get(id) === target.id) population.culture = [population.size, 0, 0, 0, 0, 0];
  }
  const population = world.regionalPopulations!.get(district)!;
  population.culture = [population.size * 0.1, population.size * 0.9, 0, 0, 0, 0];
  const at = (tick: number) => {
    world.time.slowTick = tick;
    world.time.fastTick = tick * 10;
    updateTerritorialGovernance(world);
  };
  const talks = () => world.regionalNegotiations?.get(district);
  const grievance = () => grievanceLevel(getRegionalIdentityGrievance(world, district, target.id));
  return { world, target, rival, sponsor, fourth, government, population, at, talks, grievance };
}

/** Build a real grievance memory, then open a live demand at a tick foreign evaluation can use. */
function openDemand(s: ReturnType<typeof scene>) {
  // Stop before the domestic process settles the demand, so the grievance is still live.
  for (let tick = 10; tick <= 30; tick += 10) s.at(tick);
  assert.ok(s.grievance() >= 0.12, "the scene must produce a genuine local grievance");
  const memory = getRegionalIdentityGrievance(s.world, district, s.target.id)!;
  const mandate = getRegionalMandate(s.population, memory);
  assert.ok(mandate, "the grievance must support a regional demand");
  // Start from one live demand with a controlled review schedule.
  s.world.regionalNegotiations?.delete(district);
  s.world.time.slowTick = 300;
  s.world.time.fastTick = 3000;
  openRegionalNegotiation(s.world, s.target, district, mandate);
  return s.talks() as RegionalNegotiation;
}

function sponsorFinance(world: ReturnType<typeof scene>["world"], sponsorId: string, amount = 90) {
  getDiplomacyState(world).influenceByNationId.set(sponsorId as never, amount);
}

function expectContact(s: ReturnType<typeof scene>) {
  assert.ok(getAdjacentNationPairs(s.world).some(([a, b]) =>
    a === s.target.id && b === s.sponsor.id || b === s.target.id && a === s.sponsor.id));
}

test("a government recognizes an existing demand with genuine local support", () => {
  const s = scene();
  expectContact(s);
  const talks = openDemand(s);
  sponsorFinance(s.world, s.sponsor.id);
  getRelation(s.world, s.sponsor.id, s.target.id).trust = 60;
  const before = getInfluence(s.world, s.sponsor.id);
  const tension = getRelation(s.world, s.sponsor.id, s.target.id).tension;
  updatePoliticalAdvocacy(s.world, getPoliticalContacts(s.world));
  assert.equal(talks.foreign?.sponsorId, s.sponsor.id);
  assert.ok((talks.foreign?.strength ?? 0) > 0.2);
  assert.equal(getInfluence(s.world, s.sponsor.id), before - POLITICAL_ADVOCACY_COST);
  assert(getRelation(s.world, s.sponsor.id, s.target.id).tension > tension);
  assert.equal(talks.requested, "autonomous");
  assert(s.world.events?.some(({ message }) => message.includes("recognized the Tide Guilds demand") &&
    message.includes("accepted the diplomatic backing")));
});

test("a region without a real grievance never becomes a diplomatic opportunity", () => {
  const s = scene({ exclude: false });
  for (let tick = 10; tick <= 400; tick += 10) s.at(tick);
  assert.equal(s.talks(), undefined);
  sponsorFinance(s.world, s.sponsor.id);
  const before = getInfluence(s.world, s.sponsor.id);
  updatePoliticalAdvocacy(s.world, getPoliticalContacts(s.world));
  assert.equal(s.talks(), undefined);
  assert.equal(getInfluence(s.world, s.sponsor.id), before);
});

test("a movement prefers a credible domestic settlement and refuses outside support", () => {
  const s = scene();
  const talks = openDemand(s);
  sponsorFinance(s.world, s.sponsor.id);
  const relation = getRelation(s.world, s.sponsor.id, s.target.id);
  relation.trust = 60;
  relation.opinion = 40;
  // The cabinet has already offered everything the movement asked for.
  talks.status = "offer";
  talks.offer = talks.requested;
  const before = getInfluence(s.world, s.sponsor.id);
  updatePoliticalAdvocacy(s.world, getPoliticalContacts(s.world));
  assert.equal(talks.foreign, undefined);
  assert.ok((talks.foreignRefusals?.[s.sponsor.id] ?? 0) > s.world.time.slowTick);
  assert.equal(getInfluence(s.world, s.sponsor.id), before - POLITICAL_ADVOCACY_COST);
  const decision = evaluateMovementSupport(s.world, district, talks, s.target, s.sponsor, 0.5, 0.4,
    { score: 0.5, kinship: 1, share: 0.9, treatyCost: 0, subjectOverlordCost: 0 });
  assert.equal(decision.domesticPath, true);
  assert.equal(decision.accepted, false);
  assert(s.world.events?.some(({ message }) => message.includes("the movement declined")));
});

test("advocacy changes diplomatic relations without rewriting domestic policy", () => {
  const s = scene();
  const talks = openDemand(s);
  sponsorFinance(s.world, s.sponsor.id);
  const relation = getRelation(s.world, s.sponsor.id, s.target.id);
  relation.trust = 60;
  relation.opinion = 20;
  const tension = relation.tension, trust = relation.trust;
  const populations = [...s.world.regionalPopulations!.values()].map((population) => structuredClone(population));
  const owners = new Map(getOwnerByMesoId(s.world));
  updatePoliticalAdvocacy(s.world, getPoliticalContacts(s.world));
  assert.ok(relation.tension > tension);
  assert.ok(relation.trust < trust);
  assert.equal(s.government.treatments.culture["tide-guilds"], "assimilation");
  assert.deepEqual([...s.world.regionalPopulations!.values()], populations);
  assert.deepEqual(new Map(getOwnerByMesoId(s.world)), owners);
});

test("the domestic government still decides: a cohesionist cabinet can refuse despite recognition", () => {
  const s = scene({ cooperation: 0.49, ideology: "cohesionism" });
  const talks = openDemand(s);
  sponsorFinance(s.world, s.sponsor.id);
  getRelation(s.world, s.sponsor.id, s.target.id).trust = 60;
  updatePoliticalAdvocacy(s.world, getPoliticalContacts(s.world));
  assert.equal(talks.foreign?.sponsorId, s.sponsor.id);
  s.at(310);
  assert.equal(talks.status, "rejected");
  assert.match(talks.reason, /uniform institutions/);
  assert.equal(s.talks()?.offer, undefined);
});

test("recognized support can raise the cabinet's offer but never sets the outcome", () => {
  const s = scene({ cooperation: 0.49 });
  const talks = openDemand(s);
  sponsorFinance(s.world, s.sponsor.id);
  getRelation(s.world, s.sponsor.id, s.target.id).trust = 60;
  updatePoliticalAdvocacy(s.world, getPoliticalContacts(s.world));
  assert.ok(talks.foreign);
  const counters: Record<string, number> = {};
  s.world.instrumentation = {
    recordDuration() {},
    incrementCounter(name) { counters[name] = (counters[name] ?? 0) + 1; },
  };
  s.at(310);
  s.world.instrumentation = undefined;
  assert.equal(talks.status, "offer");
  assert.equal(talks.offer, talks.requested);
  assert.match(talks.reason, /International recognition/);
  assert.ok((counters["foreignAdvocacy.negotiationReviewsWithBacking"] ?? 0) >= 1);
  assert.ok((counters["foreignAdvocacy.decisionsChanged"] ?? 0) >= 1,
    "the counterfactual comparison identifies that backing changed this decision");
  s.at(320);
  assert.equal(talks.status, "agreed");
  assert.equal(talks.foreign, undefined, "a domestic agreement ends the outside involvement");
});

test("a sponsor that loses interest or influence withdraws its support", () => {
  const s = scene();
  const talks = openDemand(s);
  sponsorFinance(s.world, s.sponsor.id, 44);
  getRelation(s.world, s.sponsor.id, s.target.id).trust = 60;
  updatePoliticalAdvocacy(s.world, getPoliticalContacts(s.world));
  assert.ok(talks.foreign);
  // Another government is no longer interested in this community.
  s.sponsor.identityGovernment!.favored.culture = "reed-courts";
  s.world.time.slowTick = talks.foreign!.renewAt;
  updateForeignBacking(s.world);
  assert.equal(talks.foreign, undefined);
  assert(s.world.events?.some(({ message }) => message.includes("interest in the dispute faded")));
});

test("support lapses without renewal instead of accumulating forever", () => {
  const s = scene();
  const talks = openDemand(s);
  sponsorFinance(s.world, s.sponsor.id, 90);
  getRelation(s.world, s.sponsor.id, s.target.id).trust = 60;
  updatePoliticalAdvocacy(s.world, getPoliticalContacts(s.world));
  const start = talks.foreign!.strength;
  s.world.time.slowTick = 300 + ADVOCACY_RENEWAL_INTERVAL * 3;
  for (let step = 0; step < 40; step++) updateForeignBacking(s.world);
  assert.ok((talks.foreign?.strength ?? 0) < start);
  s.sponsor.identityGovernment!.favored.culture = "reed-courts";
  s.world.time.slowTick = talks.foreign?.renewAt ?? s.world.time.slowTick + 1;
  updateForeignBacking(s.world);
  assert.equal(talks.foreign, undefined);
});

test("shared identity makes a sponsor welcome, not controlling", () => {
  const s = scene();
  const talks = openDemand(s);
  const interest = { score: 0.6, kinship: 1, share: 0.9, treatyCost: 0, subjectOverlordCost: 0 };
  const accepted = evaluateMovementSupport(s.world, district, talks, s.target, s.sponsor, 0.6, 0.3, interest);
  assert.equal(accepted.accepted, true);
  // The same kin sponsor is still refused when association would cost local legitimacy.
  const refused = evaluateMovementSupport(s.world, district, talks, s.target, s.sponsor, 0.25, 0.95, interest);
  assert.equal(refused.accepted, false);
  assert.match(describeSupportDecision(refused), /weak local cause|cost more local legitimacy/);
  // Recognition never changes what the movement asks for.
  assert.equal(talks.requested, "autonomous");
  assert.equal(talks.status, "demand");
});

test("competing sponsors are resolved deterministically without double spending", () => {
  const run = () => {
    const s = scene();
    const talks = openDemand(s);
    // Both neighbours become sponsors with a kinship tie to the movement.
    for (const id of [s.rival.id, s.sponsor.id]) {
      const nation = s.world.nations.find((item) => item.id === id)!;
      nation.identityGovernment!.favored.culture = "tide-guilds";
      nation.identityGovernment!.nextReviewAt = Infinity;
      sponsorFinance(s.world, id, 90);
      getRelation(s.world, id, s.target.id).trust = 60;
    }
    updatePoliticalAdvocacy(s.world, getPoliticalContacts(s.world));
    return {
      sponsor: talks.foreign?.sponsorId,
      strengths: [s.rival.id, s.sponsor.id].map((id) => getInfluence(s.world, id)),
      talks: { ...talks },
    };
  };
  const first = run(), second = run();
  assert.ok(first.sponsor);
  assert.deepEqual(first, second);
  const charged = first.strengths.filter((value) => value === 90 - POLITICAL_ADVOCACY_COST).length;
  assert.equal(charged, 1, "only the accepted sponsor pays influence");
});

test("a second evaluation in the same cycle neither re-charges nor repeats the offer", () => {
  const s = scene();
  const talks = openDemand(s);
  sponsorFinance(s.world, s.sponsor.id);
  getRelation(s.world, s.sponsor.id, s.target.id).trust = 60;
  updatePoliticalAdvocacy(s.world, getPoliticalContacts(s.world));
  const backing = talks.foreign;
  updatePoliticalAdvocacy(s.world, getPoliticalContacts(s.world));
  assert.equal(talks.foreign, backing);
  assert.equal(getInfluence(s.world, s.sponsor.id), 90 - POLITICAL_ADVOCACY_COST);
});

test("a movement that turned a sponsor down is not asked again every cycle", () => {
  const s = scene();
  const talks = openDemand(s);
  sponsorFinance(s.world, s.sponsor.id);
  const relation = getRelation(s.world, s.sponsor.id, s.target.id);
  relation.trust = 60;
  relation.opinion = 40;
  talks.status = "offer";
  talks.offer = talks.requested;
  updatePoliticalAdvocacy(s.world, getPoliticalContacts(s.world));
  const after = getInfluence(s.world, s.sponsor.id);
  assert.equal(talks.foreign, undefined);
  s.sponsor.politics!.nextForeignAdvocacyAt = 0;
  updatePoliticalAdvocacy(s.world, getPoliticalContacts(s.world));
  assert.equal(getInfluence(s.world, s.sponsor.id), after, "the refusal window blocks a repeat");
});

test("support disappears safely when the target demand or government is gone", () => {
  const s = scene();
  const talks = openDemand(s);
  sponsorFinance(s.world, s.sponsor.id);
  getRelation(s.world, s.sponsor.id, s.target.id).trust = 60;
  updatePoliticalAdvocacy(s.world, getPoliticalContacts(s.world));
  const before = getInfluence(s.world, s.sponsor.id);
  s.world.regionalNegotiations!.delete(district);
  updateForeignBacking(s.world);
  updatePoliticalAdvocacy(s.world, getPoliticalContacts(s.world));
  assert.equal(getInfluence(s.world, s.sponsor.id), before);
});

test("a subject balances overlord, local demand and an outside sponsor", () => {
  const s = scene();
  installSubjectGovernment(s.world, s.fourth.id, s.target.id);
  s.world.nations.find(({ id }) => id === s.target.id)!.subjectGovernment!.autonomy = 40;
  const talks = openDemand(s);
  sponsorFinance(s.world, s.sponsor.id);
  getRelation(s.world, s.sponsor.id, s.target.id).trust = 60;
  const overlordRelation = getRelation(s.world, s.fourth.id, s.sponsor.id);
  const tension = overlordRelation.tension;
  updatePoliticalAdvocacy(s.world, getPoliticalContacts(s.world));
  assert.equal(talks.foreign?.sponsorId, s.sponsor.id);
  assert.ok(overlordRelation.tension > tension, "the overlord reacts to outside involvement in its subject");
  const subject = s.world.nations.find(({ id }) => id === s.target.id)!;
  const government = subject.subjectGovernment!;
  const autonomy = government.autonomy ?? 0;
  s.at(310);
  updateSubjectAutonomy(s.world);
  assert.equal(subject.subjectGovernment?.overlordId, s.fourth.id, "support does not dissolve the subject relationship");
  assert.ok((government.autonomy ?? 0) >= 0);
  assert.ok(Math.abs((government.autonomy ?? 0) - autonomy) < 100);
  assert.equal(talks.requested, "autonomous", "the movement keeps its own objective");
});

test("existing ideological influence still runs through the combined update", () => {
  const s = scene();
  const politics = getNationalPolitics(s.world, s.target);
  politics.governingIdeologyId = "communism";
  s.target.ideologyId = "communism";
  s.sponsor.ideologyId = "capitalism";
  getNationalPolitics(s.world, s.sponsor).governingIdeologyId = "capitalism";
  sponsorFinance(s.world, s.sponsor.id, 90);
  s.world.time.slowTick = 300;
  s.world.time.fastTick = 3000;
  updateForeignPoliticalInfluence(s.world);
  const support = politics.support.get("capitalism") ?? 0;
  assert.ok(support > 0);
  assert.ok(launchPoliticalCampaign(s.world, s.sponsor.id, s.target.id) === false ||
    getInfluence(s.world, s.sponsor.id) < 90);
});

test("foreign evaluation is bounded by diplomatic contact, not by world size", () => {
  const s = scene();
  openDemand(s);
  for (const nation of s.world.nations) sponsorFinance(s.world, nation.id, 90);
  const counters: Record<string, number> = {};
  s.world.instrumentation = {
    recordDuration() {},
    incrementCounter(name) { counters[name] = (counters[name] ?? 0) + 1; },
  };
  updatePoliticalAdvocacy(s.world, getPoliticalContacts(s.world));
  const contacts = getPoliticalContacts(s.world);
  const degree = [...contacts.values()].reduce((sum, set) => sum + set.size, 0);
  assert.ok((counters["foreignAdvocacy.candidates"] ?? 0) <= degree);
  s.world.instrumentation = undefined;
});

test("nationalist and revolutionary systems keep working around a backed demand", () => {
  const s = scene();
  const talks = openDemand(s);
  sponsorFinance(s.world, s.sponsor.id);
  getRelation(s.world, s.sponsor.id, s.target.id).trust = 60;
  updatePoliticalAdvocacy(s.world, getPoliticalContacts(s.world));
  s.at(310);
  s.at(320);
  s.at(330);
  assert.ok(talks.status === "offer" || talks.status === "agreed" || talks.status === "rejected");
  assert.equal(s.target.nationalistMovement, undefined);
  assert.equal(s.target.identityStability?.legitimacy !== undefined, true);
});

/** Give several target-owned districts the same grievance-producing population. */
function openDemands(s: ReturnType<typeof scene>, ids: ReturnType<typeof fixedSocietyDistrict>[]) {
  for (const id of ids) {
    const population = s.world.regionalPopulations!.get(id)!;
    population.culture = [population.size * 0.1, population.size * 0.9, 0, 0, 0, 0];
  }
  for (let tick = 10; tick <= 30; tick += 10) s.at(tick);
  const mandates = ids.map((id) => {
    const memory = getRegionalIdentityGrievance(s.world, id, s.target.id);
    assert.ok(memory, `district ${id} must build a genuine grievance`);
    const mandate = getRegionalMandate(s.world.regionalPopulations!.get(id)!, memory);
    assert.ok(mandate, `district ${id} must support a regional demand`);
    return { id, mandate };
  });
  s.world.regionalNegotiations?.clear();
  s.world.time.slowTick = 300;
  s.world.time.fastTick = 3000;
  for (const { id, mandate } of mandates) openRegionalNegotiation(s.world, s.target, id, mandate);
  return mandates.map(({ id }) => s.world.regionalNegotiations!.get(id)!);
}

function commitCount(s: ReturnType<typeof scene>) {
  return [...s.world.regionalNegotiations?.values() ?? []]
    .filter(({ foreign }) => foreign?.sponsorId === s.sponsor.id).length;
}

test("a sponsor cannot exceed its commitment limit within one evaluation cycle", () => {
  const s = scene();
  const demands = openDemands(s, [
    fixedSocietyDistrict(1, 1), fixedSocietyDistrict(2, 1), fixedSocietyDistrict(4, 1),
  ]);
  sponsorFinance(s.world, s.sponsor.id, 90);
  getRelation(s.world, s.sponsor.id, s.target.id).trust = 60;
  const counters: Record<string, number> = {};
  s.world.instrumentation = {
    recordDuration() {},
    incrementCounter(name) { counters[name] = (counters[name] ?? 0) + 1; },
  };
  const before = getInfluence(s.world, s.sponsor.id);
  updatePoliticalAdvocacy(s.world, getPoliticalContacts(s.world));
  s.world.instrumentation = undefined;
  assert.equal(commitCount(s), 1, "the sponsor cooldown limits it to one new commitment per cycle");
  assert.ok(commitCount(s) <= MAX_ACTIVE_PER_SPONSOR);
  assert.equal(getInfluence(s.world, s.sponsor.id), before - POLITICAL_ADVOCACY_COST,
    "influence is charged once, not once per stale candidate");
  assert.equal(counters["foreignAdvocacy.accepted"] ?? 0, 1);
  assert.ok((counters["foreignAdvocacy.skipped.stale"] ?? 0) >= 1,
    "the remaining stale candidates are rejected by revalidation");
  assert.equal(demands.filter(({ foreign }) => foreign).length, 1);
});

test("the per-sponsor commitment limit holds across cycles", () => {
  const s = scene();
  openDemands(s, [fixedSocietyDistrict(1, 1), fixedSocietyDistrict(2, 1), fixedSocietyDistrict(4, 1)]);
  sponsorFinance(s.world, s.sponsor.id, 90);
  getRelation(s.world, s.sponsor.id, s.target.id).trust = 60;
  updatePoliticalAdvocacy(s.world, getPoliticalContacts(s.world));
  assert.equal(commitCount(s), 1);
  // Let the sponsor's own cooldown expire while the second demand is still open.
  s.sponsor.politics!.nextForeignAdvocacyAt = 0;
  s.world.time.slowTick = 360;
  s.world.time.fastTick = 3600;
  updatePoliticalAdvocacy(s.world, getPoliticalContacts(s.world));
  assert.equal(commitCount(s), MAX_ACTIVE_PER_SPONSOR);
  // Even with no cooldown, the hard limit blocks a third commitment.
  s.sponsor.politics!.nextForeignAdvocacyAt = 0;
  s.world.time.slowTick = 420;
  s.world.time.fastTick = 4200;
  const before = getInfluence(s.world, s.sponsor.id);
  updatePoliticalAdvocacy(s.world, getPoliticalContacts(s.world));
  assert.equal(commitCount(s), MAX_ACTIVE_PER_SPONSOR);
  assert.equal(getInfluence(s.world, s.sponsor.id), before, "a blocked sponsor spends nothing");
});

test("a same-cycle refusal is recorded once and does not block a distinct commitment", () => {
  const s = scene();
  const [refused, accepted] = openDemands(s, [fixedSocietyDistrict(1, 1), fixedSocietyDistrict(2, 1)]);
  refused.status = "offer";
  refused.offer = refused.requested;
  sponsorFinance(s.world, s.sponsor.id, 90);
  const relation = getRelation(s.world, s.sponsor.id, s.target.id);
  relation.trust = 60;
  relation.opinion = 40;
  updatePoliticalAdvocacy(s.world, getPoliticalContacts(s.world));
  assert.equal(refused.foreign, undefined);
  assert.ok((refused.foreignRefusals?.[s.sponsor.id] ?? 0) > s.world.time.slowTick);
  assert.equal(accepted.foreign?.sponsorId, s.sponsor.id,
    "a refusal does not consume the sponsor's cooldown for a different movement");
  assert.equal(getInfluence(s.world, s.sponsor.id), 90 - 2 * POLITICAL_ADVOCACY_COST,
    "each proposal is charged exactly once");
});

test("multi-demand sponsorship is deterministic", () => {
  const run = () => {
    const s = scene();
    const demands = openDemands(s, [
      fixedSocietyDistrict(1, 1), fixedSocietyDistrict(2, 1), fixedSocietyDistrict(4, 1),
    ]);
    sponsorFinance(s.world, s.sponsor.id, 90);
    getRelation(s.world, s.sponsor.id, s.target.id).trust = 60;
    updatePoliticalAdvocacy(s.world, getPoliticalContacts(s.world));
    return {
      committed: demands.map(({ foreign }) => foreign?.sponsorId ?? null),
      influence: getInfluence(s.world, s.sponsor.id),
    };
  };
  assert.deepEqual(run(), run());
});

test("nonadjacent faction members are political contacts and can sponsor a demand", () => {
  const s = scene();
  const relation = getRelation(s.world, s.target.id, s.fourth.id);
  relation.opinion = 60;
  relation.trust = 80;
  sponsorFinance(s.world, s.target.id, 90);
  sponsorFinance(s.world, s.fourth.id, 90);
  const allowed = [...new Set([getNationIdeology(s.world, s.target.id).id, getNationIdeology(s.world, s.fourth.id).id])];
  const faction = createFaction(s.world, s.target.id, {
    allowedIdeologyIds: allowed, defensiveObligation: "mandatory", offensiveObligation: "none", considerPersonality: true,
  });
  assert.ok(faction, "the founder must be able to form a faction");
  assert.equal(joinFaction(s.world, s.fourth.id, faction!.id), true);
  assert.ok(!getAdjacentNationPairs(s.world).some(([a, b]) =>
    (a === s.target.id && b === s.fourth.id) || (b === s.target.id && a === s.fourth.id)),
    "the two members share no border");
  const contacts = getPoliticalContacts(s.world);
  assert.ok(contacts.get(s.target.id)?.has(s.fourth.id), "the faction is a two-way contact");
  assert.ok(contacts.get(s.fourth.id)?.has(s.target.id));
  assert.ok(!contacts.get(s.rival.id)?.has(s.sponsor.id), "unrelated nonadjacent countries stay excluded");
  // The fourth government can now discover and support the demand without a border.
  s.fourth.identityGovernment!.nextReviewAt = Infinity;
  s.fourth.identityGovernment!.favored.culture = "tide-guilds";
  const talks = openDemand(s);
  getRelation(s.world, s.fourth.id, s.target.id).trust = 60;
  updatePoliticalAdvocacy(s.world, getPoliticalContacts(s.world));
  assert.equal(talks.foreign?.sponsorId, s.fourth.id);
});

test("an inactive faction member is not an eligible sponsor", () => {
  const s = scene();
  const relation = getRelation(s.world, s.target.id, s.fourth.id);
  relation.opinion = 60;
  relation.trust = 80;
  sponsorFinance(s.world, s.target.id, 90);
  sponsorFinance(s.world, s.fourth.id, 90);
  const faction = createFaction(s.world, s.target.id, {
    allowedIdeologyIds: [getNationIdeology(s.world, s.target.id).id, getNationIdeology(s.world, s.fourth.id).id],
    defensiveObligation: "mandatory", offensiveObligation: "none", considerPersonality: true,
  });
  assert.ok(faction);
  assert.equal(joinFaction(s.world, s.fourth.id, faction!.id), true);
  s.fourth.macroRegionIds = [];
  s.fourth.identityGovernment!.favored.culture = "tide-guilds";
  const talks = openDemand(s);
  const before = getInfluence(s.world, s.fourth.id);
  updatePoliticalAdvocacy(s.world, getPoliticalContacts(s.world));
  assert.equal(talks.foreign?.sponsorId === s.fourth.id, false);
  assert.equal(getInfluence(s.world, s.fourth.id), before);
});
