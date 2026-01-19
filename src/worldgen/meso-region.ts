import type { MicroRegionId } from "./micro-region";

export type MesoRegionId = string & { __brand: "MesoRegionId" };

export type MesoRegionType = "land" | "sea" | "river";

export type MesoRegionBuilding = "capital" | "city" | "port";

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
  building: MesoRegionBuilding | null;
}

export function createMesoRegionId(index: number): MesoRegionId {
  return `meso-${index}` as MesoRegionId;
}
