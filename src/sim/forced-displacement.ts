import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import { getRelation } from "./diplomacy";
import { getDomesticUnrest } from "./domestic-unrest";
import { getNationCharacter } from "./nation-character";
import { isNationActive } from "./nation-active";
import type { NationRuntime } from "./nation-runtime";
import { addPersecutionImpact, createPersecutionImpact, publishPersecutionImpact } from "./persecution-reaction";
import { dominantGroup, POPULATION_DIMENSIONS, POPULATION_GROUPS, type PopulationDimension, type RegionalPopulation } from "./regional-population";
import { getWarDeclarationMode, hasPoliticalTurbulence, recordSimulationEvent } from "./simulation-settings";
import { buildWarAdjacency, isAtWar } from "./war-state";
import { getMesoById, getOwnerByMesoId } from "./world-cache";
import type { WorldState } from "./world-state";

export type TargetDimension = PopulationDimension;
export type PersecutionOrderMode = "expulsion" | "killing";

export interface DisplacementOrder {
  dimension: TargetDimension;
  group: number;
  until: number;
  displaced: number;
  mode?: PersecutionOrderMode;
  killed?: number;
  lastAppliedAt?: number;
}

export function displacementDimension(nation: NationRuntime): TargetDimension | undefined {
  return nation.populationPolicy?.type === "homeland" ? "ancestry" :
    nation.populationPolicy?.type === "religious" ? "faith" : undefined;
}

export function getPersecutionTargets(world: WorldState, nation: NationRuntime): { dimension: TargetDimension; group: number; name: string }[] {
  const dimension = displacementDimension(nation);
  if (!dimension) return [];
  const capital = world.regionalPopulations?.get(nation.capitalMesoId);
  const dimensions: TargetDimension[] = dimension === "ancestry" && capital && hasPoliticalTurbulence(world) ? [dimension, "culture"] : [dimension];
  return dimensions.flatMap((category) => {
    const protectedGroup = category === "culture" ? dominantGroup(capital!.culture) : nation.populationPolicy?.group;
    return POPULATION_GROUPS[category].flatMap((name, group) => group === protectedGroup ? [] : [{ dimension: category, group, name }]);
  });
}

export function startDisplacementOrder(world: WorldState, nation: NationRuntime, group: number,
  mode: PersecutionOrderMode = "expulsion", dimension = displacementDimension(nation)): boolean {
  const now = world.time.slowTick;
  if (!dimension || getWarDeclarationMode(world) !== "diplomacy" || !isNationActive(nation) ||
    (nation.nextDisplacementOrderAt ?? 0) > now || nation.displacementOrder ||
    (mode === "killing" && !hasPoliticalTurbulence(world)) ||
    !getPersecutionTargets(world, nation).some((target) => target.dimension === dimension && target.group === group)) return false;
  nation.displacementOrder = { dimension, group, until: now + 60, displaced: 0, mode };
  nation.nextDisplacementOrderAt = now + 300;
  recordSimulationEvent(world, { category: "politics", nationIds: [nation.id],
    message: `${nation.id} ordered ${mode === "killing" ? "mass killings targeting" : "the forced expulsion of"} ${POPULATION_GROUPS[dimension][group]} residents.` });
  return true;
}

export function endDisplacementOrder(world: WorldState, nation: NationRuntime): boolean {
  const order = nation.displacementOrder;
  if (!order) return false;
  delete nation.displacementOrder;
  recordSimulationEvent(world, { category: "politics", nationIds: [nation.id],
    message: order.mode === "killing"
      ? `${nation.id}'s mass killing order ended. ${(order.killed ?? 0).toFixed(2)} population units were killed.`
      : `${nation.id}'s expulsion order ended after displacing ${order.displaced.toFixed(2)} population units.` });
  return true;
}

function applyPersecution(source: RegionalPopulation, target: RegionalPopulation | undefined, order: DisplacementOrder,
  impact?: RegionalPopulation): number {
  const amount = target
    ? Math.min(source[order.dimension][order.group]! * 0.12, source.size * 0.06, target.size * 0.1)
    : Math.min(source[order.dimension][order.group]! * 0.10, source.size * 0.05);
  if (!(amount > 0)) return 0;
  if (impact) addPersecutionImpact(impact, source, order.dimension, order.group, amount);
  const share = amount / source.size;
  for (const dimension of POPULATION_DIMENSIONS) {
    source[dimension].forEach((count, index) => {
      const moved = dimension === order.dimension ? (index === order.group ? amount : 0) : count * share;
      source[dimension][index]! -= moved;
      if (target) target[dimension][index]! += moved;
    });
  }
  source.size -= amount;
  if (target) target.size += amount;
  return amount;
}

