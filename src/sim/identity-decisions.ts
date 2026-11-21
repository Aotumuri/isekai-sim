import type { NationId } from "../worldgen/nation";
import { relationKey } from "./diplomacy";
import {
  getGroupTreatment, IDENTITY_GROUP_IDS, identityGroupIndex, identityGroupName,
  type GroupTreatment, type IdentityDecision, type IdentityGovernment,
} from "./identity-policy";
import { getNationCharacter } from "./nation-character";
import type { NationRuntime } from "./nation-runtime";
import { dominantGroup, POPULATION_DIMENSIONS, type PopulationDimension, type RegionalPopulation } from "./regional-population";
import { recordSimulationEvent } from "./simulation-settings";
import type { WorldState } from "./world-state";

const REVIEW_INTERVAL = 40;
const DECISION_COOLDOWN = 80;
const HISTORY_LIMIT = 6;

export interface OverlordIdentity {
  id: NationId;
  favored: IdentityGovernment["favored"];
  ideology: string | undefined;
}

interface Candidate {
  dimension: PopulationDimension;
  group: number;
  action: IdentityDecision["action"];
  score: number;
  reason: string;
}

function recordDecision(world: WorldState, nation: NationRuntime, { dimension, group, action, reason }: Candidate): void {
  const government = nation.identityGovernment!;
  const id = IDENTITY_GROUP_IDS[dimension][group]!;
  const name = identityGroupName(dimension, id);
  if (action === "recognition") {
    if (dimension === "ancestry") government.favored.ancestry = IDENTITY_GROUP_IDS.ancestry[group]!;
    if (dimension === "culture") {
      const culture = IDENTITY_GROUP_IDS.culture[group]!;
      government.favored.culture = culture;
      if (government.treatments.culture[culture] === "assimilation") delete government.treatments.culture[culture];
    }
    if (dimension === "faith") {
      const faith = IDENTITY_GROUP_IDS.faith[group]!;
      government.favored.faith = faith;
      if (government.treatments.faith[faith] === "assimilation") delete government.treatments.faith[faith];
    }
    const program = nation.populationPolicy;
    if ((program?.type === "homeland" && dimension === "ancestry") ||
        (program?.type === "religious" && dimension === "faith")) {
      program.group = group;
      world.populationPolicyRevision = (world.populationPolicyRevision ?? 0) + 1;
    }
  } else {
    const treatments: Partial<Record<string, GroupTreatment>> = government.treatments[dimension];
    if (action === "tolerated") delete treatments[id];
    else treatments[id] = action;
  }
  government.decisions.push({ day: world.time.fastTick, dimension, group: id, action, reason });
  if (government.decisions.length > HISTORY_LIMIT) government.decisions.shift();
  government.decisionCount++;
  recordSimulationEvent(world, { category: "politics", nationIds: [nation.id],
    message: `${nation.id} ${action === "recognition" ? "recognized" : `adopted ${action} treatment for`} ${name} (${dimension}). ${reason}` });
}

