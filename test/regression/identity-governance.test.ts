import assert from "node:assert/strict";
import test from "node:test";
import { updateCivilWar } from "../../src/sim/civil-war";
import { getRelation } from "../../src/sim/diplomacy";
import { getDomesticUnrest } from "../../src/sim/domestic-unrest";
import { getRegionalIdentityGrievance, grievanceLevel } from "../../src/sim/identity-grievances";
import { getEffectiveTreatment, getGroupTreatment } from "../../src/sim/identity-policy";
import { updateNationalistMovements } from "../../src/sim/nationalist-movements";
import { getNationalPolitics, updateNationalPolitics } from "../../src/sim/politics";
import { updatePopulationMigration } from "../../src/sim/population-migration";
import { updatePopulationPolitics } from "../../src/sim/population-politics";
import { POPULATION_DIMENSIONS } from "../../src/sim/regional-population";
import { startReligiousBan } from "../../src/sim/religious-persecution";
import { updateSubjectAutonomy } from "../../src/sim/subject-autonomy";
import { rankRevolutionOrigins } from "../../src/sim/revolution-origins";
import { setGovernancePolicy, updateTerritorialGovernance } from "../../src/sim/territorial-governance";
import { transferTerritories } from "../../src/sim/territory-transfer";
import { getOwnerByMesoId } from "../../src/sim/world-cache";
import { createSocietyWorld } from "../helpers/society-world";

const shares = (size: number, a: number, b: number, c = 0) => [a * size, b * size, c * size, 0, 0, 0];

function scene() {
  const world = createSocietyWorld(), [other, nation] = world.nations;
  world.settings!.politicalTurbulenceEnabled = true;
  const populations = world.regionalPopulations!;
  const district = nation.capitalMesoId, capital = populations.get(district)!;
  const owners = getOwnerByMesoId(world);
  for (const [id, population] of populations) {
    population.ancestry = shares(population.size, 0.2, 0.6, 0.2);
    population.culture = shares(population.size, 0.25, 0.55, 0.2);
    population.faith = owners.get(id) === nation.id
      ? shares(population.size, 0.55, 0.25, 0.2) : shares(population.size, 0.2, 0.2, 0.6);
  }
  // A legacy minority homeland mandate is stronger evidence for recognition than census data.
  nation.populationPolicy = { type: "homeland", group: 0 };
  other.populationPolicy = { type: "religious", group: 2 };
  updatePopulationPolitics(world);
  const government = nation.identityGovernment!;
  const local = () => getRegionalIdentityGrievance(world, district, nation.id);
  const advance = (cycles: number) => {
    for (let i = 0; i < cycles; i++) {
      world.time.slowTick += 10;
      world.time.fastTick += 100;
      updateTerritorialGovernance(world);
    }
  };
  return { world, nation, other, populations, capital, government, local, advance };
}

test("minority recognition survives census updates and a diverse centralized society stays stable", () => {
  const { world, nation, populations, capital, government, advance, local } = scene();
  assert.equal(government.favored.ancestry, "auvren");
  assert.equal(capital.ancestry[0]! / capital.size, 0.2);
  for (const country of world.nations) country.identityGovernment!.nextReviewAt = Infinity;
  const census = structuredClone(populations);
  advance(12);
  assert.equal(government.favored.ancestry, "auvren");
  assert.equal(nation.governance!.policy, "centralized");
  assert(nation.governance!.diversity > 0.4);
  assert.equal(nation.identityStability!.legitimacy, 100);
  assert.equal(grievanceLevel(local()), 0);
  assert.deepEqual(populations, census);
  assert.equal(world.populationRevision, undefined);
});

