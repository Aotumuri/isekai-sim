import type { NationId } from "../worldgen/nation";
import { getRelation, relationKey } from "./diplomacy";
import { isNationActive } from "./nation-active";
import { getNationalPolitics } from "./politics";
import { POPULATION_DIMENSIONS, POPULATION_GROUPS, type PopulationDimension, type RegionalPopulation } from "./regional-population";
import { hasPoliticalTurbulence, recordSimulationEvent } from "./simulation-settings";
import { getOwnerByMesoId } from "./world-cache";
import type { WorldState } from "./world-state";

export function createPersecutionImpact(): RegionalPopulation {
  return { size: 0, ancestry: POPULATION_GROUPS.ancestry.map(() => 0),
    culture: POPULATION_GROUPS.culture.map(() => 0), faith: POPULATION_GROUPS.faith.map(() => 0) };
}

export function addPersecutionImpact(impact: RegionalPopulation, source: RegionalPopulation,
  dimension: PopulationDimension, group: number, amount: number): void {
  impact.size += amount;
  for (const category of POPULATION_DIMENSIONS) {
    // The simulation tracks separate distributions, so ties through other identities use local proportions.
    for (const [index, count] of source[category].entries()) {
      impact[category][index]! += category === dimension ? (group === index ? amount : 0) : amount * count / source.size;
    }
  }
}

export function getPublicOutrage(world: WorldState, observer: NationId, offender: NationId): number {
  if (!hasPoliticalTurbulence(world)) return 0;
  const reaction = world.diplomacy?.relations.get(relationKey(observer, offender))?.publicOutrage?.get(observer);
  return reaction ? Math.max(0, reaction.level - (world.time.slowTick - reaction.at) * 0.08) : 0;
}

export function hasPublicSanctions(world: WorldState, observer: NationId, offender: NationId): boolean {
  return getPublicOutrage(world, observer, offender) >= 65 &&
    world.nations.find(({ id }) => id === observer)?.politics?.system === "democracy";
}

export function publishPersecutionImpact(world: WorldState, offender: NationId, impact: RegionalPopulation,
  action: "forced expulsion" | "religious persecution" | "mass killing"): void {
  if (!hasPoliticalTurbulence(world) || impact.size <= 0 || !world.regionalPopulations) return;
  const totals = new Map<NationId, RegionalPopulation>();
  for (const [id, owner] of getOwnerByMesoId(world)) {
    if (owner === offender) continue;
    const population = world.regionalPopulations.get(id);
    if (!population) continue;
    const total = totals.get(owner) ?? createPersecutionImpact();
    total.size += population.size;
    for (const dimension of POPULATION_DIMENSIONS) population[dimension].forEach((count, index) => { total[dimension][index]! += count; });
    totals.set(owner, total);
  }
  const severity = action === "mass killing" ? 1.65 : action === "religious persecution" ? 0.8 : 1;
  for (const nation of world.nations) {
    const local = totals.get(nation.id);
    if (!isNationActive(nation) || !local?.size) continue;
    const affinity = Math.max(...POPULATION_DIMENSIONS.map((dimension) =>
      local[dimension].reduce((sum, count, index) => sum + count / local.size * impact[dimension][index]! / impact.size, 0)));
    if (affinity < 0.26) continue;
    const democratic = getNationalPolitics(world, nation).system === "democracy";
    const previous = getPublicOutrage(world, nation.id, offender);
    const delta = Math.min(25, 8 + impact.size * 4) * affinity * severity * (democratic ? 1.5 : 0.75);
    const level = Math.min(100, previous + delta);
    const relation = getRelation(world, nation.id, offender);
    (relation.publicOutrage ??= new Map()).set(nation.id, { level, at: world.time.slowTick });
    const change = level - previous;
    relation.opinion = Math.max(-100, relation.opinion - change * 0.65);
    relation.tension = Math.min(100, relation.tension + change * 0.65);
    relation.grievance = Math.min(100, relation.grievance + change * 0.45);
    if (previous < 35 && level >= 35) recordSimulationEvent(world, {
      category: "diplomacy", nationIds: [nation.id, offender],
      message: `Public outrage rose in ${nation.id} over ${offender}'s ${action} against communities with shared ties.`,
    });
    if (democratic && previous < 65 && level >= 65) {
      relation.treaties = relation.treaties.filter(({ type }) => type !== "alliance" && type !== "trade");
      recordSimulationEvent(world, { category: "diplomacy", nationIds: [nation.id, offender],
        message: `Under public pressure, ${nation.id} suspended alliance and trade cooperation with ${offender}.` });
    }
  }
}
