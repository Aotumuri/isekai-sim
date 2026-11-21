import assert from "node:assert/strict";
import test from "node:test";
import { getRelation } from "../../src/sim/diplomacy";
import { updatePopulationPolitics } from "../../src/sim/population-politics";
import { installSubjectGovernment, releaseSubjectGovernment } from "../../src/sim/subject-governments";
import { updateSubjectRedistribution } from "../../src/sim/subject-redistribution";
import { updateSubjectAutonomy } from "../../src/sim/subject-autonomy";
import { updateTerritorialGovernance } from "../../src/sim/territorial-governance";
import { transferTerritories } from "../../src/sim/territory-transfer";
import { updateSurrender } from "../../src/sim/surrender";
import { stepSlowTick } from "../../src/sim/update";
import { acceptPeaceOffer, proposePeaceTerms, whitePeaceTerms } from "../../src/sim/war-negotiations";
import { declareWar } from "../../src/sim/war-state";
import { getMesoById, getOwnerByMesoId } from "../../src/sim/world-cache";
import { createFixedSocietyWorld, fixedSocietyDistrict } from "../helpers/fixed-society-world";

const district = fixedSocietyDistrict(4, 4);

function scene({ city = false, secondSubject = false, acquire = true } = {}) {
  const world = createFixedSocietyWorld(), [overlord, other, former, subject] = world.nations;
  world.settings!.politicalTurbulenceEnabled = true;
  updatePopulationPolitics(world);
  if (secondSubject) installSubjectGovernment(world, overlord.id, other.id);
  installSubjectGovernment(world, overlord.id, subject.id);
  const policy = overlord.identityGovernment!;
  policy.treatments.ancestry["veyari"] = "restricted";
  policy.treatments.culture["tide-guilds"] = "restricted";
  policy.treatments.faith["nine-wells"] = "restricted";
  const residents = world.regionalPopulations!.get(district)!;
  residents.ancestry = residents.ancestry.map((_, index) => index === 1 ? residents.size : 0);
  residents.culture = residents.culture.map((_, index) => index === 1 ? residents.size : 0);
  residents.faith = residents.faith.map((_, index) => index === 1 ? residents.size : 0);
  const site = getMesoById(world).get(district)!;
  if (city) { site.building = "city"; site.resource = "steel"; }
  const relation = getRelation(world, overlord.id, subject.id);
  relation.trust = 85;
  overlord.character = { doctrine: "guardian", aggression: 0.35, cooperation: 0.8, innovation: 0.55, thrift: 0.8 };
  subject.character = { ...overlord.character };
  if (acquire) assert(transferTerritories(world, [{ from: former.id, to: overlord.id, regionIds: [district] }]));
  const at = (tick: number) => {
    world.time.slowTick = tick;
    world.time.fastTick = 10 * tick;
    updateSubjectRedistribution(world);
  };
  const owner = () => getOwnerByMesoId(world).get(district);
  const decisions = () => world.events?.filter(({ message }) => message.startsWith("Subject territorial redistribution")) ?? [];
  return { world, overlord, other, former, subject, relation, site, residents, at, owner, decisions };
}

test("a completed war settlement triggers a consensual decision from the regular political update", () => {
  const s = scene({ acquire: false });
  assert(declareWar(s.world.wars, s.overlord.id, s.former.id, 0));
  s.world.occupation.mesoById.set(district, s.overlord.id);
  s.at(10);
  assert.equal(s.owner(), s.former.id);
  assert.equal(s.world.recentAcquisitions?.size ?? 0, 0);
  const terms = { ...whitePeaceTerms(), demandedRegionIds: [district] };
  assert(proposePeaceTerms(s.world, s.overlord.id, s.former.id, terms));
  assert(acceptPeaceOffer(s.world, s.former.id, s.overlord.id));
  assert.equal(s.owner(), s.overlord.id);
  const review = s.world.recentAcquisitions!.get(district)!.reviewAt;
  s.world.time.slowTick = review - 1;
  s.world.time.fastTick = review * 10;
  stepSlowTick(s.world, 0);
  assert.equal(s.owner(), s.subject.id);
  assert.match(s.decisions()[0].message, /consensual/);
});

