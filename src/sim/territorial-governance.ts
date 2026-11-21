import type { NationId } from "../worldgen/nation";
import { recordAnnexation } from "./annexation";
import { reviewIdentityPolicies, type OverlordIdentity } from "./identity-decisions";
import { applyRegionalIdentityEffects, getRegionalIdentityGrievance, grievanceLevel, prepareIdentityEffects } from "./identity-grievances";
import { identityGroupIndex } from "./identity-policy";
import { getNationCharacter } from "./nation-character";
import { isNationActive } from "./nation-active";
import type { NationRuntime } from "./nation-runtime";
import { dominantGroup, POPULATION_DIMENSIONS, POPULATION_GROUPS, type RegionalPopulation } from "./regional-population";
import { updatePopulationPolitics } from "./population-politics";
import { hasPoliticalTurbulence, recordSimulationEvent } from "./simulation-settings";
import { getSubjectIntegrationIssue } from "./state-succession";
import { getSubjectOverlord } from "./subject-governments";
import { transferTerritories } from "./territory-transfer";
import type { MesoRegionId } from "../worldgen/meso-region";
import { getOwnerByMesoId } from "./world-cache";
import type { WorldState } from "./world-state";

export type GovernancePolicy = NonNullable<NationRuntime["governance"]>["policy"];

function changePolicy(world: WorldState, nation: NationRuntime, policy: GovernancePolicy, manual: boolean, reason = ""): void {
  const state = nation.governance ??= newGovernance(world.time.slowTick);
  if (manual) state.manual = true;
  if (state.policy === policy) return;
  if (state.policy === "autonomy") state.autonomyLostAt = world.time.slowTick;
  if (policy === "autonomy") delete state.autonomyLostAt;
  state.policy = policy;
  state.since = world.time.slowTick;
  state.alignment = 0;
  recordSimulationEvent(world, { category: "politics", nationIds: [nation.id],
    message: `${nation.id} adopted ${policy === "autonomy" ? "regional autonomy" : policy === "assimilation" ? "common administration" : "centralized administration"}.${reason ? ` ${reason}` : ""}` });
}

export function setGovernancePolicy(world: WorldState, actor: NationId, target: NationId, policy: GovernancePolicy): boolean {
  const nation = world.nations.find(({ id }) => id === target);
  if (!hasPoliticalTurbulence(world) || !nation || !isNationActive(nation) ||
    (actor !== target && getSubjectOverlord(world, target) !== actor)) return false;
  changePolicy(world, nation, policy, true);
  return true;
}

export function getGovernanceUnrest(nation: NationRuntime): number {
  return (nation.identityStability?.grievance ?? 0) * 1.15;
}

export { getSubjectIntegrationIssue };

export function integrateSubjectGovernment(world: WorldState, overlord: NationId, subject: NationId): boolean {
  if (getSubjectIntegrationIssue(world, overlord, subject)) return false;
  const districts = world.macroRegions.filter(({ nationId }) => nationId === subject).flatMap(({ mesoRegionIds }) => mesoRegionIds);
  if (!transferTerritories(world, [{ from: subject, to: overlord, regionIds: districts }], "integration")) return false;
  recordAnnexation(world, overlord, districts);
  recordSimulationEvent(world, { category: "politics", nationIds: [overlord, subject],
    message: `${overlord} integrated ${subject} after a period of administrative alignment.` });
  return true;
}

function newGovernance(now: number): NonNullable<NationRuntime["governance"]> {
  return { policy: "centralized", stability: 100, diversity: 0, alignment: 1, since: now };
}

function createNationalAssessment(world: WorldState, nation: NationRuntime) {
  const population: RegionalPopulation = { size: 0, ancestry: POPULATION_GROUPS.ancestry.map(() => 0),
    culture: POPULATION_GROUPS.culture.map(() => 0), faith: POPULATION_GROUPS.faith.map(() => 0) };
  return { effects: prepareIdentityEffects(world, nation), population, grievance: 0, autonomyDemand: 0,
    peak: 0, mostAffected: undefined as MesoRegionId | undefined };
}

