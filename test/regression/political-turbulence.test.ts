import assert from "node:assert/strict";
import test from "node:test";
import { updateBorderIncidents } from "../../src/sim/border-incidents";
import { getDefensePact, getRelation, isDiplomaticallyProtected } from "../../src/sim/diplomacy";
import { updateDefensePacts } from "../../src/sim/defense-pacts";
import { updateCivilWar } from "../../src/sim/civil-war";
import { updateDiplomaticCrises } from "../../src/sim/diplomatic-crises";
import { getDomesticUnrest } from "../../src/sim/domestic-unrest";
import { getFactionState } from "../../src/sim/factions";
import { getNationCharacter } from "../../src/sim/nation-character";
import { getNationalPolitics, updateNationalPolitics } from "../../src/sim/politics";
import { updateNationalistMovements } from "../../src/sim/nationalist-movements";
import { getForeignClaims } from "../../src/sim/territorial-claims";
import { getSubjectIntegrationIssue, integrateSubjectGovernment, setGovernancePolicy, updateTerritorialGovernance } from "../../src/sim/territorial-governance";
import { updateSurrender } from "../../src/sim/surrender";
import { isTradeEmbargoed, updateFactionSanctions } from "../../src/sim/trade-embargo";
import { canSendVolunteers } from "../../src/sim/volunteers";
import { acceptPeaceOffer, proposePeaceTerms, whitePeaceTerms } from "../../src/sim/war-negotiations";
import { declareWar, findWar } from "../../src/sim/war-state";
import { getOwnerByMesoId } from "../../src/sim/world-cache";
import { createNationId } from "../../src/worldgen/nation";
import { createSocietyWorld } from "../helpers/society-world";

function scene() {
  const world = createSocietyWorld();
  world.settings!.politicalTurbulenceEnabled = true;
  return world;
}

function dividedSubject() {
  const world = scene(), [sponsor, subject] = world.nations;
  subject.subjectGovernment = { overlordId: sponsor.id, establishedAtFastTick: 0 };
  const relation = getRelation(world, sponsor.id, subject.id);
  relation.trust = 65;
  relation.opinion = 30;
  for (const [id, owner] of getOwnerByMesoId(world)) {
    const population = world.regionalPopulations!.get(id)!;
    const group = owner === sponsor.id ? 0 : 1;
    for (const dimension of ["ancestry", "culture", "faith"] as const) {
      population[dimension] = Array.from({ length: 6 }, (_, index) => index === group ? population.size : 0);
    }
  }
  return { world, sponsor, subject };
}

test("regional autonomy makes a diverse country more stable without changing its population", () => {
  const { world, subject } = dividedSubject();
  const capital = world.regionalPopulations!.get(subject.capitalMesoId)!;
  const province = world.macroRegions.find(({ nationId, mesoRegionIds }) =>
    nationId === subject.id && !mesoRegionIds.includes(subject.capitalMesoId))!;
  for (const id of province.mesoRegionIds) {
    const population = world.regionalPopulations!.get(id)!;
    population.culture = [population.size, 0, 0, 0, 0, 0];
    population.faith = [population.size, 0, 0, 0, 0, 0];
  }
  setGovernancePolicy(world, subject.id, subject.id, "centralized");
  for (let tick = 10; tick <= 100; tick += 10) {
    world.time.slowTick = tick;
    updateTerritorialGovernance(world);
  }
  const before = subject.governance!.stability;
  const culture = [...capital.culture];
  assert.ok(before < 100);
  setGovernancePolicy(world, subject.id, subject.id, "autonomy");
  for (let tick = 110; tick <= 200; tick += 10) {
    world.time.slowTick = tick;
    updateTerritorialGovernance(world);
  }
  assert.ok(subject.governance!.stability > before);
  assert.deepEqual(capital.culture, culture);
});

