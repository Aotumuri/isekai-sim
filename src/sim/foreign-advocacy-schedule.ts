import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import type { RegionalNegotiation } from "./regional-negotiations";
import { getWarDeclarationMode, hasPoliticalTurbulence } from "./simulation-settings";
import type { WorldState } from "./world-state";

export type ForeignAdvocacySchedule = "periodic" | "event" | "100-day";

export const FIRST_FOREIGN_ADVOCACY_TICK = 240;
const productionSchedule: ForeignAdvocacySchedule = "event";
const overrides = new WeakMap<WorldState, ForeignAdvocacySchedule>();
const generations = new WeakMap<RegionalNegotiation, symbol>();
const pending = new WeakMap<WorldState, Map<MesoRegionId, { owner: NationId; generation: symbol; openedAt: number }>>();

export function getForeignAdvocacySchedule(world: WorldState): ForeignAdvocacySchedule {
  return overrides.get(world) ?? productionSchedule;
}

/** Experimental override, set before the world begins advancing. */
export function setForeignAdvocacySchedule(world: WorldState, schedule: ForeignAdvocacySchedule): void {
  overrides.set(world, schedule);
}

export function queueRegionalDemand(world: WorldState, id: MesoRegionId, talks: RegionalNegotiation): void {
  if (getForeignAdvocacySchedule(world) !== "event" || !hasPoliticalTurbulence(world) ||
    getWarDeclarationMode(world) !== "diplomacy" || world.time.slowTick < FIRST_FOREIGN_ADVOCACY_TICK) return;
  const generation = Symbol();
  generations.set(talks, generation);
  let batch = pending.get(world);
  if (!batch) pending.set(world, batch = new Map());
  // Only one generation per district can be actionable, so no live demand is evicted.
  batch.set(id, { owner: talks.owner, generation, openedAt: world.time.slowTick });
}

export function takePendingRegionalDemands(world: WorldState): MesoRegionId[] | undefined {
  const batch = pending.get(world);
  if (!batch || world.time.slowTick < FIRST_FOREIGN_ADVOCACY_TICK) return;
  const live: MesoRegionId[] = [];
  for (const [id, { owner, generation, openedAt }] of batch) {
    if (openedAt >= world.time.slowTick) continue;
    batch.delete(id);
    const talks = world.regionalNegotiations?.get(id);
    if (talks?.owner === owner && generations.get(talks) === generation) live.push(id);
  }
  if (!batch.size) pending.delete(world);
  return live;
}
