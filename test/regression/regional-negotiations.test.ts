import assert from "node:assert/strict";
import test from "node:test";
import { canRevolt, getDomesticUnrest } from "../../src/sim/domestic-unrest";
import { startDisplacementOrder, updateForcedDisplacement } from "../../src/sim/forced-displacement";
import { getRegionalIdentityGrievance, grievanceLevel } from "../../src/sim/identity-grievances";
import { updatePopulationPolitics } from "../../src/sim/population-politics";
import { getNationalPolitics } from "../../src/sim/politics";
import { regionalConcession } from "../../src/sim/identity-policy";
import { mayOpenRegionalNegotiation, openRegionalNegotiation, reviewRegionalNegotiation } from "../../src/sim/regional-negotiations";
import { startReligiousBan, updateReligiousPersecution } from "../../src/sim/religious-persecution";
import { rankRevolutionOrigins } from "../../src/sim/revolution-origins";
import { updateTerritorialGovernance } from "../../src/sim/territorial-governance";
import { transferTerritories } from "../../src/sim/territory-transfer";
import { declareWar } from "../../src/sim/war-state";
import { getOwnerByMesoId } from "../../src/sim/world-cache";
import { getMapView } from "../../src/render/map-view-state";
import { formatRegionTooltip } from "../../src/render/region/tooltip";
import { createFixedSocietyWorld, fixedSocietyDistrict } from "../helpers/fixed-society-world";

function scene(cooperation = 0.9, ideology = "capitalism") {
  const world = createFixedSocietyWorld(), [nation, rival] = world.nations;
  world.settings!.politicalTurbulenceEnabled = true;
  updatePopulationPolitics(world);
  nation.character = { doctrine: "merchant", cooperation, aggression: 0.25, innovation: 0.5, thrift: 0.85 };
  const cabinet = getNationalPolitics(world, nation);
  cabinet.governingIdeologyId = ideology;
  cabinet.system = "monarchy";
  cabinet.support.set(ideology, 80);
  const government = nation.identityGovernment!;
  government.nextReviewAt = Infinity;
  government.favored.culture = "reed-courts";
  const id = fixedSocietyDistrict(3, 1);
  for (const [district, population] of world.regionalPopulations!) {
    if (getOwnerByMesoId(world).get(district) === nation.id) {
      population.culture = [population.size, 0, 0, 0, 0, 0];
    }
  }
  const population = world.regionalPopulations!.get(id)!;
  population.culture = [population.size * 0.1, population.size * 0.9, 0, 0, 0, 0];
  const at = (tick: number) => {
    world.time.slowTick = tick;
    world.time.fastTick = tick * 10;
    updateTerritorialGovernance(world);
  };
  const talks = () => world.regionalNegotiations?.get(id);
  const grievance = () => grievanceLevel(getRegionalIdentityGrievance(world, id, nation.id));
  return { world, nation, rival, government, population, id, at, talks, grievance };
}

function untilOffer(s: ReturnType<typeof scene>) {
  s.government.treatments.culture["tide-guilds"] = "assimilation";
  s.at(10);
  assert.equal(s.talks(), undefined);
  for (let tick = 20; tick <= 100; tick += 10) {
    s.at(tick);
    if (s.talks()?.status === "offer" || s.talks()?.status === "rejected") return tick;
  }
  assert.fail("a sustained grievance should produce a cabinet decision");
}

test("politically diverse districts with tolerated groups do not form demands", () => {
  const s = scene();
  for (let tick = 10; tick <= 150; tick += 10) s.at(tick);
  assert.equal(s.talks(), undefined);
  assert.equal(s.grievance(), 0);
  assert.equal(s.nation.identityStability?.legitimacy, 100);
});

