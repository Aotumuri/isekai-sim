import type { NationRuntime } from "./nation-runtime";

export function isNationActive(
  nation: Pick<NationRuntime, "macroRegionIds">,
): boolean {
  return nation.macroRegionIds.length > 0;
}
