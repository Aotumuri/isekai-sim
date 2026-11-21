import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import { getEffectiveTreatment, IDENTITY_GROUP_IDS, identityGroupIndex, type GroupTreatment } from "./identity-policy";
import type { NationRuntime } from "./nation-runtime";
import { POPULATION_DIMENSIONS, type PopulationDimension, type RegionalPopulation } from "./regional-population";
import type { WorldState } from "./world-state";

export interface RegionalIdentityGrievance {
  owner: NationId;
  recent: number;
  entrenched: number;
  exclusion: number;
  dimension: PopulationDimension;
  group: number;
  hardship: number;
  autonomyLoss: number;
  shock: number;
  autonomyDemand: number;
}

export interface NationalIdentityStability {
  grievance: number;
  autonomyDemand: number;
  legitimacy: number;
  mostAffected?: MesoRegionId;
}

const COST: Record<GroupTreatment, number> = {
  protected: 0, tolerated: 0, autonomous: 0, assimilation: 0.62, restricted: 1,
};

export function prepareIdentityEffects(world: WorldState, nation: NationRuntime) {
  const autonomy = nation.governance?.policy === "autonomy";
  const lostAutonomy = nation.governance?.autonomyLostAt;
  const autonomyLoss = lostAutonomy === undefined ? 0 :
    0.28 * Math.max(0, 1 - (world.time.slowTick - lostAutonomy) / 80);
  const ordered = nation.displacementOrder;
  const hardship = Math.max(0, 1 - (world.settings?.foodEnabled === false ? 1 : nation.food?.rationCoverage ?? 1));
  const government = nation.identityGovernment!;
  return {
    owner: nation.id, autonomy, autonomyLoss, hardship,
    dimensions: POPULATION_DIMENSIONS.map((dimension) => ({
      dimension,
      favored: identityGroupIndex(dimension, government.favored[dimension]),
      groups: IDENTITY_GROUP_IDS[dimension].map((_, group) => {
        const treatment = getEffectiveTreatment(world, nation, dimension, group);
        const targeted = ordered?.dimension === dimension && ordered.group === group && ordered.until > world.time.slowTick;
        return { treatment, cost: targeted ? 1 : COST[treatment] };
      }),
    })),
  };
}

export function grievanceLevel(state?: RegionalIdentityGrievance): number {
  return state ? 0.65 * state.recent + 0.35 * state.entrenched : 0;
}

export function applyRegionalIdentityEffects(
  world: WorldState, id: MesoRegionId, population: RegionalPopulation,
  effects: ReturnType<typeof prepareIdentityEffects> | undefined,
): boolean {
  const memory = world.identityGrievances ??= new Map();
  const previous = memory.get(id);
  if (!effects) {
    // Occupation suspends civil policy. Existing memories survive changes of rule.
    if (previous) {
      previous.recent *= 0.9;
      previous.entrenched *= 0.98;
      if (grievanceLevel(previous) < 0.001) memory.delete(id);
    }
    return false;
  }
  let exposure = 0, relief = 0, largest = 0, changed = false;
  let causeDimension: PopulationDimension = previous?.dimension ?? "ancestry", causeGroup = previous?.group ?? 0;
  for (const { dimension, favored, groups } of effects.dimensions) {
    const distribution = population[dimension];
    let moved = 0;
    for (const [group, { treatment, cost }] of groups.entries()) {
      const share = distribution[group]! / population.size;
      const burden = share * cost;
      exposure += burden;
      if (burden > largest) {
        largest = burden;
        causeDimension = dimension;
        causeGroup = group;
      }
      if (treatment === "protected" || treatment === "autonomous") relief += share;
      if (dimension === "ancestry" || group === favored || treatment !== "assimilation" || effects.autonomy || cost > COST.assimilation) continue;
      // Track cultural adoption and individual religious affiliation at separate rates.
      const amount = distribution[group]! * (dimension === "culture" ? 0.018 : 0.005);
      distribution[group]! -= amount;
      moved += amount;
    }
    if (moved > 0) {
      distribution[favored]! += moved;
      changed = true;
    }
  }
  const exclusion = exposure / POPULATION_DIMENSIONS.length;
  const { owner, hardship, autonomyLoss } = effects;
  const shock = Math.max(0, exclusion - (previous?.owner === owner ? previous.exclusion : 0));
  const target = Math.min(1, exclusion * (2 + hardship * 0.5) + autonomyLoss + shock * 0.35) *
    (1 - relief * 0.08) * (effects.autonomy ? 0.7 : 1);
  const recent = (previous?.recent ?? 0) * 0.65 + target * 0.35;
  const entrenched = (previous?.entrenched ?? 0) * 0.96 + recent * 0.04;
  const autonomyDemand = effects.autonomy ? 0 : Math.min(1, recent * 0.65 + entrenched * 0.35 + autonomyLoss * 0.25);
  if (recent + entrenched >= 0.001) {
    memory.set(id, { owner, recent, entrenched, exclusion, dimension: causeDimension, group: causeGroup,
      hardship, autonomyLoss, shock, autonomyDemand });
  } else memory.delete(id);
  return changed;
}

export function getRegionalIdentityGrievance(world: WorldState, id: MesoRegionId, owner: NationId) {
  const state = world.identityGrievances?.get(id);
  return state?.owner === owner ? state : undefined;
}
