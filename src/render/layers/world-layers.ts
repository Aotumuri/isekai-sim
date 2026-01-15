import { Container } from "pixi.js";

export const WORLD_LAYER_ORDER = [
  "UnitEffect",
  "Unit",
  "CityCapitalResourceIcons",
  "TerritoryEffects",
  "NationFill",
  "MacroBorder",
  "MesoBorder",
  "MicroTerrain",
] as const;

export type WorldLayerId = (typeof WORLD_LAYER_ORDER)[number];

export interface WorldLayers {
  root: Container;
  layers: Record<WorldLayerId, Container>;
}

export function createWorldLayers(): WorldLayers {
  const root = new Container();
  const layers = {} as Record<WorldLayerId, Container>;

  for (const layerId of [...WORLD_LAYER_ORDER].reverse()) {
    const layer = new Container();
    layer.name = layerId;
    layers[layerId] = layer;
    root.addChild(layer);
  }

  return { root, layers };
}
