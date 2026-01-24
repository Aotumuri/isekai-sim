import type { MicroRegion } from "../worldgen/micro-region";
import type { MicroRegionEdge } from "../worldgen/micro-region-edge";
import type { MacroRegion } from "../worldgen/macro-region";
import type { MesoRegion } from "../worldgen/meso-region";
import type { BattleState } from "./battles";
import type { NationRuntime } from "./nation-runtime";
import type { OccupationState } from "./occupation";
import type { SimTime } from "./time";
import type { UnitState } from "./unit";
import type { WarState } from "./war-state";

export interface WorldState {
  width: number;
  height: number;
  microRegions: MicroRegion[];
  microRegionEdges: MicroRegionEdge[];
  mesoRegions: MesoRegion[];
  macroRegions: MacroRegion[];
  nations: NationRuntime[];
  wars: WarState[];
  battles: BattleState[];
  occupation: OccupationState;
  territoryVersion: number;
  units: UnitState[];
  unitIdCounter: number;
  time: SimTime;
}
