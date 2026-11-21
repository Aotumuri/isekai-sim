import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import { getGroupTreatment, type GroupTreatment } from "./identity-policy";
import { getRegionalIdentityGrievance, grievanceLevel, type RegionalIdentityGrievance } from "./identity-grievances";
import { getNationCharacter } from "./nation-character";
import type { NationRuntime } from "./nation-runtime";
import { POPULATION_GROUPS, type PopulationDimension, type RegionalPopulation } from "./regional-population";
import { recordSimulationEvent } from "./simulation-settings";
import type { WorldState } from "./world-state";

type Concession = "autonomous" | "protected";
interface Mandate {
  dimension: PopulationDimension;
  group: number;
  requested: Concession;
  grievance: number;
  exclusion: number;
  constituency: number;
}
export interface RegionalNegotiation extends Mandate {
  owner: NationId;
  status: "demand" | "deferred" | "offer" | "agreed" | "rejected" | "withdrawn" | "violated";
  reviewAt: number;
  ideology?: string;
  offer?: Concession;
  nationalTreatment?: GroupTreatment;
  distrust: number;
  reason: string;
}

export function getRegionalMandate(population: RegionalPopulation, memory?: RegionalIdentityGrievance): Mandate | undefined {
  if (!memory || memory.exclusion < 0.045 || memory.entrenched < 0.022) return;
  const { dimension, group } = memory;
  const constituency = population[dimension][group]! / population.size;
  const grievance = grievanceLevel(memory);
  if (constituency < 0.20 || grievance < 0.12) return;
  const requested = dimension !== "ancestry" && constituency >= 0.32 && grievance >= 0.16 ? "autonomous" : "protected";
  return { dimension, group, requested, constituency, grievance, exclusion: memory.exclusion };
}

function announce(world: WorldState, id: MesoRegionId, talks: RegionalNegotiation, action: string) {
  const group = POPULATION_GROUPS[talks.dimension][talks.group];
  recordSimulationEvent(world, { category: "politics", nationIds: [talks.owner],
    message: `${talks.owner}, district ${id}: ${group} ${action}. ${talks.reason}` });
}

function cabinetIdeology(nation: NationRuntime) {
  return nation.politics?.governingIdeologyId ?? nation.ideologyId;
}

export function openRegionalNegotiation(
  world: WorldState, nation: NationRuntime, id: MesoRegionId, mandate: Mandate,
) {
  const prior = world.regionalNegotiations?.get(id);
  const talks: RegionalNegotiation = {
    ...mandate, owner: nation.id, status: "demand", reviewAt: world.time.slowTick + 10,
    distrust: prior?.owner === nation.id ? prior.distrust : 0, ideology: cabinetIdeology(nation),
    reason: "Sustained unequal treatment mobilized a substantial local constituency.",
  };
  (world.regionalNegotiations ??= new Map()).set(id, talks);
  announce(world, id, talks, talks.requested === "autonomous" ? "demanded local control of institutions" : "demanded institutional protections");
}

export function mayOpenRegionalNegotiation(
  world: WorldState, nation: NationRuntime, id: MesoRegionId, mandate: Mandate,
): boolean {
  const prior = world.regionalNegotiations?.get(id);
  if (!prior || prior.owner !== nation.id) return true;
  if (!["rejected", "withdrawn", "violated"].includes(prior.status) || world.time.slowTick < prior.reviewAt) return false;
  return prior.ideology !== cabinetIdeology(nation) || prior.group !== mandate.group ||
    prior.dimension !== mandate.dimension ||
    mandate.exclusion - prior.exclusion >= 0.06 || mandate.constituency - prior.constituency >= 0.18;
}

function resolve(world: WorldState, id: MesoRegionId, talks: RegionalNegotiation,
  status: "agreed" | "rejected" | "withdrawn" | "violated", reason: string) {
  talks.status = status;
  talks.reason = reason;
  talks.reviewAt = world.time.slowTick + (status === "agreed" ? 10 : 100);
  if (status === "rejected") talks.distrust = Math.min(0.35, talks.distrust + 0.10);
  if (status === "violated") {
    talks.distrust = Math.min(0.35, talks.distrust + 0.24);
    // Require a meaningful change before talks resume. The breach itself changes the mandate.
    talks.exclusion = 0;
  }
  announce(world, id, talks, {
    agreed: `secured ${talks.offer === "autonomous" ? "local control of institutions" : "statutory protections"}`,
    rejected: "negotiations failed", withdrawn: "withdrew the demand", violated: "agreement was violated",
  }[status]);
}

