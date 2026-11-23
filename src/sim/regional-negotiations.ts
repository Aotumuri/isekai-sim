import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import { getEffectiveTreatment, getGroupTreatment, type GroupTreatment } from "./identity-policy";
import { getRegionalIdentityGrievance, grievanceLevel, type RegionalIdentityGrievance } from "./identity-grievances";
import { getNationCharacter } from "./nation-character";
import type { NationRuntime } from "./nation-runtime";
import { POPULATION_GROUPS, type PopulationDimension, type RegionalPopulation } from "./regional-population";
import { queueRegionalDemand } from "./foreign-advocacy-schedule";
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
interface Refusal {
  ideology?: string;
  treatment: GroupTreatment;
  exclusion: number;
  constituency: number;
}

const mandateKey = ({ dimension, group, requested }: Mandate) => `${dimension}:${group}:${requested}`;
const demandSatisfied = (treatment: GroupTreatment, demand: Concession) =>
  treatment === "autonomous" || (treatment === "protected" && demand === "protected");

export interface RegionalNegotiation extends Mandate {
  owner: NationId;
  status: "demand" | "deferred" | "offer" | "agreed" | "rejected" | "withdrawn" | "violated";
  reviewAt: number;
  ideology?: string;
  offer?: Concession;
  nationalTreatment?: GroupTreatment;
  distrust: number;
  refusals?: Partial<Record<string, Refusal>>;
  /** Foreign diplomatic support for this demand; one sponsor at a time. */
  foreign?: ForeignBacking;
  /** Sponsors this movement turned down, with the slow tick when it may listen again. */
  foreignRefusals?: Partial<Record<NationId, number>>;
  reason: string;
}

export interface ForeignBacking {
  sponsorId: NationId;
  /** Current effectiveness after decay (0..1). */
  strength: number;
  /** How strongly the domestic government can repudiate outside involvement (0..1). */
  backlash: number;
  since: number;
  renewAt: number;
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
    refusals: prior?.owner === nation.id ? prior.refusals : undefined,
    foreignRefusals: prior?.owner === nation.id ? prior.foreignRefusals : undefined,
    reason: "Sustained unequal treatment mobilized a substantial local constituency.",
  };
  (world.regionalNegotiations ??= new Map()).set(id, talks);
  queueRegionalDemand(world, id, talks);
  world.instrumentation?.observeRegionalAdvocacy?.({ kind: "opened", id, talks });
  const reopened = prior?.owner === nation.id && ["rejected", "withdrawn", "violated"].includes(prior.status);
  world.instrumentation?.incrementCounter(reopened ? "regionalNegotiations.reopened" : "regionalNegotiations.opened");
  announce(world, id, talks, talks.requested === "autonomous" ? "demanded local control of institutions" : "demanded institutional protections");
}

export function mayOpenRegionalNegotiation(
  world: WorldState, nation: NationRuntime, id: MesoRegionId, mandate: Mandate,
): boolean {
  const treatment = getEffectiveTreatment(world, nation, mandate.dimension, mandate.group);
  if (demandSatisfied(treatment, mandate.requested)) return false;
  const prior = world.regionalNegotiations?.get(id);
  if (!prior || prior.owner !== nation.id) return true;
  if (!["rejected", "withdrawn", "violated"].includes(prior.status) || world.time.slowTick < prior.reviewAt) return false;
  const refusal = prior.refusals?.[mandateKey(mandate)];
  return !refusal || refusal.ideology !== cabinetIdeology(nation) || refusal.treatment !== treatment ||
    mandate.exclusion - refusal.exclusion >= 0.06 || mandate.constituency - refusal.constituency >= 0.18;
}

function rememberRefusal(world: WorldState, nation: NationRuntime, talks: RegionalNegotiation) {
  (talks.refusals ??= {})[mandateKey(talks)] = {
    ideology: cabinetIdeology(nation), treatment: getEffectiveTreatment(world, nation, talks.dimension, talks.group),
    exclusion: talks.exclusion, constituency: talks.constituency,
  };
}

