import { isFamineRevolution } from "./food-supply";
import { taxUnrestPerTick } from "./treasury";
import { WORLD_BALANCE } from "../data/balance";
import type { NationId } from "../worldgen/nation";
import type { WorldState } from "./world-state";
import { isNationActive } from "./nation-active";
import { getNationName } from "./nation-identity";
import { hasPoliticalTurbulence, recordSimulationEvent } from "./simulation-settings";
export interface NationalUnrest {
  pressure: number; lowSupportSeconds: number; lastSlowTick: number; cooldownUntilSlowTick: number;
  phase: "stable" | "discontent" | "crisis" | "revolution" | "recovering"; revolutions: number;
}
export interface DomesticUnrestState { byNationId: Map<NationId, NationalUnrest> }
export function getDomesticUnrest(world: WorldState, id: NationId): NationalUnrest {
  const state = world.domesticUnrest ??= { byNationId: new Map() };
  let item = state.byNationId.get(id);
  if (!item) { item = { pressure: 0, lowSupportSeconds: 0, lastSlowTick: world.time.slowTick, cooldownUntilSlowTick: 0, phase: "stable", revolutions: 0 }; state.byNationId.set(id, item); }
  return item;
}
export function getRevolutionRisk(world: WorldState, id: NationId): number {
  const item = world.domesticUnrest?.byNationId.get(id);
  if (!item || world.time.slowTick < item.cooldownUntilSlowTick) return 0;
  return Math.min(1, Math.max(item.pressure / 100, item.lowSupportSeconds / WORLD_BALANCE.war.civilWar.minimumCrisisSeconds * 0.8));
}
export function updateDomesticUnrest(world: WorldState): void {
  const balance = WORLD_BALANCE.war.civilWar;
  for (const nation of world.nations) {
    const item = getDomesticUnrest(world, nation.id), previousTick = item.lastSlowTick, elapsed = Math.max(0, world.time.slowTick - previousTick);
    item.lastSlowTick = world.time.slowTick;
    if (!balance.enabled || !elapsed) continue;
    const atWar = world.wars.some((war) => war.nationAId === nation.id || war.nationBId === nation.id);
    const vulnerable = isNationActive(nation) && atWar && nation.warCooperation < balance.warningSupport;
    const before = item.phase, pressureBefore = item.pressure;
    if (vulnerable && world.time.slowTick >= item.cooldownUntilSlowTick) {
      const severity = Math.max(0, Math.min(1, 1 - nation.warCooperation / balance.warningSupport));
      item.pressure = item.pressure + Math.max(0, world.time.slowTick - Math.max(previousTick, item.cooldownUntilSlowTick)) * (0.25 + severity * 0.25);
      item.lowSupportSeconds += Math.max(0, world.time.slowTick - Math.max(previousTick, item.cooldownUntilSlowTick));
    } else {
      item.pressure -= elapsed * (atWar ? 0.3 : 0.8);
      item.lowSupportSeconds = Math.max(0, item.lowSupportSeconds - elapsed * (atWar ? 1 : 2));
    }
    const active = isNationActive(nation);
    if (active) {
      item.pressure += elapsed * taxUnrestPerTick(nation.treasury);
      if (hasPoliticalTurbulence(world) && (nation.politics?.suppression?.until ?? 0) > world.time.slowTick) {
        item.pressure += elapsed * 1.05;
      }
      if (world.settings?.foodEnabled !== false && nation.food) item.pressure += elapsed * (1 - nation.food.rationCoverage) * 3;
    }
    const famineRevolution = active && isFamineRevolution(world, nation.food) &&
      item.pressure >= 100 && world.time.slowTick >= item.cooldownUntilSlowTick;
    item.pressure = Math.max(0, Math.min(100, item.pressure));
    item.phase = famineRevolution ? "revolution" : !vulnerable && item.pressure > 0 && item.pressure < pressureBefore ? "recovering" : item.pressure >= 100 && item.lowSupportSeconds >= balance.minimumCrisisSeconds && nation.warCooperation <= balance.criticalSupport && world.time.slowTick >= item.cooldownUntilSlowTick ? "revolution" : item.pressure >= 60 ? "crisis" : item.pressure > 0 ? "discontent" : "stable";
    if (before !== item.phase && (item.phase === "crisis" || item.phase === "recovering")) recordSimulationEvent(world, {
      category: "diplomacy", nationIds: [nation.id], message: `${getNationName(world, nation.id)}: domestic unrest ${item.phase} (${Math.round(item.pressure)}/100).` });
  }
}
export function canRevolt(world: WorldState, id: NationId): boolean {
  const nation = world.nations.find((item) => item.id === id), unrest = getDomesticUnrest(world, id), balance = WORLD_BALANCE.war.civilWar;
  if (nation && isNationActive(nation) && unrest.pressure >= 100 &&
    world.time.slowTick >= unrest.cooldownUntilSlowTick && isFamineRevolution(world, nation.food)) return true;
  return !!nation && nation.warCooperation <= balance.criticalSupport && unrest.pressure >= 100 &&
    unrest.lowSupportSeconds >= balance.minimumCrisisSeconds && world.time.slowTick >= unrest.cooldownUntilSlowTick &&
    world.wars.some((war) => war.nationAId === id || war.nationBId === id);
}
export function recordRevolution(world: WorldState, parent: NationId, rebel: NationId): void {
  for (const id of [parent, rebel]) {
    const unrest = getDomesticUnrest(world, id); unrest.pressure = 0; unrest.lowSupportSeconds = 0;
    unrest.cooldownUntilSlowTick = world.time.slowTick + WORLD_BALANCE.war.civilWar.revolutionCooldownSeconds; unrest.phase = "stable";
  }
  getDomesticUnrest(world, parent).revolutions++;
}
export function relieveUnrestAfterPeace(world: WorldState, id: NationId): void {
  const item = getDomesticUnrest(world, id), stillFighting = world.wars.some((war) => war.nationAId === id || war.nationBId === id);
  item.pressure = Math.max(0, item.pressure - (stillFighting ? 5 : 35));
  if (!stillFighting) { item.cooldownUntilSlowTick = Math.max(item.cooldownUntilSlowTick, world.time.slowTick + 90); item.phase = item.pressure ? "recovering" : "stable"; }
}
