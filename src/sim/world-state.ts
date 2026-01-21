import type { MicroRegion } from "../worldgen/micro-region";
import type { MicroRegionEdge } from "../worldgen/micro-region-edge";
import type { MacroRegion } from "../worldgen/macro-region";
import type { MesoRegion } from "../worldgen/meso-region";
import type { Nation } from "../worldgen/nation";
import type { UnitState } from "./unit";

export interface WorldState {
  width: number;
  height: number;
  microRegions: MicroRegion[];
  microRegionEdges: MicroRegionEdge[];
  mesoRegions: MesoRegion[];
  macroRegions: MacroRegion[];
  nations: Nation[];
  units: UnitState[];
}
