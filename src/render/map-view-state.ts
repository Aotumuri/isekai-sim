import type { NationId } from "../worldgen/nation";
import type { WorldState } from "../sim/world-state";
export type MapMode = "political" | "diplomacy" | "factions" | "debug";
export interface MapViewState {
  mode: MapMode; selectedNationId: NationId | null; diplomaticFocusId: NationId | null;
  targetNationId: NationId | null; provinceBorders: boolean; districtBorders: boolean; labels: boolean; revision: number;
}
export function getMapView(world: WorldState): MapViewState {
  return world.mapView ??= { mode: "political", selectedNationId: null, diplomaticFocusId: null, targetNationId: null,
    provinceBorders: true, districtBorders: false, labels: true, revision: 0 };
}
export function setMapMode(world: WorldState, mode: MapMode): boolean {
  const view = getMapView(world);
  if (mode === "diplomacy" && !view.selectedNationId) return false;
  if (mode === "diplomacy" && view.mode !== "diplomacy") view.diplomaticFocusId = view.selectedNationId;
  view.mode = mode; view.revision += 1; return true;
}
export function selectMapNation(world: WorldState, nationId: NationId | null): void {
  const view = getMapView(world);
  if (view.mode === "diplomacy" && view.diplomaticFocusId) view.targetNationId = nationId === view.diplomaticFocusId ? null : nationId;
  else { view.selectedNationId = nationId; view.targetNationId = null; }
  view.revision += 1;
}
