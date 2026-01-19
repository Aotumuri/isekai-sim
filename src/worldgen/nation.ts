import type { MesoRegionId } from "./meso-region";
import type { MacroRegionId } from "./macro-region";

export type NationId = string & { __brand: "NationId" };

export interface Nation {
  id: NationId;
  capitalMesoId: MesoRegionId;
  macroRegionIds: MacroRegionId[];
}

export function createNationId(index: number): NationId {
  return `nation-${index}` as NationId;
}
