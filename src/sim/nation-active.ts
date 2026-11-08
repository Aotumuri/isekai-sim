import type { WorldState } from "./world-state";
import type { NationRuntime } from "./nation-runtime";

export function isNationActive(
  nation: Pick<NationRuntime, "macroRegionIds">,
): boolean {
  return nation.macroRegionIds.length > 0;
}

/** Diplomatic presence includes recognized governments that have lost all territory. */
export function isNationPresent(world: WorldState, nation: Pick<NationRuntime, "id" | "macroRegionIds">): boolean {
  return isNationActive(nation) || world.exileGovernments?.byNationId.get(nation.id)?.status === "exiled";
}
