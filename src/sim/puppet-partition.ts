import { splitTreasury } from "./treasury";
import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import { culturalDistance } from "./annexation";
import { assignNationIdentities } from "./nation-identity";
import { createNationResourceFlow, type NationRuntime } from "./nation-runtime";
import { connectedRegionGroups } from "./peace-borders";
import { dominantGroup, POPULATION_GROUPS } from "./regional-population";
import { findWar } from "./war-state";
import { getMesoById, getNeighborsById, getOwnerByMesoId } from "./world-cache";
import type { WorldState } from "./world-state";

export interface PuppetPartition {
  capitalId: MesoRegionId;
  districtIds: MesoRegionId[];
}

function remainingLand(world: WorldState, target: NationId, annexed: readonly MesoRegionId[]): Set<MesoRegionId> {
  const excluded = new Set(annexed);
  const owners = getOwnerByMesoId(world);
  return new Set(world.mesoRegions.filter((region) => region.type !== "sea" &&
    owners.get(region.id) === target && !excluded.has(region.id)).map((region) => region.id));
}

export function getPartitionIssue(world: WorldState, sponsor: NationId, target: NationId,
  annexed: readonly MesoRegionId[], plan: PuppetPartition): string | null {
  const capital = world.nations.find((nation) => nation.id === target)?.capitalMesoId;
  const land = remainingLand(world, target, annexed), split = new Set(plan.districtIds);
  const retained = new Set([...land].filter((id) => !split.has(id)));
  if (!capital || !retained.has(capital) || !split.has(plan.capitalId) ||
    getMesoById(world).get(plan.capitalId)?.building !== "city" ||
    split.size !== plan.districtIds.length || split.size < 2 || retained.size < 2 ||
    [...split].some((id) => !land.has(id))) return "Partition requires two viable territories and a city for the new capital.";
  const occupied = [...land].filter((id) => world.occupation.mesoById.get(id) === sponsor).length;
  if (world.occupation.mesoById.get(capital) !== sponsor || occupied < Math.ceil(land.size * 0.6)) {
    return "Partition requires occupation of the capital and 60% of the remaining districts.";
  }
  if ([...land].some((id) => {
    const occupier = world.occupation.mesoById.get(id);
    return occupier && occupier !== sponsor && occupier !== target;
  })) return "A third party occupies part of the proposed puppet territories.";
  if (world.wars.some((war) => (war.nationAId === target || war.nationBId === target) &&
    war !== findWar(world.wars, sponsor, target))) return "Resolve the target’s other wars before partition.";
  const neighbors = getNeighborsById(world);
  if (connectedRegionGroups(split, neighbors).length !== 1 ||
    connectedRegionGroups(land, neighbors).some((component) =>
      connectedRegionGroups(new Set(component.filter((id) => retained.has(id))), neighbors).length > 1)) {
    return "Partition must form a connected new state and preserve the remaining borders.";
  }
  return null;
}

export function planPuppetPartition(world: WorldState, sponsor: NationId, target: NationId,
  annexed: readonly MesoRegionId[]): PuppetPartition | undefined {
  const land = remainingLand(world, target, annexed);
  const capital = world.nations.find((nation) => nation.id === target)?.capitalMesoId;
  if (!capital || land.size < 4) return;
  const populations = world.regionalPopulations, neighbors = getNeighborsById(world), regions = getMesoById(world);
  const distance = (a: MesoRegionId, b: MesoRegionId) => culturalDistance(populations?.get(a), populations?.get(b));
  const candidates = [...land].filter((id) => regions.get(id)?.building === "city")
    .sort((a, b) => distance(capital, b) - distance(capital, a) || a.localeCompare(b));
  let best: PuppetPartition | undefined;
  for (const seed of candidates) {
    const parcel = new Set([seed]);
    while (parcel.size < Math.floor(land.size / 2)) {
      const frontier = [...new Set([...parcel].flatMap((id) => neighbors.get(id) ?? []))]
        .filter((id) => land.has(id) && !parcel.has(id) && id !== capital)
        .sort((a, b) => distance(seed, a) - distance(seed, b) || a.localeCompare(b));
      const next = frontier.find((id) => !getPartitionIssue(world, sponsor, target, annexed,
        { capitalId: seed, districtIds: [...parcel, id] }));
      if (!next) break;
      parcel.add(next);
    }
    if (parcel.size >= 2 && (!best || parcel.size > best.districtIds.length)) best = { capitalId: seed, districtIds: [...parcel] };
    if (best?.districtIds.length === Math.floor(land.size / 2)) break;
  }
  return best;
}

export function preparePartitionNation(world: WorldState, parent: NationRuntime, plan: PuppetPartition): NationRuntime {
  let serial = 1;
  while (world.nations.some((nation) => nation.id === `${parent.id}-partition-${serial}`)) serial++;
  const population = world.regionalPopulations?.get(plan.capitalId);
  const culture = population ? POPULATION_GROUPS.culture[dominantGroup(population.culture)] : "Provincial";
  return {
    id: `${parent.id}-partition-${serial}` as NationId,
    name: `${parent.name ?? parent.id} · ${culture} Territory ${serial}`,
    ideologyId: parent.ideologyId, capitalMesoId: plan.capitalId, macroRegionIds: [],
    unitRoles: { defenseUnitIds: [], occupationUnitIds: [] },
    capitalFallCount: 0, surrenderScore: 0, initialUnitCount: 0, initialCityCount: 0,
    warCooperation: parent.warCooperation, warCooperationBoost: 0,
    resources: { steel: 0, fuel: 0, weapons: 0, manpower: 0 },
    resourceFlow: createNationResourceFlow(),
    nextUnitProductionTick: world.time.slowTick + 10, nextWarDeclarationTick: world.time.slowTick + 60,
  };
}

export function dividePartitionResources(world: WorldState, parent: NationRuntime, successor: NationRuntime,
  plan: PuppetPartition): void {
  const share = plan.districtIds.length / (plan.districtIds.length + remainingLand(world, parent.id, []).size);
  for (const key of Object.keys(successor.resources) as (keyof NationRuntime["resources"])[]) {
    successor.resources[key] = parent.resources[key] * share;
    parent.resources[key] -= successor.resources[key];
  }
  successor.treasury = splitTreasury(parent.treasury, share);
  assignNationIdentities(world);
}
