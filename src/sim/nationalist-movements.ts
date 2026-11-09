import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import { getRelation, hasTreaty } from "./diplomacy";
import { areFactionPartners } from "./factions";
import { isNationActive } from "./nation-active";
import { getNationCharacter } from "./nation-character";
import { dominantGroup, POPULATION_GROUPS } from "./regional-population";
import { hasPoliticalTurbulence, recordSimulationEvent } from "./simulation-settings";
import { areSubjectPartners, getSubjectOverlord } from "./subject-governments";
import { buildWarAdjacency } from "./war-state";
import { getAdjacentNationPairs, getOwnerByMesoId } from "./world-cache";
import type { WorldState } from "./world-state";

export function getNationalistClaimBonus(world: WorldState, nation: NationId, district: MesoRegionId): number {
  if (!hasPoliticalTurbulence(world)) return 0;
  const movement = world.nations.find(({ id }) => id === nation)?.nationalistMovement;
  if (!movement || movement.until <= world.time.slowTick || getOwnerByMesoId(world).get(district) !== movement.targetId) return 0;
  const population = world.regionalPopulations?.get(district);
  const share = population?.size ? population.ancestry[movement.group]! / population.size : 0;
  return share >= 0.45 ? 30 + share * 35 : 0;
}

export function updateNationalistMovements(world: WorldState): void {
  const now = world.time.slowTick;
  const populations = world.regionalPopulations;
  if (!hasPoliticalTurbulence(world) || now < 120 || now % 30 !== 0 || !populations) return;
  const wars = buildWarAdjacency(world.wars);
  const neighbors = getAdjacentNationPairs(world);
  const supportByNation = new Map<NationId, number[]>();
  for (const [id, owner] of getOwnerByMesoId(world)) {
    const population = populations.get(id);
    if (!population?.size) continue;
    const support = supportByNation.get(owner) ?? POPULATION_GROUPS.ancestry.map(() => 0);
    population.ancestry.forEach((count, group) => {
      if (count / population.size >= 0.45) support[group]! += 1;
    });
    supportByNation.set(owner, support);
  }
  for (const nation of world.nations) {
    if (!isNationActive(nation) || getSubjectOverlord(world, nation.id) || (nation.nationalistMovement?.nextAt ?? 0) > now ||
      wars.get(nation.id)?.size) continue;
    const capital = populations.get(nation.capitalMesoId);
    const homeland = nation.populationPolicy?.type === "homeland" ? nation.populationPolicy.group : undefined;
    if (!capital || (homeland === undefined && getNationCharacter(world, nation.id).aggression < 0.7)) continue;
    const group = homeland ?? dominantGroup(capital.ancestry);
    const targets = neighbors.flatMap(([a, b]) => a === nation.id ? [b] : b === nation.id ? [a] : []);
    const target = targets.filter((id) => !areFactionPartners(world, nation.id, id) &&
      !areSubjectPartners(world, nation.id, id) && !hasTreaty(world, nation.id, id, "alliance"))
      .map((id) => ({ id, count: supportByNation.get(id)?.[group] ?? 0 }))
      .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))[0];
    if (!target || target.count < 3) continue;
    nation.nationalistMovement = { targetId: target.id, group, until: now + 240, nextAt: now + 540 };
    const relation = getRelation(world, nation.id, target.id);
    relation.tension = Math.min(100, relation.tension + 34);
    relation.grievance = Math.min(100, relation.grievance + 30);
    relation.opinion = Math.max(-100, relation.opinion - 18);
    recordSimulationEvent(world, { category: "politics", nationIds: [nation.id, target.id],
      message: `${nation.id}'s ${POPULATION_GROUPS.ancestry[group]} reunification movement laid claim to ${target.count} districts in ${target.id}.` });
  }
}