test("separate group treatments coexist and only affected shares contribute to grievances", (t) => {
  const { nation, government, local, advance } = scene();
  government.nextReviewAt = Infinity;
  government.treatments.ancestry.auvren = "protected";
  government.treatments.culture["reed-courts"] = "autonomous";
  government.treatments.faith["ember-covenant"] = "protected";
  government.treatments.faith["nine-wells"] = "restricted";
  assert.equal(getGroupTreatment(nation, "ancestry", 0), "protected");
  assert.equal(getGroupTreatment(nation, "culture", 0), "autonomous");
  assert.equal(getGroupTreatment(nation, "faith", 0), "protected");
  assert.equal(getGroupTreatment(nation, "faith", 1), "restricted");
  assert.equal(getGroupTreatment(nation, "faith", 2), "tolerated");
  assert.equal(government.favored.culture, "tide-guilds");
  assert.equal(government.favored.faith, "ember-covenant");
  advance(1);
  assert.equal(local()!.exclusion, 0.25 / 3);
  assert.equal(local()!.dimension, "faith");
  assert.equal(local()!.group, 1);
  assert(local()!.shock > 0);
  assert(nation.identityStability!.legitimacy < 100);
  t.diagnostic(`25% religious minority restricted, exclusion ${local()!.exclusion.toFixed(4)}, grievance ${grievanceLevel(local()).toFixed(4)}`);
  government.treatments.faith["silent-orbit"] = "restricted";
  advance(1);
  assert.equal(local()!.exclusion, 0.45 / 3);
});

test("lasting exclusion leaves a longer recovery than a temporary policy", (t) => {
  const outcomes = [1, 20].map((length) => {
    const { world, nation, government, advance, local, populations } = scene();
    government.nextReviewAt = Infinity;
    // Keep the same total exposure while isolating memory from organized local bargaining.
    for (const [id, owner] of getOwnerByMesoId(world)) {
      const population = populations.get(id);
      if (population && owner === nation.id) {
        population.ancestry = [0.2, 0.15, 0.2, 0.15, 0.15, 0.15].map((share) => share * population.size);
      }
    }
    const affected = ["veyari", "orruvi", "nhalai", "istren"] as const;
    for (const group of affected) government.treatments.ancestry[group] = "restricted";
    advance(length);
    const peak = grievanceLevel(local());
    for (const group of affected) government.treatments.ancestry[group] = "protected";
    advance(1);
    assert.equal(local()!.exclusion, 0);
    assert(grievanceLevel(local()) > 0);
    advance(9);
    const residual = grievanceLevel(local());
    assert(residual < peak);
    assert(nation.identityStability!.legitimacy > 95);
    advance(200);
    assert.equal(grievanceLevel(local()), 0);
    return { peak, residual };
  });
  assert(outcomes[1]!.residual > outcomes[0]!.residual * 4);
  t.diagnostic(outcomes.map(({ peak, residual }) => `${peak.toFixed(4)} → ${residual.toFixed(4)}`).join(", "));
});

test("culture and religion change independently and neither changes ancestry or regional population", () => {
  const { world, government, populations, capital, advance } = scene();
  government.nextReviewAt = Infinity;
  const ancestry = [...capital.ancestry], faith = [...capital.faith];
  const populationBefore = [...populations.values()].reduce((sum, population) => sum + population.size, 0);
  government.treatments.culture["reed-courts"] = "assimilation";
  advance(1);
  assert(capital.culture[0]! < capital.size * 0.25);
  assert(capital.culture[1]! > capital.size * 0.55);
  assert.deepEqual(capital.ancestry, ancestry);
  assert.deepEqual(capital.faith, faith);
  const culture = [...capital.culture];
  delete government.treatments.culture["reed-courts"];
  government.treatments.faith["nine-wells"] = "assimilation";
  advance(1);
  assert(Math.abs(capital.faith[1]! - faith[1]! * 0.995) < 1e-12);
  assert.deepEqual(capital.culture, culture);
  assert.deepEqual(capital.ancestry, ancestry);
  assert.equal([...populations.values()].reduce((sum, population) => sum + population.size, 0), populationBefore);
  assert.equal(world.populationRevision, 2);
  for (const population of populations.values()) for (const dimension of POPULATION_DIMENSIONS) {
    assert(population[dimension].every((count) => Number.isFinite(count) && count >= 0));
    assert(Math.abs(population[dimension].reduce((sum, count) => sum + count, 0) - population.size) < 1e-10);
  }
});

