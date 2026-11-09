import type { MesoRegionId } from "../worldgen/meso-region";
import { hasTreaty } from "./diplomacy";
import { dominantGroup, getRegionalPopulations, groupAffinity, POPULATION_DIMENSIONS, type RegionalPopulation } from "./regional-population";
import { buildWarAdjacency, isAtWar } from "./war-state";
import { getMesoById, getOwnerByMesoId } from "./world-cache";
import type { WorldState } from "./world-state";

function movePopulation(source: RegionalPopulation, from: RegionalPopulation, to: RegionalPopulation, amount: number): void {
  from.size -= amount;
  to.size += amount;
  for (const dimension of POPULATION_DIMENSIONS) {
    source[dimension].forEach((count, index) => {
      const moved = count / source.size * amount;
      from[dimension][index]! -= moved;
      to[dimension][index]! += moved;
    });
  }
}

export function updatePopulationMigration(world: WorldState): void {
  if (world.time.slowTick % 10 !== 0 || !world.regionalPopulations) return;
  const populations = getRegionalPopulations(world);
  const next = new Map([...populations].map(([id, p]) => [id, {
    size: p.size, ancestry: [...p.ancestry], culture: [...p.culture], faith: [...p.faith],
  }]));
  const owners = getOwnerByMesoId(world), regions = getMesoById(world);
  const wars = buildWarAdjacency(world.wars);
  const occupied = (id: MesoRegionId) => {
    const controller = world.occupation.mesoById.get(id);
    return controller !== undefined && controller !== owners.get(id);
  };
  for (const [id, source] of populations) {
    const region = regions.get(id);
    if (!region) continue;
    for (const { id: targetId } of region.neighbors) {
      const target = populations.get(targetId);
      if (!target || occupied(targetId)) continue;
      const owner = owners.get(id), otherOwner = owners.get(targetId);
      const crossBorder = owner !== undefined && otherOwner !== undefined && owner !== otherOwner;
      if (crossBorder && isAtWar(owner, otherOwner, wars)) continue;
      const trade = crossBorder && (hasTreaty(world, owner, otherOwner, "trade") || hasTreaty(world, owner, otherOwner, "alliance"));
      const affinity = groupAffinity(dominantGroup(source.culture), dominantGroup(target.culture));
      const urban = regions.get(targetId)?.building != null;
      const rate = occupied(id) ? 0.08 : (trade ? 0.04 : crossBorder ? 0.012 : 0.02)
        * (urban ? 1.5 : 1) * (0.75 + affinity * 0.25);
      movePopulation(source, next.get(id)!, next.get(targetId)!, source.size * rate / region.neighbors.length);
    }
  }
  world.regionalPopulations = next;
  world.populationRevision = (world.populationRevision ?? 0) + 1;
}

export function exchangePortPopulation(world: WorldState, fromId: MesoRegionId, toId: MesoRegionId): void {
  const populations = world.regionalPopulations;
  const from = populations?.get(fromId), to = populations?.get(toId);
  if (!from || !to || from === to) return;
  const amount = Math.min(from.size, to.size) * 0.015;
  const originalTo = { size: to.size, ancestry: [...to.ancestry], culture: [...to.culture], faith: [...to.faith] };
  movePopulation({ ...from }, from, to, amount);
  movePopulation(originalTo, to, from, amount);
  world.populationRevision = (world.populationRevision ?? 0) + 1;
}