test("delegation preserves district assets, formal ownership, capitals, resources and unit nationality", () => {
  const s = scene({ city: true });
  const { world, overlord, subject, residents, site } = s;
  const unit = world.units.find(({ nationId, domain }) => nationId === overlord.id && domain === "land")!;
  unit.regionId = district;
  unit.moveToId = district;
  world.industrialRecovery = new Map([[district, { owner: overlord.id, remaining: 40, lastTick: 0, funded: true }]]);
  world.annexations = new Map([[district, { owner: overlord.id, resistance: 0.15 }]]);
  world.identityGrievances = new Map([[district, { owner: overlord.id, recent: 0.25, entrenched: 0.13,
    exclusion: 0.45, hardship: 0, shock: 0, autonomyLoss: 0, autonomyDemand: 0.2, dimension: "culture", group: 1 }]]);
  world.regionalNegotiations = new Map([[district, { owner: overlord.id, status: "agreed", offer: "protected",
    requested: "protected", reviewAt: 90, distrust: 0.12, reason: "Regional protection", dimension: "culture",
    group: 1, grievance: 0.2, exclusion: 0.2, constituency: 1 }]]);
  const assets = () => world.nations.map(({ resources, treasury }) => [{ ...resources }, treasury?.balance]);
  const original = assets(), populations = structuredClone(residents);
  const initialTrust = s.relation.trust;
  s.at(10);
  assert.equal(s.owner(), subject.id);
  assert.match(s.decisions().at(-1)!.message, /consensual.*local guarantees require renegotiation/);
  assert(s.relation.trust > initialTrust);
  assert.equal(world.regionalNegotiations.has(district), false);
  assert.equal(world.identityGrievances.get(district)?.entrenched, 0.13);
  assert.deepEqual(world.regionalPopulations!.get(district), populations);
  assert.deepEqual([site.building, site.resource], ["city", "steel"]);
  assert.deepEqual(assets(), original);
  assert.equal(world.industrialRecovery.get(district)?.owner, subject.id);
  assert.equal(world.industrialRecovery.get(district)?.remaining, 40);
  assert.equal(world.annexations.get(district)?.resistance, 0.15);
  assert.equal(world.annexations.get(district)?.owner, subject.id);
  assert.equal(unit.nationId, overlord.id);
  assert.equal(unit.regionId, district); // Subject partners have reciprocal military access.
  assert.equal(unit.moveToId, null);
  for (const nation of world.nations) {
    assert.equal(getOwnerByMesoId(world).get(nation.capitalMesoId), nation.id);
    assert.deepEqual(nation.macroRegionIds, world.macroRegions.filter((macro) => macro.nationId === nation.id).map(({ id }) => id));
  }
  const ids = world.macroRegions.flatMap(({ mesoRegionIds }) => mesoRegionIds);
  assert.equal(new Set(ids).size, ids.length);
  updateTerritorialGovernance(world);
  assert.equal(world.identityGrievances.get(district)?.owner, subject.id);
  assert((world.identityGrievances.get(district)?.entrenched ?? 0) > 0);
  for (let tick = 20; tick <= 100; tick += 10) {
    s.at(tick);
    updateSubjectAutonomy(world);
  }
  assert.equal(s.owner(), subject.id);
  assert.equal(subject.subjectGovernment?.overlordId, overlord.id);
  assert.equal(s.decisions().length, 1);
});

test("a valuable productive district remains under direct rule when both governments treat residents similarly", () => {
  const s = scene({ city: true });
  s.overlord.identityGovernment!.treatments = structuredClone(s.subject.identityGovernment!.treatments);
  s.world.agriculturalLand!.get(district)!.harvest = 1.2;
  s.at(10);
  assert.equal(s.owner(), s.overlord.id);
  assert.match(s.decisions()[0].message, /direct control of production/);
});

test("no connected subject, independence and invalid ownership leave territory untouched", () => {
  const none = scene({ secondSubject: true });
  assert(releaseSubjectGovernment(none.world, none.overlord.id, none.subject.id));
  none.at(10);
  assert.equal(none.owner(), none.overlord.id);
  assert.match(none.decisions()[0].message, /No eligible subject had a land border/);

  const lost = scene();
  assert(transferTerritories(lost.world, [{ from: lost.overlord.id, to: lost.former.id, regionIds: [district] }]));
  lost.at(10);
  assert.equal(lost.owner(), lost.former.id);
  assert.deepEqual(lost.decisions(), []);
});

test("war delays review, stale cases expire and failed territorial transactions create no case", () => {
  const s = scene({ acquire: false });
  assert(!transferTerritories(s.world, [{ from: s.former.id, to: s.overlord.id, regionIds: [district, district] }]));
  assert.equal(s.world.recentAcquisitions?.size ?? 0, 0);
  assert(transferTerritories(s.world, [{ from: s.former.id, to: s.overlord.id, regionIds: [district] }]));
  assert(declareWar(s.world.wars, s.overlord.id, s.other.id, 20));
  s.at(10);
  assert.equal(s.owner(), s.overlord.id);
  assert(s.world.recentAcquisitions!.has(district));
  s.at(110);
  s.world.wars.length = 0;
  s.at(120);
  assert.equal(s.owner(), s.overlord.id);
  assert.equal(s.world.recentAcquisitions!.size, 0);
  assert.deepEqual(s.decisions(), []);
});

