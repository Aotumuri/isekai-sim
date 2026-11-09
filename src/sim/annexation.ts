import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import { dominantGroup, groupAffinity, type RegionalPopulation } from "./regional-population";
import { getOwnerByMesoId } from "./world-cache";
import type { WorldState } from "./world-state";

export interface Annexation {
  owner: NationId;
  resistance: number;
}

export function culturalDistance(a?: RegionalPopulation, b?: RegionalPopulation): number {
  if (!a || !b) return 0;
  const difference = a.culture.reduce((sum, count, index) => sum + Math.abs(count / a.size - b.culture[index]! / b.size), 0) / 2;
  return difference * (1 - groupAffinity(dominantGroup(a.culture), dominantGroup(b.culture)) / 2);
}

export function estimateAnnexationResistance(world: WorldState, owner: NationId, id: MesoRegionId): number {
  const capital = world.nations.find((nation) => nation.id === owner)?.capitalMesoId;
  return 0.15 + 0.65 * culturalDistance(
    world.regionalPopulations?.get(id), capital ? world.regionalPopulations?.get(capital) : undefined);
}

export function recordAnnexation(world: WorldState, owner: NationId, ids: readonly MesoRegionId[]): void {
  if (!ids.length) return;
  const annexations = world.annexations ??= new Map();
  for (const id of ids) annexations.set(id, { owner, resistance: estimateAnnexationResistance(world, owner, id) });
}

export function updateAnnexations(world: WorldState): void {
  if (!world.annexations?.size || world.time.slowTick % 10 !== 0) return;
  const owners = getOwnerByMesoId(world);
  const garrisons = new Set(world.units.filter((unit) => unit.domain === "land" && !unit.moveToId &&
    owners.get(unit.regionId) === unit.nationId).map((unit) => unit.regionId));
  for (const [id, state] of world.annexations) {
    if (owners.get(id) !== state.owner) { world.annexations.delete(id); continue; }
    const controller = world.occupation.mesoById.get(id);
    if (controller && controller !== state.owner) continue;
    state.resistance -= garrisons.has(id) ? 0.025 : 0.008;
    if (state.resistance <= 0) world.annexations.delete(id);
  }
}

export function annexedOutputFactor(world: WorldState, owner: NationId, id: MesoRegionId): number {
  const state = world.annexations?.get(id);
  return state?.owner === owner ? 1 - state.resistance : 1;
}
