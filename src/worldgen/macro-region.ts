import type { MesoRegionId } from "./meso-region";
import type { NationId } from "./nation";

export type MacroRegionId = string & { __brand: "MacroRegionId" };

export interface MacroRegion {
  id: MacroRegionId;
  nationId: NationId;
  mesoRegionIds: MesoRegionId[];
  isCore: boolean;
}

export function createMacroRegionId(index: number): MacroRegionId {
  return `macro-${index}` as MacroRegionId;
}
