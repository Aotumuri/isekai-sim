import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import { getRelation } from "./diplomacy";
import { getDomesticUnrest } from "./domestic-unrest";
import { getNationCharacter } from "./nation-character";
import { isNationActive } from "./nation-active";
import type { NationRuntime } from "./nation-runtime";
import { POPULATION_DIMENSIONS, POPULATION_GROUPS, type RegionalPopulation } from "./regional-population";
import { getWarDeclarationMode, recordSimulationEvent } from "./simulation-settings";
import { buildWarAdjacency, isAtWar } from "./war-state";
import { getMesoById, getOwnerByMesoId } from "./world-cache";
import type { WorldState } from "./world-state";

export type TargetDimension = "ancestry" | "faith";

export interface DisplacementOrder {
  dimension: TargetDimension;
  group: number;
  until: number;
  displaced: number;
}

export function displacementDimension(nation: NationRuntime): TargetDimension | undefined {
  return nation.populationPolicy?.type === "homeland" ? "ancestry" :
    nation.populationPolicy?.type === "religious" ? "faith" : undefined;
}

export function startDisplacementOrder(world: WorldState, nation: NationRuntime, group: number): boolean {
  const dimension = displacementDimension(nation), now = world.time.slowTick;
  if (!dimension || getWarDeclarationMode(world) !== "diplomacy" || !isNationActive(nation) ||
    (nation.nextDisplacementOrderAt ?? 0) > now || nation.displacementOrder ||
    !Number.isInteger(group) || !POPULATION_GROUPS[dimension][group] || group === nation.populationPolicy?.group) return false;
  nation.displacementOrder = { dimension, group, until: now + 60, displaced: 0 };
  nation.nextDisplacementOrderAt = now + 300;
  recordSimulationEvent(world, { category: "politics", nationIds: [nation.id],
    message: `${nation.id} ordered the forced expulsion of ${POPULATION_GROUPS[dimension][group]} residents.` });
  return true;
}

export function endDisplacementOrder(world: WorldState, nation: NationRuntime): boolean {
  const order = nation.displacementOrder;
  if (!order) return false;
  delete nation.displacementOrder;
  recordSimulationEvent(world, { category: "politics", nationIds: [nation.id],
    message: `${nation.id}'s expulsion order ended after displacing ${order.displaced.toFixed(2)} population units.` });
  return true;
}

function displaceGroup(source: RegionalPopulation, target: RegionalPopulation, order: DisplacementOrder): number {
  const amount = Math.min(source[order.dimension][order.group]! * 0.12, source.size * 0.06, target.size * 0.1);
  if (!(amount > 0)) return 0;
  const share = amount / source.size;
  for (const dimension of POPULATION_DIMENSIONS) {
    source[dimension].forEach((count, index) => {
      const moved = dimension === order.dimension ? (index === order.group ? amount : 0) : count * share;
      source[dimension][index]! -= moved;
      target[dimension][index]! += moved;
    });
  }
  source.size -= amount;
  target.size += amount;
  return amount;
}

function considerExpulsion(world: WorldState, nation: NationRuntime): void {
  const now = world.time.slowTick;
  const dimension = displacementDimension(nation);
  if (!dimension || nation.displacementOrder || (nation.nextDisplacementOrderAt ?? 0) > now ||
    nation.politics?.system !== "monarchy" ||
    (world.domesticUnrest?.byNationId.get(nation.id)?.pressure ?? 0) < 85 ||
    getNationCharacter(world, nation.id).aggression < 0.65) return;
  const groups = world.regionalPopulations?.get(nation.capitalMesoId)?.[dimension];
  if (!groups) return;
  const target = groups.reduce((best, count, group) =>
    group !== nation.populationPolicy?.group && count > (groups[best] ?? 0) ? group : best, -1);
  if (target >= 0) startDisplacementOrder(world, nation, target);
}

export function updateForcedDisplacement(world: WorldState): void {
  if (world.time.slowTick % 10 !== 0 || !world.regionalPopulations) return;
  if (getWarDeclarationMode(world) === "diplomacy") {
    for (const nation of world.nations) considerExpulsion(world, nation);
  }
  if (!world.nations.some((nation) => nation.displacementOrder)) return;
  const owners = getOwnerByMesoId(world), regions = getMesoById(world), populations = world.regionalPopulations;
  const wars = buildWarAdjacency(world.wars);
  const nations = new Map(world.nations.map((nation) => [nation.id, nation]));
  const fallout = new Map<NationId, Map<NationId, number>>();
  for (const nation of world.nations) {
    const order = nation.displacementOrder;
    if (order && (world.time.slowTick > order.until || !isNationActive(nation) ||
      displacementDimension(nation) !== order.dimension || nation.populationPolicy?.group === order.group ||
      getWarDeclarationMode(world) !== "diplomacy")) endDisplacementOrder(world, nation);
  }
  const isControlled = (id: MesoRegionId, owner: NationId) => {
    const occupier = world.occupation.mesoById.get(id);
    return !occupier || occupier === owner;
  };
  for (const [id, owner] of owners) {
    const order = nations.get(owner)?.displacementOrder, source = populations.get(id);
    if (!order || !source || !isControlled(id, owner)) continue;
    for (const { id: next } of regions.get(id)?.neighbors ?? []) {
      const recipient = owners.get(next), target = populations.get(next);
      if (!recipient || recipient === owner || !target || nations.get(recipient)?.displacementOrder ||
        !isControlled(next, recipient) || isAtWar(owner, recipient, wars)) continue;
      const amount = displaceGroup(source, target, order);
      if (!(amount > 0)) continue;
      order.displaced += amount;
      const receivers = fallout.get(owner) ?? new Map<NationId, number>();
      receivers.set(recipient, (receivers.get(recipient) ?? 0) + amount);
      fallout.set(owner, receivers);
      break;
    }
  }
  for (const [owner, receivers] of fallout) {
    const unrest = getDomesticUnrest(world, owner);
    unrest.pressure = Math.min(100, unrest.pressure + 5);
    for (const recipient of receivers.keys()) {
      const relation = getRelation(world, owner, recipient);
      relation.opinion = Math.max(-100, relation.opinion - 4);
      relation.trust = Math.max(0, relation.trust - 2);
      relation.tension = Math.min(100, relation.tension + 3);
    }
  }
  if (fallout.size) world.populationRevision = (world.populationRevision ?? 0) + 1;
}
