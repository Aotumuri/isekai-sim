import { getPlayerNation } from "../sim/player-nation";
import type { PopulationDimension } from "../sim/regional-population";
import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import type { WorldState } from "../sim/world-state";
export type MapMode = "terrain" | "political" | "diplomacy" | "factions" | "debug" | "claims" | PopulationDimension;
export interface MapViewState {
  claimsReturnMode?: Exclude<MapMode, "claims">;
  territoryPreviewIds?: MesoRegionId[];
  mode: MapMode; selectedNationId: NationId | null; diplomaticFocusId: NationId | null;
  targetNationId: NationId | null; provinceBorders: boolean; districtBorders: boolean; labels: boolean; occupations: boolean; farmland?: boolean; revision: number;
}
export function getMapView(world: WorldState): MapViewState {
  return world.mapView ??= { mode: "political", selectedNationId: null, diplomaticFocusId: null, targetNationId: null,
    provinceBorders: true, districtBorders: false, labels: true, occupations: true, revision: 0 };
}
export function setMapMode(world: WorldState, mode: MapMode): boolean {
  const view = getMapView(world);
  const playerId = getPlayerNation(world)?.nationId;
  if (mode === "claims" && !view.selectedNationId) return false;
  if (mode === "diplomacy") {
    const focus = playerId ?? view.selectedNationId;
    if (!focus) return false;
    view.diplomaticFocusId = focus;
    view.targetNationId = view.selectedNationId !== focus ? view.selectedNationId : null;
  }
  if (mode === "claims" && view.mode !== "claims") view.claimsReturnMode = view.mode;
  view.mode = mode; view.revision += 1; return true;
}
export function selectMapNation(world: WorldState, nationId: NationId | null): void {
  const view = getMapView(world);
  const playerId = getPlayerNation(world)?.nationId;
  if (playerId && view.mode === "diplomacy") {
    view.selectedNationId = playerId;
    view.diplomaticFocusId = playerId;
    view.targetNationId = nationId !== playerId ? nationId : null;
    view.revision += 1;
    return;
  }
  const previousFocus = view.diplomaticFocusId;
  view.selectedNationId = nationId;
  view.diplomaticFocusId = nationId;
  view.targetNationId = view.mode === "diplomacy" && previousFocus !== nationId ? previousFocus : null;
  if (!nationId && (view.mode === "diplomacy" || view.mode === "claims")) { view.mode = "political"; view.targetNationId = null; }
  view.revision += 1;
}

export function toggleClaimsMap(world: WorldState): boolean {
  const view = getMapView(world);
  return setMapMode(world, view.mode === "claims" ? view.claimsReturnMode ?? "political" : "claims");
}
