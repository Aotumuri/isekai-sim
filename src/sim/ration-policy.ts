import type { NationId } from "../worldgen/nation";
import { isNationActive } from "./nation-active";
import type { WorldState } from "./world-state";

export const RATION_POLICIES = { normal: 1, conserve: 0.94, emergency: 0.88 } as const;
export type RationPolicy = keyof typeof RATION_POLICIES;

export function setRationPolicy(world: WorldState, id: NationId, policy: RationPolicy): boolean {
  const nation = world.nations.find((item) => item.id === id);
  if (!nation?.food || !isNationActive(nation) || world.settings?.foodEnabled === false ||
    !Object.hasOwn(RATION_POLICIES, policy)) return false;
  nation.food.rationPolicy = policy;
  return true;
}