test("subjects can assimilate gradually and integrate when ready while preserving ancestry", () => {
  const { world, sponsor, subject } = dividedSubject();
  const population = world.regionalPopulations!.get(subject.capitalMesoId)!;
  const ancestry = [...population.ancestry];
  const subjectUnits = world.units.filter((unit) => unit.nationId === subject.id);
  assert.ok(setGovernancePolicy(world, sponsor.id, subject.id, "assimilation"));
  assert.ok(getSubjectIntegrationIssue(world, sponsor.id, subject.id));
  for (let tick = 10; tick <= 400; tick += 10) {
    world.time.slowTick = tick;
    updateTerritorialGovernance(world);
  }
  assert.ok(population.culture[0]! > population.size * 0.72);
  assert.ok(population.faith[0]! > population.size * 0.72);
  assert.deepEqual(population.ancestry, ancestry);
  assert.ok(Math.abs(population.culture.reduce((a, b) => a + b) - population.size) < 1e-8);
  assert.equal(getSubjectIntegrationIssue(world, sponsor.id, subject.id), undefined);
  assert.ok(integrateSubjectGovernment(world, sponsor.id, subject.id));
  assert.equal(getOwnerByMesoId(world).get(subject.capitalMesoId), sponsor.id);
  assert.equal(subject.macroRegionIds.length, 0);
  assert.ok(subjectUnits.every((unit) => unit.nationId === sponsor.id));
  assert.ok(!integrateSubjectGovernment(world, sponsor.id, subject.id));
});

test("a negotiated local subject receives only the demanded provinces", () => {
  const world = scene(), [sponsor, defeated] = world.nations;
  const province = world.macroRegions.find(({ nationId, mesoRegionIds }) =>
    nationId === defeated.id && !mesoRegionIds.includes(defeated.capitalMesoId))!;
  const districts = [...province.mesoRegionIds];
  declareWar(world.wars, sponsor.id, defeated.id, 0);
  const terms = { ...whitePeaceTerms(), demandedRegionIds: districts, localSubject: true };
  assert.ok(proposePeaceTerms(world, sponsor.id, defeated.id, terms));
  assert.ok(acceptPeaceOffer(world, defeated.id, sponsor.id));
  const subject = world.nations.at(-1)!;
  assert.equal(subject.subjectGovernment?.overlordId, sponsor.id);
  assert.equal(defeated.subjectGovernment, undefined);
  assert.equal(getOwnerByMesoId(world).get(defeated.capitalMesoId), defeated.id);
  assert.ok(districts.every((id) => getOwnerByMesoId(world).get(id) === subject.id));
});

test("a subject uprising can be supported by volunteers without automatically bringing the sponsor to war", () => {
  const { world, sponsor, subject } = dividedSubject();
  assert.ok(setGovernancePolicy(world, sponsor.id, subject.id, "assimilation"));
  getDomesticUnrest(world, subject.id).pressure = 100;
  updateCivilWar(world);
  const rebels = world.nations.at(-1)!;
  assert.notEqual(rebels.id, subject.id);
  const war = findWar(world.wars, rebels.id, subject.id)!;
  assert.equal(war.cause, "subject-uprising");
  const seat = rebels.capitalMesoId;
  updateDiplomaticCrises(world);
  assert.equal(findWar(world.wars, sponsor.id, rebels.id), null);
  assert.ok(canSendVolunteers(world, sponsor.id, subject.id));
  world.units = world.units.filter((unit) => unit.nationId !== rebels.id);
  updateSurrender(world);
  assert.equal(getOwnerByMesoId(world).get(seat), subject.id);
  assert.equal(findWar(world.wars, subject.id, rebels.id), null);
});

test("states facing a shared threat can form a temporary, targeted defense pact", () => {
  const world = scene(), [a, b] = world.nations;
  const threat = { ...a, id: createNationId(2) };
  world.nations.push(threat);
  const relation = getRelation(world, a.id, b.id);
  relation.opinion = 5;
  world.commonThreatCoalitions.coalitions.push({ id: "test", memberNationIds: [a.id, b.id], targetNationId: threat.id,
    formedAtSlowTick: 30, age: 60, formationReason: "shared-land-threat", pendingDissolutionReason: null, unstableTicks: 0 });
  world.time.slowTick = 90;
  updateDefensePacts(world);
  assert.equal(getDefensePact(world, a.id, b.id)?.against, threat.id);
  assert.ok(isDiplomaticallyProtected(world, a.id, b.id));
  assert.ok(!isDiplomaticallyProtected(world, a.id, threat.id));
  world.time.slowTick = 330;
  assert.equal(getDefensePact(world, a.id, b.id), undefined);
});