function considerExpulsion(world: WorldState, nation: NationRuntime): void {
  const now = world.time.slowTick;
  const dimension = displacementDimension(nation);
  const pressure = world.domesticUnrest?.byNationId.get(nation.id)?.pressure ?? 0;
  if (!dimension || nation.displacementOrder || (nation.nextDisplacementOrderAt ?? 0) > now ||
    nation.politics?.system !== "monarchy" ||
    pressure < 85 || (getNationCharacter(world, nation.id).aggression < 0.65 &&
    !(dimension === "ancestry" && pressure >= 95))) return;
  const groups = world.regionalPopulations?.get(nation.capitalMesoId)?.[dimension];
  if (!groups) return;
  const target = groups.reduce((best, count, group) =>
    group !== nation.populationPolicy?.group && count > (groups[best] ?? 0) ? group : best, -1);
  if (target < 0) return;
  const extreme = hasPoliticalTurbulence(world) && pressure >= 95 && getNationCharacter(world, nation.id).aggression >= 0.85 &&
    world.wars.some(({ nationAId, nationBId }) => nationAId === nation.id || nationBId === nation.id);
  startDisplacementOrder(world, nation, target, extreme ? "killing" : "expulsion");
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
  const impacts = new Map<NationId, RegionalPopulation>();
  const activeOrders = new Map<NationId, DisplacementOrder>();
  for (const nation of world.nations) {
    const order = nation.displacementOrder;
    if (!order) continue;
    if (world.time.slowTick >= order.until || !isNationActive(nation) || getWarDeclarationMode(world) !== "diplomacy" ||
      (order.mode === "killing" && !hasPoliticalTurbulence(world)) ||
      !getPersecutionTargets(world, nation).some((target) => target.dimension === order.dimension && target.group === order.group)) {
      endDisplacementOrder(world, nation);
      continue;
    }
    if (order.lastAppliedAt === world.time.slowTick) continue;
    order.lastAppliedAt = world.time.slowTick;
    activeOrders.set(nation.id, order);
    if (hasPoliticalTurbulence(world)) impacts.set(nation.id, createPersecutionImpact());
  }
  const isControlled = (id: MesoRegionId, owner: NationId) => {
    const occupier = world.occupation.mesoById.get(id);
    return !occupier || occupier === owner;
  };
  for (const [id, owner] of owners) {
    const order = activeOrders.get(owner), source = populations.get(id);
    if (!order || !source || !isControlled(id, owner)) continue;
    if (order.mode === "killing") {
      order.killed = (order.killed ?? 0) + applyPersecution(source, undefined, order, impacts.get(owner));
      continue;
    }
    for (const { id: next } of regions.get(id)?.neighbors ?? []) {
      const recipient = owners.get(next), target = populations.get(next);
      if (!recipient || recipient === owner || !target || nations.get(recipient)?.displacementOrder ||
        !isControlled(next, recipient) || isAtWar(owner, recipient, wars)) continue;
      const amount = applyPersecution(source, target, order, impacts.get(owner));
      if (!(amount > 0)) continue;
      order.displaced += amount;
      const receivers = fallout.get(owner) ?? new Map<NationId, number>();
      receivers.set(recipient, (receivers.get(recipient) ?? 0) + amount);
      fallout.set(owner, receivers);
      break;
    }
  }
  let deaths = false;
  for (const [owner, impact] of impacts) {
    const killing = activeOrders.get(owner)?.mode === "killing";
    if (killing && impact.size > 0) {
      deaths = true;
      const unrest = getDomesticUnrest(world, owner);
      unrest.pressure = Math.min(100, unrest.pressure + 12);
    }
    publishPersecutionImpact(world, owner, impact, killing ? "mass killing" : "forced expulsion");
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
  if (fallout.size || deaths) world.populationRevision = (world.populationRevision ?? 0) + 1;
}
