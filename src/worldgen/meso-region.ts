import type { MicroRegionId } from "./micro-region";

export type MesoRegionId = string & { __brand: "MesoRegionId" };

export type MesoRegionType = "land" | "sea" | "river";

export interface MesoRegionNeighbor {
  id: MesoRegionId;
  hasRiver: boolean;
}

export interface MesoRegion {
  id: MesoRegionId;
  type: MesoRegionType;
  centerId: MicroRegionId;
  microRegionIds: MicroRegionId[];
  neighbors: MesoRegionNeighbor[];
}

export function createMesoRegionId(index: number): MesoRegionId {
  return `meso-${index}` as MesoRegionId;
}