test("administratively burdensome land may be rejected or imposed under different authority", () => {
  for (const protectedGovernment of [true, false]) {
    const s = scene();
    s.subject.identityStability = { grievance: 0.8, legitimacy: 40, autonomyDemand: 0.35 };
    const government = s.subject.subjectGovernment!;
    if (protectedGovernment) government.selfGovernment = { since: 0, maximumLevy: 0.3, extraIndustrialAid: false };
    s.world.units = s.world.units.filter(({ nationId }) => nationId !== s.subject.id);
    s.at(10);
    assert.equal(s.owner(), protectedGovernment ? s.overlord.id : s.subject.id, s.decisions()[0]?.message);
    assert.match(s.decisions()[0].message, protectedGovernment ? /rejected/ : /imposed/);
    assert.equal(government.autonomy, undefined);
    if (protectedGovernment) assert.equal(s.relation.trust, 85);
    else assert(s.relation.trust < 85 && s.relation.tension > 10);
  }
});

test("a capable government can accept a district even when the prevailing culture differs from its capital", () => {
  const s = scene();
  const capital = s.world.regionalPopulations!.get(s.subject.capitalMesoId)!;
  capital.culture = capital.culture.map((_, index) => index === 3 ? capital.size : 0);
  s.subject.identityGovernment!.favored.culture = "lantern-roads";
  s.subject.identityGovernment!.treatments.culture["tide-guilds"] = "protected";
  s.at(10);
  assert.equal(s.owner(), s.subject.id);
  assert.match(s.decisions()[0].message, /lower institutional exclusion/);
});

test("the same border opportunity is retained if the subject is too small or likely to gain independent leverage", () => {
  const small = scene({ acquire: false });
  const ids = small.world.macroRegions.filter(({ nationId }) => nationId === small.subject.id)
    .flatMap(({ mesoRegionIds }) => mesoRegionIds)
    .filter((id) => id !== small.subject.capitalMesoId && id !== fixedSocietyDistrict(5, 4));
  assert(transferTerritories(small.world, [{ from: small.subject.id, to: small.other.id, regionIds: ids }]));
  small.residents.size = 30;
  for (const dimension of ["ancestry", "culture", "faith"] as const) small.residents[dimension][1] = 30;
  assert(transferTerritories(small.world, [{ from: small.former.id, to: small.overlord.id, regionIds: [district] }]));
  small.at(10);
  assert.equal(small.owner(), small.overlord.id);
  assert.match(small.decisions()[0].message, /could not administer/);

  const leverage = scene();
  leverage.overlord.identityGovernment!.treatments = structuredClone(leverage.subject.identityGovernment!.treatments);
  leverage.subject.subjectGovernment!.autonomy = 83;
  leverage.relation.trust = 30;
  leverage.at(10);
  assert.equal(leverage.owner(), leverage.overlord.id);
  assert.match(leverage.decisions()[0].message, /independent leverage/);
});

test("neighboring subjects compete for the same coherent parcel deterministically", () => {
  function scenario() {
    const s = scene({ acquire: false, secondSubject: true });
    assert(transferTerritories(s.world, [{ from: s.overlord.id, to: s.other.id, regionIds: [fixedSocietyDistrict(4, 3)] }]));
    const western = fixedSocietyDistrict(3, 4);
    const pop = s.world.regionalPopulations!.get(western)!;
    for (const dimension of ["ancestry", "culture", "faith"] as const) {
      pop[dimension] = pop[dimension].map((_, index) => index === 1 ? pop.size : 0);
    }
    s.other.identityGovernment!.treatments = structuredClone(s.overlord.identityGovernment!.treatments);
    assert(transferTerritories(s.world, [{ from: s.former.id, to: s.overlord.id, regionIds: [district, western] }]));
    s.at(10);
    assert.equal(s.owner(), s.subject.id);
    assert.equal(getOwnerByMesoId(s.world).get(western), s.subject.id);
    return s.decisions();
  }
  assert.deepEqual(scenario(), scenario());
});

test("two independent settlements can yield two transfers without reopening resolved acquisitions", () => {
  const s = scene();
  s.at(10);
  assert.equal(s.owner(), s.subject.id);
  const next = fixedSocietyDistrict(3, 4);
  const pop = s.world.regionalPopulations!.get(next)!;
  for (const dimension of ["ancestry", "culture", "faith"] as const) {
    pop[dimension] = pop[dimension].map((_, index) => index === 1 ? pop.size : 0);
  }
  assert(declareWar(s.world.wars, s.overlord.id, s.former.id, 110));
  assert(proposePeaceTerms(s.world, s.overlord.id, s.former.id, { ...whitePeaceTerms(), demandedRegionIds: [next] }));
  assert(acceptPeaceOffer(s.world, s.former.id, s.overlord.id));
  s.at(20);
  assert.equal(getOwnerByMesoId(s.world).get(next), s.subject.id);
  s.at(30);
  assert.equal(s.decisions().length, 2);
});

