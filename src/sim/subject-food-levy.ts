import type { NationId } from "../worldgen/nation";
import { findTradeRoute } from "./international-trade";
import { recordSimulationEvent } from "./simulation-settings";
import { getSubjectOverlord } from "./subject-governments";
import type { WorldState } from "./world-state";

export const FOOD_LEVY_RATES = [0, 0.15, 0.30, 0.50] as const;
export type FoodLevyRate = typeof FOOD_LEVY_RATES[number];

export function setSubjectFoodLevy(world: WorldState, overlord: NationId, subject: NationId, rate: number): boolean {
  if (world.settings?.foodEnabled === false || !FOOD_LEVY_RATES.includes(rate as FoodLevyRate) ||
    getSubjectOverlord(world, subject) !== overlord) return false;
  const government = world.nations.find((nation) => nation.id === subject)!.subjectGovernment!;
  if ((government.foodLevy ?? 0) === rate) return false;
  government.foodLevy = rate as FoodLevyRate;
  recordSimulationEvent(world, { category: "politics", nationIds: [overlord, subject],
    message: `${overlord} set ${subject}'s food levy to ${Math.round(rate * 100)}% of its harvest.` });
  return true;
}

export function collectSubjectFoodLevies(world: WorldState, harvests: ReadonlyMap<NationId, { harvest: number }>): Map<NationId, number> {
  const transfers = new Map<NationId, number>();
  if (world.time.slowTick === 0) return transfers;
  for (const subject of world.nations) {
    const rate = subject.subjectGovernment?.foodLevy ?? 0;
    if (!rate) continue;
    const overlord = getSubjectOverlord(world, subject.id);
    const harvest = harvests.get(subject.id)?.harvest ?? 0;
    if (!overlord || harvest <= 0 || !harvests.has(overlord) || !findTradeRoute(world, subject.id, overlord)) continue;
    const amount = harvest * rate;
    transfers.set(subject.id, (transfers.get(subject.id) ?? 0) - amount);
    transfers.set(overlord, (transfers.get(overlord) ?? 0) + amount);
  }
  return transfers;
}
