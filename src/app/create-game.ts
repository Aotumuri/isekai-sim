import { createWorldConfig } from "../data/world-config";
import { drawMesoBorders } from "../render/draw-meso-borders";
import { drawMicroRegions } from "../render/draw-micro-regions";
import { attachRegionHoverUI } from "../render/region-hover-ui";
import { createRenderer } from "../render/renderer";
import { createWorld } from "../sim/create-world";

export function createGame(root: HTMLElement): void {
  const config = createWorldConfig(window.innerWidth, window.innerHeight);
  const renderer = createRenderer(root, config);
  const world = createWorld(config);

  drawMicroRegions(renderer.worldLayers.layers.MicroTerrain, world.microRegions);
  drawMesoBorders(renderer.worldLayers.layers.MesoBorder, world.microRegions);
  attachRegionHoverUI(renderer, world);
}