test("regional autonomy dampens coercion, preserves existing culture and carries a cost when revoked", () => {
  const { world, nation, government, capital, advance, local } = scene();
  government.nextReviewAt = Infinity;
  government.treatments.culture["reed-courts"] = "assimilation";
  setGovernancePolicy(world, nation.id, nation.id, "autonomy");
  const culture = [...capital.culture];
  advance(4);
  assert.deepEqual(capital.culture, culture);
  assert.equal(local()!.autonomyDemand, 0);
  setGovernancePolicy(world, nation.id, nation.id, "centralized");
  advance(1);
  assert(local()!.autonomyLoss > 0.2);
  assert(local()!.autonomyDemand > 0);
  assert(capital.culture[0]! < culture[0]!);
});

test("religious protections take precedence over a temporary blanket ban", () => {
  const { world, other } = scene();
  assert.equal(other.populationPolicy?.type, "religious");
  other.identityGovernment!.treatments.faith["ember-covenant"] = "protected";
  assert(startReligiousBan(world, other));
  assert.equal(getEffectiveTreatment(world, other, "faith", 0), "protected");
  assert.equal(getEffectiveTreatment(world, other, "faith", 1), "restricted");
  assert.equal(getEffectiveTreatment(world, other, "faith", 2), "tolerated");
});

test("government ideology affects autonomous decisions, which are deterministic and have a cooldown", () => {
  function choose(ideology: string) {
    const { world, nation, government, advance } = scene();
    const politics = getNationalPolitics(world, nation);
    politics.system = "democracy";
    politics.governingIdeologyId = ideology;
    politics.support = new Map([[ideology, 65]]);
    nation.character = { doctrine: "guardian", aggression: 0.55, cooperation: 0.64, innovation: 0.5, thrift: 0.5 };
    government.nextReviewAt = 10;
    advance(1);
    assert.equal(government.decisionCount, 1);
    advance(7);
    assert.equal(government.decisionCount, 1);
    advance(70);
    const { decisions } = government;
    assert(decisions.length <= 6);
    assert(decisions.slice(1).every((entry, index) => entry.day - decisions[index]!.day >= 800));
    return structuredClone(government);
  }
  const cooperative = choose("capitalism"), assimilationist = choose("cohesionism");
  assert.deepEqual(choose("capitalism"), cooperative);
  assert.deepEqual(choose("cohesionism"), assimilationist);
  assert(cooperative.decisions.some(({ action }) => action === "protected"));
  assert(assimilationist.decisions.some(({ dimension, action }) => dimension === "culture" && action === "assimilation"));
  assert(!assimilationist.decisions.some(({ dimension, action }) => dimension !== "culture" && action === "assimilation"));
});

test("subject recognition weighs sponsor backing against local autonomy and established communities", (t) => {
  function subjectPressure(autonomy: number) {
    const { world, nation, other, government, capital, advance } = scene();
    nation.subjectGovernment = { overlordId: other.id, establishedAtFastTick: 0, autonomy };
    nation.ideologyId = other.ideologyId = "capitalism";
    getRelation(world, nation.id, other.id).trust = 95;
    other.identityGovernment!.favored.ancestry = government.favored.ancestry;
    const faith = [...capital.faith];
    government.nextReviewAt = 10;
    advance(1);
    assert.deepEqual(capital.faith, faith);
    return government;
  }
  const dependent = subjectPressure(0), autonomous = subjectPressure(90);
  assert(dependent.decisions.some(({ dimension, group, reason }) =>
    dimension === "faith" && group === "silent-orbit" && reason.includes("overlord")));
  assert(!autonomous.decisions.some(({ reason }) => reason.includes("overlord")));
  t.diagnostic(JSON.stringify(dependent.decisions[0]));
});

test("subject independence pressure responds to policy grievances while local autonomy relieves them", () => {
  function pressure(treatment: boolean, autonomy: boolean) {
    const { world, nation, other, government, advance } = scene();
    nation.subjectGovernment = { overlordId: other.id, establishedAtFastTick: 0, autonomy: 45 };
    getRelation(world, nation.id, other.id).trust = 70;
    government.nextReviewAt = Infinity;
    setGovernancePolicy(world, nation.id, nation.id, autonomy ? "autonomy" : "centralized");
    if (treatment) government.treatments.ancestry.veyari = "restricted";
    advance(10);
    updateSubjectAutonomy(world);
    return nation.subjectGovernment!.autonomy!;
  }
  const tolerated = pressure(false, false), restricted = pressure(true, false), autonomous = pressure(true, true);
  assert(restricted > tolerated);
  assert(autonomous < tolerated);
});

