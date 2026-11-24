import assert from "node:assert/strict";
import test from "node:test";
import { getInfluence, getRelation } from "../../src/sim/diplomacy";
import { setForeignAdvocacySchedule } from "../../src/sim/foreign-advocacy-schedule";
import type { RegionalAdvocacyObservation } from "../../src/sim/instrumentation";
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
  openRegionalNegotiation,
} from "../../src/sim/regional-negotiations";
import { installSubjectGovernment } from "../../src/sim/subject-governments";
import { updateSubjectAutonomy } from "../../src/sim/subject-autonomy";
import { getOwnerByMesoId } from "../../src/sim/world-cache";
import { getAdjacentNationPairs } from "../../src/sim/world-cache";
import { fixedSocietyDistrict } from "../helpers/fixed-society-world";

import { commitCount, district, expectContact, openDemand, openDemands, scene, screenAt, sponsorFinance }
  from "../helpers/foreign-advocacy-fixture";

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

test("an expired commitment is released without renewal spending", () => {
  const s = scene();
  const talks = openDemand(s);
  sponsorFinance(s.world, s.sponsor.id, 90);
  getRelation(s.world, s.sponsor.id, s.target.id).trust = 60;
  updatePoliticalAdvocacy(s.world, getPoliticalContacts(s.world));
  assert.ok(talks.foreign);
  const before = getInfluence(s.world, s.sponsor.id);
  const counters: Record<string, number> = {};
  s.world.instrumentation = {
    recordDuration() {},
    incrementCounter(name) { counters[name] = (counters[name] ?? 0) + 1; },
  };
  // The sponsor's interest disappears before the renewal is due.
  s.sponsor.identityGovernment!.favored.culture = "reed-courts";
  s.world.time.slowTick = talks.foreign!.renewAt;
  updateForeignBacking(s.world);
  s.world.instrumentation = undefined;
  assert.equal(talks.foreign, undefined);
  assert.equal(counters["foreignAdvocacy.expired"], 1);
  assert.equal(getInfluence(s.world, s.sponsor.id), before);
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

test("a stale commitment does not consume the sponsor's capacity", () => {
  const s = scene();
  const demands = openDemands(s, [
    fixedSocietyDistrict(1, 1), fixedSocietyDistrict(2, 1), fixedSocietyDistrict(4, 1),
  ]);
  sponsorFinance(s.world, s.sponsor.id, 90);
  getRelation(s.world, s.sponsor.id, s.target.id).trust = 60;
  updatePoliticalAdvocacy(s.world, getPoliticalContacts(s.world));
  assert.equal(commitCount(s), 1);
  const committed = demands.find(({ foreign }) => foreign?.sponsorId === s.sponsor.id)!;
  const stale = demands.find((demand) => demand !== committed)!;
  // Simulate a commitment left behind on a case that is no longer live. It must not
  // count against the sponsor's two simultaneous commitments.
  stale.status = "rejected";
  stale.foreign = { sponsorId: s.sponsor.id, strength: 0.5, backlash: 0, since: 0, renewAt: 0 };
  s.sponsor.politics!.nextForeignAdvocacyAt = 0;
  s.world.time.slowTick = 360;
  s.world.time.fastTick = 3600;
  updatePoliticalAdvocacy(s.world, getPoliticalContacts(s.world));
  assert.equal(commitCount(s), MAX_ACTIVE_PER_SPONSOR,
    "the live commitment count ignores the closed case");
});

test("foreign advocacy follows the scheduled evaluation cadence", () => {
  const s = scene();
  setForeignAdvocacySchedule(s.world, "periodic");
  openDemand(s);
  // Enough influence for advocacy, but the campaign cooldown keeps the ideological
  // campaign system from spending first.
  sponsorFinance(s.world, s.sponsor.id, 50);
  s.sponsor.politics!.nextForeignCampaignAt = Infinity;
  getRelation(s.world, s.sponsor.id, s.target.id).trust = 60;
  s.world.time.slowTick = 310;
  s.world.time.fastTick = 3100;
  updateForeignPoliticalInfluence(s.world);
  assert.equal(s.talks()?.foreign, undefined, "backing maintenance does not create a commitment");
  s.world.time.slowTick = 360;
  s.world.time.fastTick = 3600;
  updateForeignPoliticalInfluence(s.world);
  assert.equal(s.talks()?.foreign?.sponsorId, s.sponsor.id);
});

test("no-op instrumentation does not alter advocacy decisions", () => {
  const run = (instrumented: boolean) => {
    const s = scene();
    const talks = openDemand(s);
    sponsorFinance(s.world, s.sponsor.id);
    getRelation(s.world, s.sponsor.id, s.target.id).trust = 60;
    if (instrumented) s.world.instrumentation = { recordDuration() {}, incrementCounter() {} };
    updatePoliticalAdvocacy(s.world, getPoliticalContacts(s.world));
    return {
      sponsor: talks.foreign?.sponsorId ?? null,
      strength: talks.foreign?.strength ?? null,
      influence: getInfluence(s.world, s.sponsor.id),
      cooldown: s.sponsor.politics?.nextForeignAdvocacyAt ?? null,
    };
  };
  assert.deepEqual(run(true), run(false));
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

function observeAdvocacy(s: ReturnType<typeof scene>) {
  const observations: Array<{ kind: RegionalAdvocacyObservation["kind"]; tick: number; id: string }> = [];
  const counters: Record<string, number> = {};
  s.world.instrumentation = {
    recordDuration() {},
    incrementCounter(name, amount = 1) { counters[name] = (counters[name] ?? 0) + amount; },
    observeRegionalAdvocacy({ kind, id }) { observations.push({ kind, id, tick: s.world.time.slowTick }); },
  };
  return { observations, counters };
}

test("schedules screen a 200-day demand at their actual update boundaries", () => {
  for (const [schedule, expected] of [["periodic", []], ["event", [301]], ["100-day", [310, 320]]] as const) {
    const s = scene();
    setForeignAdvocacySchedule(s.world, schedule);
    const { observations } = observeAdvocacy(s);
    screenAt(s, 300); // Like stepSlowTick, screen before governance opens a demand.
    const talks = openDemand(s);
    for (let tick = 301; tick <= 320; tick++) {
      screenAt(s, tick);
      if (tick % 10 === 0) s.at(tick);
    }
    const screens = observations.filter(({ kind, id, tick }) => kind === "screened" && id === district && tick >= 300);
    assert.deepEqual(screens.map(({ tick }) => tick), expected, schedule);
    assert.equal(talks.status, "agreed");
    if (schedule !== "periodic") assert.ok(observations.indexOf(screens[0]!) <
      observations.findIndex(({ kind, tick }) => kind === "governmentDecision" && tick === 310));
  }
});

test("event screening discards stale identities and closed demands and clears consumed entries", () => {
  for (const invalidation of ["replacement", "settled", "transfer"] as const) {
    const s = scene();
    setForeignAdvocacySchedule(s.world, "event");
    const talks = openDemand(s);
    const { observations } = observeAdvocacy(s);
    sponsorFinance(s.world, s.sponsor.id);
    if (invalidation === "replacement") s.world.regionalNegotiations!.set(district, { ...talks, group: 2 });
    else if (invalidation === "settled") talks.status = "agreed";
    else s.world.regionalNegotiations!.delete(district);

    screenAt(s, 301);
    assert.equal(observations.length, 0, invalidation);
    assert.equal(getInfluence(s.world, s.sponsor.id), 90);

    openRegionalNegotiation(s.world, s.target, district, talks);
    screenAt(s, 301);
    assert.equal(observations.filter(({ kind }) => kind === "screened").length, 0);
    screenAt(s, 302);
    screenAt(s, 302);
    screenAt(s, 303);
    assert.equal(observations.filter(({ kind }) => kind === "screened").length, 1);
  }
});

test("event screening recognizes contacts established after the demand opened", () => {
  const s = scene();
  setForeignAdvocacySchedule(s.world, "event");
  const talks = openDemand(s);
  const { counters } = observeAdvocacy(s);
  assert.ok(!getPoliticalContacts(s.world).get(s.target.id)?.has(s.fourth.id));
  s.fourth.identityGovernment!.favored.culture = "tide-guilds";
  sponsorFinance(s.world, s.fourth.id, 90);
  const relation = getRelation(s.world, s.target.id, s.fourth.id);
  relation.opinion = 60;
  relation.trust = 80;
  const faction = createFaction(s.world, s.target.id, {
    allowedIdeologyIds: [getNationIdeology(s.world, s.target.id).id, getNationIdeology(s.world, s.fourth.id).id],
    defensiveObligation: "mandatory", offensiveObligation: "none", considerPersonality: true,
  });
  assert.ok(faction);
  assert.equal(joinFaction(s.world, s.fourth.id, faction.id), true);
  screenAt(s, 301);
  assert.equal(talks.foreign?.sponsorId, s.fourth.id);
  assert.equal(counters["foreignAdvocacy.accepted"], 1);
});

test("event screening uses the shared spending, order and commitment checks", () => {
  const run = (reverse: boolean, instrumented: boolean) => {
    const s = scene();
    const ids = [fixedSocietyDistrict(1, 1), fixedSocietyDistrict(2, 1), fixedSocietyDistrict(4, 1)];
    openDemands(s, reverse ? [...ids].reverse() : ids);
    if (instrumented) {
      observeAdvocacy(s);
      s.world.instrumentation!.startForeignAdvocacyMeasurement = () => undefined;
    }
    getRelation(s.world, s.target.id, s.sponsor.id).trust = 60;
    sponsorFinance(s.world, s.sponsor.id);
    screenAt(s, 301);
    assert.equal(commitCount(s), 1);
    assert.equal(getInfluence(s.world, s.sponsor.id), 90 - POLITICAL_ADVOCACY_COST);
    return ids.map((id) => s.world.regionalNegotiations!.get(id)?.foreign);
  };
  assert.deepEqual(run(false, true), run(true, false));
});

test("an event with no eligible sponsor is recorded without spending influence", () => {
  const s = scene();
  setForeignAdvocacySchedule(s.world, "event");
  openDemand(s);
  const { observations, counters } = observeAdvocacy(s);
  for (const { id } of s.world.nations) sponsorFinance(s.world, id, 0);
  screenAt(s, 301);
  assert.equal(observations.filter(({ kind }) => kind === "screened").length, 1);
  assert.equal(observations.filter(({ kind }) => kind === "offer").length, 0);
  assert.ok(counters["foreignAdvocacy.excluded.influence"]! > 0);
  assert.equal(getInfluence(s.world, s.sponsor.id), 0);
});

test("foreign backing can harden the government's position in the same-state comparison", () => {
  const s = scene({ cooperation: 0.61 });
  const talks = openDemand(s);
  const choices: Array<[string, string]> = [];
  s.world.instrumentation = {
    recordDuration() {},
    incrementCounter() {},
    observeRegionalAdvocacy(event) {
      if (event.kind === "governmentDecision") choices.push([event.withoutBacking, event.actual]);
    },
  };
  talks.foreign = { sponsorId: s.sponsor.id, strength: 0.85, backlash: 1, since: 300, renewAt: 460 };
  s.at(310);
  assert.deepEqual(choices, [["full", "partial"]]);
});

test("event screening excludes a treaty contact that expires before evaluation", () => {
  const s = scene();
  setForeignAdvocacySchedule(s.world, "event");
  const talks = openDemand(s);
  const relation = getRelation(s.world, s.target.id, s.fourth.id);
  relation.treaties.push({ type: "trade", expiresAtSlowTick: 301 });
  assert.ok(getPoliticalContacts(s.world).get(s.target.id)?.has(s.fourth.id));
  s.fourth.identityGovernment!.favored.culture = "tide-guilds";
  sponsorFinance(s.world, s.fourth.id, 90);
  const { observations } = observeAdvocacy(s);
  screenAt(s, 301);
  assert.ok(!getPoliticalContacts(s.world).get(s.target.id)?.has(s.fourth.id));
  assert.equal(observations.filter(({ kind }) => kind === "screened").length, 1);
  assert.equal(talks.foreign, undefined);
  assert.equal(getInfluence(s.world, s.fourth.id), 90);
});

test("foreign backing can turn a government rejection into an offer", () => {
  const s = scene({ cooperation: 0.04 });
  const talks = openDemand(s);
  talks.distrust = 0.25;
  const choices: Array<[string, string]> = [];
  s.world.instrumentation = {
    recordDuration() {},
    incrementCounter() {},
    observeRegionalAdvocacy(event) {
      if (event.kind === "governmentDecision") choices.push([event.withoutBacking, event.actual]);
    },
  };
  talks.foreign = { sponsorId: s.sponsor.id, strength: 0.85, backlash: 0, since: 300, renewAt: 460 };
  s.at(310);
  assert.deepEqual(choices, [["reject", "partial"]]);
  assert.equal(talks.offer, "protected");
});

test("crossing the autonomy threshold does not change an offer of requested protection", () => {
  const s = scene({ cooperation: 0.49 });
  const talks = openDemand(s);
  talks.requested = "protected";
  talks.foreign = { sponsorId: s.sponsor.id, strength: 0.85, backlash: 0, since: 300, renewAt: 460 };
  const { counters } = observeAdvocacy(s);
  s.at(310);
  assert.equal(talks.offer, "protected");
  assert.equal(counters["foreignAdvocacy.negotiationReviewsWithBacking"], 1);
  assert.equal(counters["foreignAdvocacy.decisionsChanged"] ?? 0, 0);
});
