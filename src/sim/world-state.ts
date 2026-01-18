import type { MicroRegion } from "../worldgen/micro-region";
import type { MicroRegionEdge } from "../worldgen/micro-region-edge";
import type { MesoRegion } from "../worldgen/meso-region";

export interface WorldState {
  width: number;
  height: number;
  microRegions: MicroRegion[];
  microRegionEdges: MicroRegionEdge[];
  mesoRegions: MesoRegion[];
}