test("sustained cultural exclusion produces a demand, ratification and gradual local recovery", () => {
  const s = scene();
  const tick = untilOffer(s);
  assert.equal(s.talks()?.requested, "autonomous");
  assert.equal(s.talks()?.offer, "autonomous");
  assert.equal(regionalConcession(s.world, s.id, s.nation.id), undefined);
  const culture = [...s.population.culture], before = s.grievance();
  const legitimacy = s.nation.identityStability!.legitimacy;
  s.at(tick + 10);
  assert.equal(regionalConcession(s.world, s.id, s.nation.id)?.offer, "autonomous");
  assert.deepEqual(s.population.culture, culture);
  assert(s.grievance() > 0 && s.grievance() < before);
  const after = s.grievance();
  for (let next = tick + 20; next <= tick + 180; next += 10) s.at(next);
  assert(s.grievance() < after);
  assert(s.nation.identityStability!.legitimacy > legitimacy);
  assert.equal(s.government.treatments.culture["tide-guilds"], "assimilation");
  assert.equal(s.world.events?.filter(({ message }) => message.includes(`, district ${s.id}:`) && message.includes("demanded local control")).length, 1);
  const meso = s.world.mesoRegions.find(({ id }) => id === s.id)!;
  const micro = s.world.microRegions.find(({ id }) => id === meso.centerId)!;
  getMapView(s.world).mode = "political";
  assert.match(formatRegionTooltip(micro, meso, null, s.nation, [], s.world), /Agreement for local control · Tide Guilds/i);
});

test("a moderate cabinet offers protections that the movement can accept", () => {
  const s = scene(0.49);
  const tick = untilOffer(s);
  assert.equal(s.talks()?.requested, "autonomous");
  assert.equal(s.talks()?.offer, "protected");
  s.at(tick + 10);
  assert.equal(s.talks()?.status, "agreed");
  assert.match(s.talks()!.reason, /immediate unequal treatment/);
});

test("the movement can refuse a limited offer when the local crisis worsens", () => {
  const s = scene(0.49);
  const tick = untilOffer(s);
  assert.equal(s.talks()?.offer, "protected");
  const memory = s.world.identityGrievances!.get(s.id)!;
  memory.recent = 0.65;
  memory.entrenched = 0.40;
  s.at(tick + 10);
  assert.equal(s.talks()?.status, "rejected");
  assert.match(s.talks()!.reason, /movement refused/);
  assert(s.talks()!.distrust > 0);
});

test("an exclusionary cabinet rejects the same cultural demand and leaves political memory", () => {
  const s = scene(0.49, "cohesionism");
  const tick = untilOffer(s);
  assert.equal(s.talks()?.status, "rejected");
  assert(s.talks()!.distrust > 0);
  assert.equal(regionalConcession(s.world, s.id, s.nation.id), undefined);
  s.at(tick + 10);
  assert(s.grievance() > s.talks()!.grievance);
  assert(rankRevolutionOrigins(s.world, s.nation).some(({ districtId }) => districtId === s.id));
  getDomesticUnrest(s.world, s.nation.id).pressure = 100;
  assert(!canRevolt(s.world, s.nation.id));
  for (let next = tick + 20; next <= tick + 140; next += 10) s.at(next);
  assert.equal(s.world.events?.filter(({ message }) => message.includes(`, district ${s.id}:`) && message.includes("demanded local control")).length, 1);
});

test("war and shortage allow one delay, and central withdrawal creates a bounded breach", () => {
  const s = scene();
  s.government.treatments.culture["tide-guilds"] = "assimilation";
  s.nation.food!.rationCoverage = 0.7;
  declareWar(s.world.wars, s.nation.id, s.rival.id, 0);
  let tick = 10;
  for (; tick <= 100 && !s.talks(); tick += 10) s.at(tick);
  s.at(tick);
  assert.equal(s.talks()?.status, "deferred");
  s.at(tick + 10);
  assert.equal(s.talks()?.status, "deferred");
  s.at(tick + 20);
  assert.equal(s.talks()?.status, "offer");
  s.at(tick + 30);
  assert.equal(s.talks()?.status, "agreed");
  s.government.treatments.culture["tide-guilds"] = "restricted";
  s.at(tick + 40);
  assert.equal(s.talks()?.status, "violated");
  assert.equal(regionalConcession(s.world, s.id, s.nation.id), undefined);
  const distrust = s.talks()!.distrust;
  s.at(tick + 50);
  assert(s.talks()!.distrust < distrust);
  assert(s.grievance() > 0.2);
});

