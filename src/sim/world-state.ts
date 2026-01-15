import type { MicroRegion } from "../worldgen/micro-region";

export interface WorldState {
  width: number;
  height: number;
  microRegions: MicroRegion[];
}