export function updateTerritorialGovernance(world: WorldState): void {
  const now = world.time.slowTick, populations = world.regionalPopulations;
  if (now % 10 !== 0 || !populations) return;
  const startedAt = world.instrumentation ? performance.now() : 0;
  updatePopulationPolitics(world);
  if (!hasPoliticalTurbulence(world)) return;
  const nations = new Map(world.nations.filter(isNationActive).map((nation) => [nation.id, nation]));
  const assessments = new Map<NationId, ReturnType<typeof createNationalAssessment>>();
  const atWar = new Set(world.wars.flatMap(({ nationAId, nationBId }) => [nationAId, nationBId]));
  for (const nation of world.nations) {
    if (nations.has(nation.id) && nation.identityGovernment) {
      nation.governance ??= newGovernance(now);
      assessments.set(nation.id, createNationalAssessment(world, nation));
    } else delete nation.identityStability;
  }
  const owners = getOwnerByMesoId(world);
  let changed = false;
  for (const [id, population] of populations) {
    const owner = owners.get(id), occupier = world.occupation.mesoById.get(id);
    const assessment = owner && (!occupier || occupier === owner) ? assessments.get(owner) : undefined;
    const populated = population.size > 1e-8;
    const effects = populated ? assessment?.effects : undefined;
    changed = applyRegionalIdentityEffects(world, id, population, effects) || changed;
    if (!assessment || !populated) continue;
    const total = assessment.population;
    total.size += population.size;
    for (const dimension of POPULATION_DIMENSIONS) {
      population[dimension].forEach((count, group) => { total[dimension][group]! += count; });
    }
    const local = getRegionalIdentityGrievance(world, id, assessment.effects.owner);
    const grievance = grievanceLevel(local);
    assessment.grievance += grievance * population.size;
    assessment.autonomyDemand += (local?.autonomyDemand ?? 0) * population.size;
    if (grievance > assessment.peak) {
      assessment.peak = grievance;
      assessment.mostAffected = id;
    }
  }
  if (changed) world.populationRevision = (world.populationRevision ?? 0) + 1;

  const integrations: [NationId, NationId][] = [];
  for (const [id, assessment] of assessments) {
    const nation = nations.get(id)!, state = nation.governance!, total = assessment.population;
    if (!total.size) { delete nation.identityStability; continue; }
    const grievance = assessment.grievance / total.size;
    const autonomyDemand = assessment.autonomyDemand / total.size;
    const legitimacy = 100 * (1 - grievance * 0.75);
    nation.identityStability = { grievance, autonomyDemand, legitimacy, mostAffected: assessment.mostAffected };
    state.stability += (legitimacy - state.stability) * 0.25;
    const capital = populations.get(nation.capitalMesoId) ?? total;
    state.diversity = POPULATION_DIMENSIONS.reduce((sum, dimension) =>
      sum + 1 - total[dimension][dominantGroup(capital[dimension])]! / total.size, 0) / POPULATION_DIMENSIONS.length;
    const overlord = nation.subjectGovernment?.overlordId;
    const sponsor = overlord ? nations.get(overlord) : undefined;
    const culture = sponsor?.identityGovernment?.favored.culture ?? nation.identityGovernment!.favored.culture;
    state.alignmentCulture = culture;
    state.alignment = total.culture[identityGroupIndex("culture", culture)]! / total.size;
    if (!state.manual && state.policy === "centralized" && now >= 120) {
      const cooperation = (nation.character ?? getNationCharacter(world, nation.id)).cooperation;
      if (autonomyDemand >= 0.14 && cooperation >= 0.55) {
        changePolicy(world, nation, "autonomy", false, "The cabinet responded to sustained demands for local self-government.");
      } else if (sponsor && culture === nation.identityGovernment!.favored.culture && grievance < 0.12 &&
          (nation.subjectGovernment?.autonomy ?? 0) < 45 &&
          (sponsor.character ?? getNationCharacter(world, sponsor.id)).aggression >= 0.6) {
        changePolicy(world, nation, "assimilation", false, "The subject and its overlord share a recognized administrative culture.");
      }
    }
    if (sponsor && state.policy === "assimilation" && !state.manual && state.alignment >= 0.82) {
      integrations.push([sponsor.id, nation.id]);
    }
  }
  // Review against the same set of prior commitments, regardless of iteration order.
  const commitments = new Map<NationId, OverlordIdentity>();
  for (const nation of nations.values()) {
    const overlord = nation.subjectGovernment?.overlordId;
    if (!overlord || commitments.has(overlord)) continue;
    const sponsor = nations.get(overlord);
    if (sponsor?.identityGovernment) commitments.set(overlord, {
      id: overlord, favored: { ...sponsor.identityGovernment.favored },
      ideology: sponsor.politics?.governingIdeologyId ?? sponsor.ideologyId,
    });
  }
  for (const [id, { population }] of assessments) {
    if (!population.size) continue;
    const nation = nations.get(id)!;
    const overlord = nation.subjectGovernment?.overlordId;
    reviewIdentityPolicies(world, nation, population, overlord ? commitments.get(overlord) : undefined, atWar.has(id));
  }
  // Transfers invalidate the owner index, so apply them after all assessments.
  for (const [overlord, subject] of integrations) integrateSubjectGovernment(world, overlord, subject);
  world.instrumentation?.recordDuration("politics.identityGovernance", performance.now() - startedAt);
}