test("an active territorial crisis temporarily reserves the district", () => {
  const s = scene();
  const relation = getRelation(s.world, s.overlord.id, s.former.id);
  relation.crisis = { aggressorId: s.former.id, openedAtSlowTick: 1, deadlineSlowTick: 20, demand: "territory", regionIds: [district] };
  s.at(10);
  assert.equal(s.owner(), s.overlord.id);
  relation.crisis = null;
  s.at(20);
  assert.equal(s.owner(), s.subject.id);
  assert.equal(s.decisions().length, 1);
});

test("capitulation registers the completed legal acquisitions of an existing overlord", () => {
  const s = scene({ acquire: false });
  assert(declareWar(s.world.wars, s.overlord.id, s.former.id, 0));
  s.world.units = s.world.units.filter(({ nationId }) => nationId !== s.former.id);
  updateSurrender(s.world);
  assert.equal(s.owner(), s.overlord.id);
  assert.equal(s.world.wars.length, 0);
  assert(s.world.recentAcquisitions?.has(district));
  s.at(10);
  assert(s.decisions().length > 0);
  assert.equal(s.world.recentAcquisitions!.size, 0);
});

test("the transaction itself rejects an intervening war, independence, occupation or capital status", () => {
  for (const invalidate of [
    (s: ReturnType<typeof scene>) => declareWar(s.world.wars, s.subject.id, s.former.id, 2),
    (s: ReturnType<typeof scene>) => releaseSubjectGovernment(s.world, s.overlord.id, s.subject.id),
    (s: ReturnType<typeof scene>) => s.world.occupation.mesoById.set(district, s.former.id),
    (s: ReturnType<typeof scene>) => { s.overlord.capitalMesoId = district; },
  ]) {
    const s = scene();
    invalidate(s);
    const version = s.world.territoryVersion;
    const stocks = s.world.nations.map(({ resources }) => ({ ...resources }));
    assert(!transferTerritories(s.world, [{ from: s.overlord.id, to: s.subject.id, regionIds: [district] }], "redistribution"));
    assert.equal(s.owner(), s.overlord.id);
    assert.equal(s.world.territoryVersion, version);
    assert.deepEqual(s.world.nations.map(({ resources }) => resources), stocks);
  }
});

test("one settlement can retain productive districts while delegating a neighboring province", () => {
  const s = scene({ acquire: false });
  const western = fixedSocietyDistrict(3, 4), industry = fixedSocietyDistrict(2, 4);
  const regions = getMesoById(s.world);
  regions.get(industry)!.building = "city";
  regions.get(industry)!.resource = "steel";
  const population = s.world.regionalPopulations!.get(western)!;
  for (const dimension of ["ancestry", "culture", "faith"] as const) {
    population[dimension] = population[dimension].map((_, index) => index === 1 ? population.size : 0);
  }
  assert(transferTerritories(s.world, [{ from: s.former.id, to: s.overlord.id, regionIds: [district, western, industry] }]));
  s.at(10);
  const owners = getOwnerByMesoId(s.world);
  assert.equal(owners.get(industry), s.overlord.id);
  assert.equal(owners.get(western), s.subject.id);
  assert.equal(s.owner(), s.subject.id);
  assert.match(s.decisions()[0].message, /retained 1 other district/);
});

test("a government installed later the same day cannot inherit the acquisition's candidacy", () => {
  const s = scene({ acquire: false, secondSubject: true });
  assert(releaseSubjectGovernment(s.world, s.overlord.id, s.subject.id));
  assert(transferTerritories(s.world, [{ from: s.former.id, to: s.overlord.id, regionIds: [district] }]));
  installSubjectGovernment(s.world, s.overlord.id, s.subject.id);
  s.at(10);
  assert.equal(s.owner(), s.overlord.id);
  assert.match(s.decisions()[0].message, /No eligible subject had a land border/);
});

test("the review allows a full 100 calendar days after a mid-cycle acquisition", () => {
  const s = scene({ acquire: false });
  s.world.time.fastTick = 9;
  assert(transferTerritories(s.world, [{ from: s.former.id, to: s.overlord.id, regionIds: [district] }]));
  s.at(10);
  assert.equal(s.owner(), s.overlord.id);
  assert(s.world.recentAcquisitions?.has(district));
  s.at(20);
  assert.equal(s.owner(), s.subject.id);
});

test("a war involving the sole neighboring subject defers the decision even if another subject is at peace", () => {
  const s = scene({ secondSubject: true });
  assert(declareWar(s.world.wars, s.subject.id, s.former.id, 20));
  s.at(10);
  assert.equal(s.owner(), s.overlord.id);
  assert(s.world.recentAcquisitions!.has(district));
  s.world.wars.length = 0;
  s.at(20);
  assert.equal(s.owner(), s.subject.id);
});