export function reviewIdentityPolicies(
  world: WorldState, nation: NationRuntime, population: RegionalPopulation,
  overlord: OverlordIdentity | undefined, atWar: boolean,
): void {
  const government = nation.identityGovernment!, now = world.time.slowTick;
  if (now < government.nextReviewAt) return;
  government.nextReviewAt = now + REVIEW_INTERVAL;

  const character = nation.character ?? getNationCharacter(world, nation.id);
  const ideology = nation.politics?.governingIdeologyId ?? nation.ideologyId;
  const cohesionist = ideology === "cohesionism";
  const democracy = nation.politics?.system === "democracy";
  const support = (ideology ? nation.politics?.support.get(ideology) ?? 50 : 50) / 100;
  const legitimacy = (nation.identityStability?.legitimacy ?? 100) / 100;
  const autonomy = (nation.subjectGovernment?.autonomy ?? 0) / 100;
  const hunger = world.settings?.foodEnabled === false ? 0 : 1 - (nation.food?.rationCoverage ?? 1);
  const cooperation = character.cooperation;
  const reform = (1 - legitimacy) * 2 + (1 - support) * (democracy ? 0.5 : 0.2) + hunger * 0.3;
  const relation = overlord && world.diplomacy?.relations.get(relationKey(nation.id, overlord.id));
  const sponsorIdeology = overlord?.ideology;
  const dependence = overlord && !nation.subjectGovernment?.selfGovernment ? (1 - autonomy) * ((sponsorIdeology === ideology ? 0.3 : 0) +
    Math.max(0, relation?.trust ?? 0) / 170 + (atWar ? 0.12 : 0)) : 0;
  let best: Candidate | undefined;
  const consider = (dimension: PopulationDimension, group: number, action: Candidate["action"], score: number, reason: string) => {
    if (score >= 0.45 && (!best || score > best.score)) best = { dimension, group, action, score, reason };
  };

  for (const dimension of POPULATION_DIMENSIONS) {
    const favored = identityGroupIndex(dimension, government.favored[dimension]);
    const groups = population[dimension];
    const sponsorId = overlord?.favored[dimension];
    const sponsorGroup = sponsorId && !nation.subjectGovernment?.selfGovernment ? identityGroupIndex(dimension, sponsorId) : -1;
    const shareOf = (group: number) => (groups[group] ?? 0) / population.size;
    const localMajority = dominantGroup(groups);
    if (localMajority !== favored) {
      consider(dimension, localMajority, "recognition",
        (shareOf(localMajority) - shareOf(favored)) * (0.55 + reform + autonomy) - dependence - 0.2,
        "The cabinet sought broader local representation.");
    }
    if (sponsorGroup >= 0 && sponsorGroup !== favored) {
      const localCost = Math.max(0, shareOf(localMajority) - shareOf(sponsorGroup));
      consider(dimension, sponsorGroup, "recognition", dependence * 1.75 - localCost * (0.5 + reform) - autonomy,
        "The cabinet sought its overlord's political backing despite a different local constituency.");
    }
    groups.forEach((count, group) => {
      const share = count / population.size;
      const current = getGroupTreatment(nation, dimension, group);
      const coercive = current === "restricted" || current === "assimilation";
      if (share < 0.025 && !coercive) return;
      if (current !== "protected" && current !== "autonomous" && (group !== favored || coercive)) {
        consider(dimension, group, "protected",
          (cooperation - 0.45) * 1.15 + share * 0.65 + (coercive ? 0.35 + reform : 0) -
            (cohesionist && !coercive ? 0.35 : 0),
          coercive ? "The cabinet restored safeguards amid opposition to unequal treatment." :
            "The cabinet extended institutional safeguards to a community with local representation.");
      }
      if (dimension !== "ancestry" && group !== favored && current !== "autonomous" &&
          nation.governance?.policy === "autonomy" && share >= 0.15) {
        consider(dimension, group, "autonomous", cooperation * 0.45 + share * 0.5 + (coercive ? reform : 0) - 0.1,
          "The cabinet delegated oversight of local institutions.");
      }
      if (current !== "tolerated" && coercive) {
        consider(dimension, group, "tolerated", reform * 0.7 + (group === favored ? 0.4 : 0) - (cohesionist ? support * 0.4 : 0),
          "The cabinet withdrew an exclusionary policy to restore its mandate.");
      }
      if (group === favored || current === "protected" || current === "autonomous" || coercive || share < 0.06) return;
      if (dimension === "culture" && cohesionist) {
        consider(dimension, group, "assimilation",
          0.84 + support * 0.24 - share * 0.55 - reform * 0.65 - cooperation * 0.45 - (atWar ? 0.15 : 0),
          "The governing coalition promoted a shared administrative culture.");
      }
      if (dimension === "faith" && government.stateReligion && cohesionist && !democracy && support >= 0.62) {
        consider(dimension, group, "assimilation",
          0.64 + support * 0.25 - share * 0.75 - reform * 0.7 - cooperation * 0.35 - (atWar ? 0.15 : 0),
          "The court encouraged affiliation with the state religion while keeping other worship legal.");
      }
      if (dimension !== "culture" && cohesionist && !democracy) {
        consider(dimension, group, "restricted",
          character.aggression * 0.78 + support * 0.35 - share * 0.75 - reform * 0.85 - 0.12,
          "The court prioritized its governing coalition's institutional privileges.");
      }
    });
  }
  if (best) {
    recordDecision(world, nation, best);
    government.nextReviewAt = now + DECISION_COOLDOWN;
  }
}
