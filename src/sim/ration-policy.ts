import type { NationId } from "../worldgen/nation";
import { isNationActive } from "./nation-active";
import type { WorldState } from "./world-state";

export const RATION_POLICIES = { normal: 1, conserve: 0.94, emergency: 0.88 } as const;
export type RationPolicy = keyof typeof RATION_POLICIES;

export function setRationPolicy(world: WorldState, id: NationId, policy: RationPolicy): boolean {
  const nation = world.nations.find((item) => item.id === id);
  if (!nation?.food || !isNationActive(nation) || world.settings?.foodEnabled === false ||
    !Object.prototype.hasOwnProperty.call(RATION_POLICIES, policy)) return false;
  nation.food.rationPolicy = policy;
  return true;
}

export function setFoodAsylum(world: WorldState, id: NationId, enabled: boolean): boolean {
  const nation = world.nations.find((item) => item.id === id);
  if (!nation?.food || !isNationActive(nation) || world.settings?.foodEnabled === false) return false;
  nation.food.asylum = enabled;
  return true;
}