test("a bloc sanctions an aggressor together and trade can resume after sanctions expire", () => {
  const world = scene(), [a, b] = world.nations;
  const aggressor = { ...a, id: createNationId(2) };
  world.nations.push(aggressor);
  getFactionState(world).factions.push({
    id: "test-bloc", name: "Test bloc", founderId: a.id, leaderId: a.id, memberIds: [a.id, b.id],
    createdAtSlowTick: 0, charter: { allowedIdeologyIds: [], defensiveObligation: "none",
      offensiveObligation: "none", considerPersonality: false },
  });
  declareWar(world.wars, aggressor.id, a.id, 0);
  world.time.slowTick = 20;
  updateFactionSanctions(world);
  assert.ok(isTradeEmbargoed(world, a.id, aggressor.id));
  assert.ok(isTradeEmbargoed(world, b.id, aggressor.id));
  assert.ok(!isTradeEmbargoed(world, a.id, b.id));
  world.wars = [];
  world.time.slowTick = 140;
  updateFactionSanctions(world);
  assert.ok(!isTradeEmbargoed(world, b.id, aggressor.id));
});

test("reunification movements claim matching districts beyond the border and then expire", () => {
  const world = scene();
  const [a, b] = world.nations;
  a.populationPolicy = { type: "homeland", group: 0 };
  const districts = world.macroRegions.filter(({ nationId }) => nationId === b.id).flatMap(({ mesoRegionIds }) => mesoRegionIds);
  for (const id of districts) {
    const population = world.regionalPopulations!.get(id)!;
    population.ancestry = [population.size, 0, 0, 0, 0, 0];
  }
  const before = getForeignClaims(world, a.id, b.id).length;
  world.time.slowTick = 120;
  updateNationalistMovements(world);
  assert.equal(a.nationalistMovement?.targetId, b.id);
  assert.equal(getForeignClaims(world, a.id, b.id).length, districts.length);
  assert.ok(before < districts.length);
  assert.ok(getRelation(world, a.id, b.id).grievance >= 30);
  world.time.slowTick = 360;
  assert.equal(getForeignClaims(world, a.id, b.id).length, before);
});

test("opposing border deployments create a cooldown-limited diplomatic incident", () => {
  const world = scene(), [a, b] = world.nations;
  const owners = getOwnerByMesoId(world);
  const border = world.mesoRegions.find((region) => owners.get(region.id) === a.id &&
    region.neighbors.some(({ id }) => owners.get(id) === b.id))!;
  const opposite = border.neighbors.find(({ id }) => owners.get(id) === b.id)!;
  for (const [nation, region] of [[a, border], [b, opposite]] as const) {
    const unit = world.units.find((item) => item.nationId === nation.id && item.domain === "land")!;
    unit.regionId = region.id;
    unit.org = 1;
  }
  getNationCharacter(world, a.id).aggression = 0.9;
  const relation = getRelation(world, a.id, b.id);
  relation.opinion = 0;
  world.time.slowTick = 90;
  updateBorderIncidents(world);
  assert.ok(relation.grievance > 0);
  const tension = relation.tension;
  world.time.slowTick += 15;
  updateBorderIncidents(world);
  assert.equal(relation.tension, tension);
});

test("a banned opposition grows underground but cannot take seats until the ban expires", () => {
  const world = scene(), nation = world.nations[0]!;
  nation.ideologyId = "capitalism";
  const politics = getNationalPolitics(world, nation);
  politics.system = "democracy";
  getNationCharacter(world, nation.id).aggression = 0.8;
  politics.support = new Map([["capitalism", 35], ["communism", 55], ["cohesionism", 10]]);
  world.time.slowTick = politics.nextMandateAt = 120;
  updateNationalPolitics(world);
  assert.equal(politics.suppression?.ideologyId, "communism");
  assert.ok(politics.support.get("communism")! > 55);
  assert.equal(politics.seats.get("communism"), undefined);
  assert.equal([...politics.seats.values()].reduce((a, b) => a + b), 100);
  assert.ok(getDomesticUnrest(world, nation.id).pressure > 0);
  world.time.slowTick = politics.nextMandateAt = 360;
  updateNationalPolitics(world);
  assert.equal(politics.suppression, undefined);
  assert.equal(politics.governingIdeologyId, "communism");
});