test("occupation suspends local guarantees and territorial transfer ends the old government's pact", () => {
  const s = scene();
  const tick = untilOffer(s);
  s.at(tick + 10);
  s.world.occupation.mesoById.set(s.id, s.rival.id);
  assert.equal(regionalConcession(s.world, s.id, s.nation.id), undefined);
  s.at(tick + 20);
  assert.equal(s.talks()?.status, "agreed");
  s.world.occupation.mesoById.delete(s.id);
  assert(regionalConcession(s.world, s.id, s.nation.id));
  assert(transferTerritories(s.world, [{ from: s.nation.id, to: s.rival.id, regionIds: [s.id] }]));
  assert.equal(s.talks(), undefined);
  assert.equal(getOwnerByMesoId(s.world).get(s.id), s.rival.id);
  assert(s.grievance() > 0);
});

test("a local faith agreement binds the blanket ban and targeted orders in its district", () => {
  const s = scene();
  s.nation.populationPolicy = { type: "religious", group: 0 };
  s.government.favored.faith = "ember-covenant";
  s.government.stateReligion = true;
  for (const [id, population] of s.world.regionalPopulations!) {
    if (getOwnerByMesoId(s.world).get(id) === s.nation.id) population.faith = [population.size, 0, 0, 0, 0, 0];
  }
  s.population.faith = [s.population.size * 0.2, s.population.size * 0.8, 0, 0, 0, 0];
  s.government.treatments.faith["nine-wells"] = "restricted";
  for (let tick = 10; tick <= 100; tick += 10) s.at(tick);
  assert.equal(s.talks()?.status, "agreed");
  assert.equal(s.talks()?.dimension, "faith");
  assert(startReligiousBan(s.world, s.nation));
  const unrest = getDomesticUnrest(s.world, s.nation.id);
  const pressure = unrest.pressure;
  updateReligiousPersecution(s.world);
  assert.equal(unrest.pressure, pressure);
  assert(startDisplacementOrder(s.world, s.nation, 1, "killing", "faith"));
  const original = s.population.size;
  updateForcedDisplacement(s.world);
  assert.equal(s.population.size, original);
  s.world.regionalNegotiations!.delete(s.id);
  s.at(110);
  updateReligiousPersecution(s.world);
  assert(unrest.pressure > pressure);
  updateForcedDisplacement(s.world);
  assert(s.population.size < original);
});

test("intervening demands do not erase a cabinet's refusal of an unchanged mandate", () => {
  const s = scene(0.2, "cohesionism");
  s.government.treatments.culture["tide-guilds"] = "restricted";
  s.government.treatments.faith["nine-wells"] = "restricted";
  s.population.faith = s.population.faith.map((_, group) => group === 1 ? s.population.size : 0);
  const first = { dimension: "culture", group: 1, requested: "autonomous", grievance: 0.21, exclusion: 0.12, constituency: 0.9 } as const;
  const second = { ...first, dimension: "faith", constituency: 1 } as const;
  const reviewRefusal = (mandate: typeof first | typeof second, now: number) => {
    s.world.time.slowTick = now;
    assert(mayOpenRegionalNegotiation(s.world, s.nation, s.id, mandate));
    openRegionalNegotiation(s.world, s.nation, s.id, mandate);
    s.world.time.slowTick += 10;
    reviewRegionalNegotiation(s.world, s.nation, s.id, s.population, false);
    assert.equal(s.talks()?.status, "rejected");
  };
  reviewRefusal(first, 10);
  reviewRefusal(second, 120);
  s.world.time.slowTick = 230;
  assert(!mayOpenRegionalNegotiation(s.world, s.nation, s.id, first));
  assert(mayOpenRegionalNegotiation(s.world, s.nation, s.id, { ...first, exclusion: 0.20 }));
  s.government.treatments.culture["tide-guilds"] = "autonomous";
  assert(!mayOpenRegionalNegotiation(s.world, s.nation, s.id, first));
  s.government.treatments.culture["tide-guilds"] = "restricted";
  s.nation.politics!.governingIdeologyId = "capitalism";
  assert(mayOpenRegionalNegotiation(s.world, s.nation, s.id, first));
});