/** Review existing cases during the same district pass that measures grievances. */
export function reviewRegionalNegotiation(
  world: WorldState, nation: NationRuntime, id: MesoRegionId, population: RegionalPopulation, atWar: boolean,
) {
  const talks = world.regionalNegotiations?.get(id), now = world.time.slowTick;
  if (!talks || talks.owner !== nation.id || now < talks.reviewAt) return;
  const nationalTreatment = getGroupTreatment(nation, talks.dimension, talks.group);
  if (talks.status === "agreed") {
    if (nationalTreatment !== talks.nationalTreatment && (nationalTreatment === "restricted" || nationalTreatment === "assimilation")) {
      resolve(world, id, talks, "violated", "A new central policy overrode the district's guarantee.");
      talks.ideology = cabinetIdeology(nation);
    } else {
      talks.nationalTreatment = nationalTreatment;
      talks.reviewAt = now + 10;
    }
    return;
  }
  if (talks.status === "violated" || talks.status === "rejected" || talks.status === "withdrawn") return;
  const constituency = population[talks.dimension][talks.group]! / population.size;
  if (constituency < 0.12) {
    resolve(world, id, talks, "withdrawn", "The movement lost its local constituency.");
    return;
  }
  if (nationalTreatment === "autonomous" || (nationalTreatment === "protected" && talks.requested === "protected")) {
    resolve(world, id, talks, "withdrawn", "National reforms already met the movement's demand.");
    return;
  }
  if (talks.status === "offer") {
    const localGrievance = grievanceLevel(getRegionalIdentityGrievance(world, id, nation.id));
    const adequate = talks.offer === talks.requested ||
      (talks.offer === "protected" && Math.max(talks.grievance, localGrievance) + talks.distrust < 0.44);
    if (adequate) {
      talks.nationalTreatment = nationalTreatment;
      resolve(world, id, talks, "agreed", talks.offer === talks.requested ?
        "The movement accepted enforceable local guarantees." :
        "The movement accepted protection because it ends the immediate unequal treatment.");
    } else {
      resolve(world, id, talks, "rejected", "The movement refused protections without control of its institutions after sustained exclusion.");
    }
    return;
  }
  const character = nation.character ?? getNationCharacter(world, nation.id);
  const ideology = cabinetIdeology(nation);
  const cohesionist = ideology === "cohesionism" || ideology === "avian-supremacy";
  const democracy = nation.politics?.system === "democracy";
  const support = (ideology ? nation.politics?.support.get(ideology) ?? 50 : 50) / 100;
  const legitimacy = (nation.identityStability?.legitimacy ?? 100) / 100;
  const hardship = world.settings?.foodEnabled === false ? 0 : 1 - (nation.food?.rationCoverage ?? 1);
  if (atWar && hardship > 0.20 && talks.status === "demand") {
    talks.status = "deferred";
    talks.reviewAt = now + 20;
    talks.reason = "The cabinet postponed the hearing once amid wartime shortages.";
    return;
  }
  const strategic = id === nation.capitalMesoId;
  const willing = talks.grievance * 0.9 + constituency * 0.22 + character.cooperation * 0.48 +
    (1 - legitimacy) * 0.45 + (democracy ? (1 - support) * 0.20 : 0) - talks.distrust * 0.2 -
    (cohesionist ? 0.30 + support * 0.12 : 0) - (atWar ? 0.12 : 0) - hardship * 0.11;
  if (willing < 0.34) {
    resolve(world, id, talks, "rejected", cohesionist ?
      "The governing coalition prioritized uniform institutions over the local demand." :
      "The cabinet judged its political and administrative capacity insufficient for concessions.");
    return;
  }
  talks.offer = willing >= (strategic ? 0.82 : 0.61) ? talks.requested : "protected";
  talks.status = "offer";
  talks.reviewAt = now + 10;
  talks.reason = talks.offer === talks.requested ? "The cabinet sought to recover legitimacy by meeting the demand." :
    strategic ? "The cabinet retained control of institutions in the capital." : "The cabinet offered safeguards while retaining central oversight.";
  announce(world, id, talks, talks.offer === "autonomous" ? "received an offer of local control" : "received an offer of protections");
}