test("an autonomous reform restores safeguards and legitimacy", (t) => {
  const { nation, government, advance } = scene();
  nation.ideologyId = "capitalism";
  nation.character = { doctrine: "guardian", aggression: 0.25, cooperation: 0.85, innovation: 0.5, thrift: 0.5 };
  government.nextReviewAt = 130;
  government.treatments.ancestry.veyari = "restricted";
  advance(12);
  const prior = nation.identityStability!.legitimacy;
  advance(1);
  assert.equal(government.decisions[0]!.action, "protected");
  assert.equal(government.decisions[0]!.group, "veyari");
  advance(10);
  assert(nation.identityStability!.legitimacy > prior);
  t.diagnostic(`legitimacy ${prior.toFixed(1)} → ${nation.identityStability!.legitimacy.toFixed(1)}`);
});

test("revolution origins and nationalist movements can cite exclusion, without making grievances alone a revolt trigger", () => {
  const { world, nation, other, government, advance } = scene();
  assert.deepEqual(rankRevolutionOrigins(world, nation), []);
  government.nextReviewAt = Infinity;
  other.identityGovernment!.nextReviewAt = Infinity;
  for (const [id, owner] of getOwnerByMesoId(world)) if (owner === other.id) {
    const p = world.regionalPopulations!.get(id)!;
    p.ancestry = shares(p.size, 0.65, 0.35);
  }
  other.identityGovernment!.treatments.ancestry.auvren = "restricted";
  advance(9);
  government.treatments.ancestry.veyari = "restricted";
  government.treatments.culture["tide-guilds"] = "restricted";
  government.treatments.faith["ember-covenant"] = "restricted";
  setGovernancePolicy(world, nation.id, nation.id, "centralized");
  advance(3);
  const origins = rankRevolutionOrigins(world, nation);
  assert(origins.length > 0);
  assert.equal(origins[0]!.dimension, "ancestry");
  getDomesticUnrest(world, nation.id).pressure = 100;
  const count = world.nations.length;
  updateCivilWar(world);
  assert.equal(world.nations.length, count);
  updateNationalistMovements(world);
  assert.equal(nation.nationalistMovement?.targetId, other.id);
  assert(getRelation(world, nation.id, other.id).grievance > 30);
  const politics = getNationalPolitics(world, nation);
  politics.nextSupportReviewAt = world.time.slowTick;
  getDomesticUnrest(world, nation.id).pressure = 0;
  const incumbentBefore = politics.support.get(politics.governingIdeologyId);
  updateNationalPolitics(world);
  assert(politics.support.get(politics.governingIdeologyId)! < incumbentBefore!);
});

test("district history survives a territorial transfer and migration conserves each marginal distribution", () => {
  const { world, nation, other, government, populations, advance } = scene();
  government.nextReviewAt = Infinity;
  other.identityGovernment!.nextReviewAt = Infinity;
  const province = world.macroRegions.find(({ nationId, mesoRegionIds }) =>
    nationId === nation.id && !mesoRegionIds.includes(nation.capitalMesoId))!;
  const id = province.mesoRegionIds[0]!;
  government.treatments.ancestry.veyari = "restricted";
  advance(10);
  const before = grievanceLevel(getRegionalIdentityGrievance(world, id, nation.id));
  assert(before > 0);
  const totals = () => POPULATION_DIMENSIONS.map((dimension) =>
    [...populations.values()].reduce((sum, population) => sum + population[dimension][1]!, 0));
  const original = totals();
  assert(transferTerritories(world, [{ from: nation.id, to: other.id, regionIds: [...province.mesoRegionIds] }], "agreement"));
  assert.equal(getOwnerByMesoId(world).get(id), other.id);
  assert.equal(getRegionalIdentityGrievance(world, id, other.id), undefined);
  updatePopulationMigration(world);
  advance(1);
  const after = getRegionalIdentityGrievance(world, id, other.id);
  assert(after && grievanceLevel(after) < before && grievanceLevel(after) > 0 && after.exclusion === 0);
  totals().forEach((value, i) => assert(Math.abs(value - original[i]!) < 1e-8));
});
