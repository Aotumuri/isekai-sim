import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import { getHomelandGroup, IDENTITY_GROUP_IDS, type IdentityGovernment } from "./identity-policy";
import type { NationRuntime } from "./nation-runtime";
import { isNationActive } from "./nation-active";
import { identityHash } from "./nation-identity";
import { dominantGroup, groupAffinity, POPULATION_GROUPS, type RegionalPopulation } from "./regional-population";
import { recordSimulationEvent } from "./simulation-settings";
import { getOwnerByMesoId } from "./world-cache";
import type { WorldState } from "./world-state";

export interface PopulationPolicy {
  type: "homeland" | "religious";
  group: number;
}

export function populationPolicyTitle(policy: PopulationPolicy): string {
  return policy.type === "homeland" ? `${POPULATION_GROUPS.ancestry[policy.group]} Homeland`
    : `${POPULATION_GROUPS.faith[policy.group]} Holy State`;
}

export function initializeGovernmentIdentity(
  world: WorldState, nation: NationRuntime, capital: RegionalPopulation,
  total: Pick<RegionalPopulation, "size" | "faith">,
): IdentityGovernment {
  if (nation.identityGovernment) return nation.identityGovernment;
  const ancestry = dominantGroup(capital.ancestry), faith = dominantGroup(total.faith);
  const ideology = nation.politics?.governingIdeologyId ?? nation.ideologyId;
  const existing = nation.populationPolicy;
  const stateReligion = existing?.type === "religious" || total.faith[faith]! / total.size >= 0.52;
  // Keep compatibility with existing homeland claims and the old official state-faith title.
  if (!existing) {
    if (ideology === "cohesionism" && capital.ancestry[ancestry]! / capital.size >= 0.4) {
      nation.populationPolicy = { type: "homeland", group: ancestry };
    } else if (stateReligion) {
      nation.populationPolicy = { type: "religious", group: faith };
    }
  }
  if (nation.populationPolicy && !existing) {
    world.populationPolicyRevision = (world.populationPolicyRevision ?? 0) + 1;
    recordSimulationEvent(world, { category: "politics", nationIds: [nation.id],
      message: `${nation.id} proclaimed its ${nation.populationPolicy.type === "homeland" ? "self-determination program" : "state faith"}.` });
  }
  return nation.identityGovernment = {
    favored: {
      ancestry: IDENTITY_GROUP_IDS.ancestry[existing?.type === "homeland" ? existing.group : ancestry] ?? IDENTITY_GROUP_IDS.ancestry[ancestry]!,
      culture: IDENTITY_GROUP_IDS.culture[dominantGroup(capital.culture)]!,
      faith: IDENTITY_GROUP_IDS.faith[existing?.type === "religious" ? existing.group : faith] ?? IDENTITY_GROUP_IDS.faith[faith]!,
    },
    stateReligion,
    treatments: { ancestry: {}, culture: {}, faith: {} },
    nextReviewAt: world.time.slowTick + 30 + identityHash(nation.id) % 6 * 10,
    decisions: [], decisionCount: 0,
  };
}

export function updatePopulationPolitics(world: WorldState): void {
  const populations = world.regionalPopulations;
  if (!populations || world.time.slowTick % 10 !== 0) return;
  const initializing = new Set(world.nations.filter((nation) => !nation.identityGovernment && isNationActive(nation)).map(({ id }) => id));
  if (!initializing.size) return;
  const totals = new Map<NationId, Pick<RegionalPopulation, "size" | "faith">>();
  for (const [id, owner] of getOwnerByMesoId(world)) {
    if (!initializing.has(owner)) continue;
    const population = populations.get(id);
    if (!population?.size) continue;
    const total = totals.get(owner) ?? { size: 0, faith: POPULATION_GROUPS.faith.map(() => 0) };
    total.size += population.size;
    population.faith.forEach((count, group) => { total.faith[group]! += count; });
    totals.set(owner, total);
  }
  for (const nation of world.nations) {
    if (!initializing.has(nation.id)) continue;
    const capital = populations.get(nation.capitalMesoId), total = totals.get(nation.id);
    if (capital?.size && total?.size) initializeGovernmentIdentity(world, nation, capital, total);
  }
}

export function getHomelandClaimBonus(world: WorldState, nationId: NationId, regionId: MesoRegionId): number {
  const nation = world.nations.find((item) => item.id === nationId);
  const group = nation && getHomelandGroup(nation);
  const population = world.regionalPopulations?.get(regionId);
  if (!nation || group === undefined || !population?.size) return 0;
  const share = population.ancestry[group]! / population.size;
  if (share < 0.4) return 0;
  const capital = world.regionalPopulations?.get(nation.capitalMesoId);
  const affinity = capital ? groupAffinity(dominantGroup(capital.culture), dominantGroup(population.culture)) : 0;
  return 22 + 25 * share + 8 * affinity;
}
