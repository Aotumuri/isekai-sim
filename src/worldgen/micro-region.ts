import type { Vec2 } from "../utils/vector";
import type { MesoRegionId } from "./meso-region";

export type MicroRegionId = string & { __brand: "MicroRegionId" };

export interface MicroRegion {
  id: MicroRegionId;
  site: Vec2;
  polygon: Vec2[];
  neighbors: MicroRegionId[];
  elevation: number;
  isSea: boolean;
  isRiver: boolean;
  mesoRegionId: MesoRegionId | null;
}

export function createMicroRegionId(index: number): MicroRegionId {
  return `micro-${index}` as MicroRegionId;
}
