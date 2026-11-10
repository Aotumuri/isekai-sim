import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import { isNationActive } from "./nation-active";
import { getNationName } from "./nation-identity";
import { dominantGroup, groupAffinity, POPULATION_GROUPS } from "./regional-population";
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

export function updatePopulationPolitics(world: WorldState): void {
  const populations = world.regionalPopulations;
  if (!populations || world.time.slowTick % 10 !== 0) return;
  const totals = new Map<NationId, { size: number; faith: number[] }>();
  for (const [id, owner] of getOwnerByMesoId(world)) {
    const population = populations.get(id);
    if (!population) continue;
    const total = totals.get(owner) ?? { size: 0, faith: POPULATION_GROUPS.faith.map(() => 0) };
    total.size += population.size;
    population.faith.forEach((count, group) => { total.faith[group]! += count; });
    totals.set(owner, total);
  }
  for (const nation of world.nations) {
    const previous = nation.populationPolicy;
    const capital = populations.get(nation.capitalMesoId), total = totals.get(nation.id);
    let next: PopulationPolicy | undefined;
    if (isNationActive(nation) && capital && total) {
      const ancestry = dominantGroup(capital.ancestry), faith = dominantGroup(total.faith);
      const ideology = nation.politics?.governingIdeologyId ?? nation.ideologyId;
      if (ideology === "cohesionism" && capital.ancestry[ancestry]! / capital.size >= (previous?.type === "homeland" ? 0.33 : 0.40)) {
        next = { type: "homeland", group: ancestry };
      } else if (total.faith[faith]! / total.size >= (previous?.type === "religious" ? 0.44 : 0.52)) {
        next = { type: "religious", group: faith };
      }
    }
    if (previous?.type === next?.type && previous?.group === next?.group) continue;
    nation.populationPolicy = next;
    world.populationPolicyRevision = (world.populationPolicyRevision ?? 0) + 1;
    recordSimulationEvent(world, { category: "politics", nationIds: [nation.id],
      message: next ? `${getNationName(world, nation.id)} proclaimed its ${next.type === "homeland" ? "self-determination program" : "state faith"}.`
        : `${getNationName(world, nation.id)} withdrew its ${previous?.type === "homeland" ? "self-determination program" : "state faith"}.` });
  }
}

export function getHomelandClaimBonus(world: WorldState, nationId: NationId, regionId: MesoRegionId): number {
  const nation = world.nations.find((item) => item.id === nationId);
  const policy = nation?.populationPolicy;
  const population = world.regionalPopulations?.get(regionId);
  if (!nation || policy?.type !== "homeland" || !population) return 0;
  const share = population.ancestry[policy.group]! / population.size;
  if (share < 0.4) return 0;
  const capital = world.regionalPopulations?.get(nation.capitalMesoId);
  const affinity = capital ? groupAffinity(dominantGroup(capital.culture), dominantGroup(population.culture)) : 0;
  return 22 + 25 * share + 8 * affinity;
}