function resolve(world: WorldState, id: MesoRegionId, talks: RegionalNegotiation,
  status: "agreed" | "rejected" | "withdrawn" | "violated", reason: string) {
  talks.status = status;
  world.instrumentation?.observeRegionalAdvocacy?.({ kind: "closed", id, talks });
  talks.reason = reason;
  talks.reviewAt = world.time.slowTick + (status === "agreed" ? 10 : 100);
  if (talks.foreign) {
    if (status === "agreed") world.instrumentation?.incrementCounter("foreignAdvocacy.agreements");
    delete talks.foreign;
  }
  world.instrumentation?.incrementCounter(`regionalNegotiations.${
    status === "agreed" ? "agreed" : status === "rejected" ? "rejected" : status === "withdrawn" ? "withdrawn" : "violated"}`);
  if (status === "rejected") talks.distrust = Math.min(0.35, talks.distrust + 0.10);
  if (status === "violated") {
    talks.distrust = Math.min(0.35, talks.distrust + 0.24);
    // A broken guarantee creates a fresh basis for the affected demand.
    if (talks.refusals) delete talks.refusals[mandateKey(talks)];
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
  if (talks.status === "violated" || talks.status === "rejected" || talks.status === "withdrawn") {
    // A later national reform can satisfy a demand that was refused earlier. Close the case
    // honestly instead of leaving a failed negotiation on record forever.
    if (talks.status !== "withdrawn" &&
      demandSatisfied(getEffectiveTreatment(world, nation, talks.dimension, talks.group), talks.requested)) {
      if (talks.refusals) delete talks.refusals[mandateKey(talks)];
      resolve(world, id, talks, "withdrawn", "National reforms later met the movement's demand.");
    }
    return;
  }
  world.instrumentation?.observeRegionalAdvocacy?.({ kind: "review", id, talks });
  const constituency = population[talks.dimension][talks.group]! / population.size;
  if (constituency < 0.12) {
    resolve(world, id, talks, "withdrawn", "The movement lost its local constituency.");
    return;
  }
  if (demandSatisfied(getEffectiveTreatment(world, nation, talks.dimension, talks.group), talks.requested)) {
    resolve(world, id, talks, "withdrawn", "National reforms already met the movement's demand.");
    return;
  }
  if (talks.status === "offer") {
    const localGrievance = grievanceLevel(getRegionalIdentityGrievance(world, id, nation.id));
    // Recognized movements hold out for enforceable control rather than a partial guarantee.
    const backing = talks.foreign, external = backing?.strength ?? 0;
    const pressure = Math.max(talks.grievance, localGrievance) + talks.distrust;
    const adequate = talks.offer === talks.requested ||
      (talks.offer === "protected" && pressure < 0.44) ||
      (talks.offer === "protected" && pressure < 0.44 - external * 0.05);
    if (adequate) {
      talks.nationalTreatment = nationalTreatment;
      resolve(world, id, talks, "agreed", talks.offer === talks.requested ?
        "The movement accepted enforceable local guarantees." :
        "The movement accepted protection because it ends the immediate unequal treatment.");
    } else {
      rememberRefusal(world, nation, talks);
      world.instrumentation?.incrementCounter("regionalNegotiations.refusedOffer");
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
    world.instrumentation?.incrementCounter("regionalNegotiations.deferred");
    return;
  }
  const strategic = id === nation.capitalMesoId;
  // Foreign recognition can raise the political cost of refusal, but a government that can
  // repudiate the sponsor's motives may harden instead. Both effects are bounded.
  const backing = talks.foreign, external = backing?.strength ?? 0, backlash = backing?.backlash ?? 0;
  const domesticWillingness = talks.grievance * 0.9 + constituency * 0.22 + character.cooperation * 0.48 +
    (1 - legitimacy) * 0.45 + (democracy ? (1 - support) * 0.20 : 0) - talks.distrust * 0.2 -
    (cohesionist ? 0.30 + support * 0.12 : 0) - (atWar ? 0.12 : 0) - hardship * 0.11;
  const decision = (value: number) => value < 0.34 ? "reject" :
    talks.requested === "protected" || value >= (strategic ? 0.82 : 0.61) ? "full" : "partial";
  const actual = decision(domesticWillingness + external * (0.12 - backlash * 0.20));
  if (world.instrumentation) {
    const withoutBacking = backing ? decision(domesticWillingness) : actual;
    if (backing) {
      world.instrumentation.incrementCounter("foreignAdvocacy.negotiationReviewsWithBacking");
      if (actual !== withoutBacking) world.instrumentation.incrementCounter("foreignAdvocacy.decisionsChanged");
    }
    world.instrumentation.observeRegionalAdvocacy?.({ kind: "governmentDecision", id, talks, actual, withoutBacking });
  }
  if (actual === "reject") {
    rememberRefusal(world, nation, talks);
    world.instrumentation?.incrementCounter(cohesionist ? "regionalNegotiations.rejected.uniformity" : "regionalNegotiations.rejected.capacity");
    resolve(world, id, talks, "rejected", cohesionist ?
      "The governing coalition prioritized uniform institutions over the local demand." :
      "The cabinet judged its political and administrative capacity insufficient for concessions.");
    return;
  }
  talks.offer = actual === "full" ? talks.requested : "protected";
  talks.status = "offer";
  talks.reviewAt = now + 10;
  world.instrumentation?.incrementCounter(talks.offer === talks.requested ? "regionalNegotiations.offered.full" : "regionalNegotiations.offered.partial");
  talks.reason = talks.offer === talks.requested ? "The cabinet sought to recover legitimacy by meeting the demand." :
    strategic ? "The cabinet retained control of institutions in the capital." : "The cabinet offered safeguards while retaining central oversight.";
  if (talks.foreign) talks.reason += " International recognition of the demand shaped the cabinet's calculation.";
  announce(world, id, talks, talks.offer === "autonomous" ? "received an offer of local control" : "received an offer of protections");
}
