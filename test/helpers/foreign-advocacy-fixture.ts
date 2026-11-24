import assert from "node:assert/strict";
import { getDiplomacyState } from "../../src/sim/diplomacy";
import { getRegionalIdentityGrievance, grievanceLevel } from "../../src/sim/identity-grievances";
import { updatePopulationPolitics } from "../../src/sim/population-politics";
import { getNationalPolitics } from "../../src/sim/politics";
import { updateForeignPoliticalInfluence } from "../../src/sim/political-influence";
import { getRegionalMandate, openRegionalNegotiation, type RegionalNegotiation } from "../../src/sim/regional-negotiations";
import { updateTerritorialGovernance } from "../../src/sim/territorial-governance";
import { getAdjacentNationPairs, getOwnerByMesoId } from "../../src/sim/world-cache";
import { createFixedSocietyWorld, fixedSocietyDistrict } from "./fixed-society-world";

export const district = fixedSocietyDistrict(3, 1);

/** Target nation A, neighbour B, sponsor C, and a fourth government D. */
export function scene({ cooperation = 0.9, ideology = "capitalism", exclude = true } = {}) {
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
export function openDemand(s: ReturnType<typeof scene>) {
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

export function sponsorFinance(world: ReturnType<typeof scene>["world"], sponsorId: string, amount = 90) {
  getDiplomacyState(world).influenceByNationId.set(sponsorId as never, amount);
}

export function expectContact(s: ReturnType<typeof scene>) {
  assert.ok(getAdjacentNationPairs(s.world).some(([a, b]) =>
    a === s.target.id && b === s.sponsor.id || b === s.target.id && a === s.sponsor.id));
}

/** Give several target-owned districts the same grievance-producing population. */
export function openDemands(s: ReturnType<typeof scene>, ids: ReturnType<typeof fixedSocietyDistrict>[]) {
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

export function commitCount(s: ReturnType<typeof scene>) {
  return [...s.world.regionalNegotiations?.values() ?? []]
    .filter(({ foreign, status }) => foreign?.sponsorId === s.sponsor.id &&
      (status === "demand" || status === "deferred" || status === "offer")).length;
}

export function screenAt(s: ReturnType<typeof scene>, tick: number) {
  s.world.time.slowTick = tick;
  s.world.time.fastTick = tick * 10;
  updateForeignPoliticalInfluence(s.world);
}
