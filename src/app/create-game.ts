import { createWorldConfig } from "../data/world-config";
import { drawMicroRegions } from "../render/draw-micro-regions";
import { createRenderer } from "../render/renderer";
import { createWorld } from "../sim/create-world";

export function createGame(root: HTMLElement): void {
  const config = createWorldConfig(window.innerWidth, window.innerHeight);
  const renderer = createRenderer(root, config);
  const world = createWorld(config);

  drawMicroRegions(renderer.worldLayers.layers.MicroTerrain, world.microRegions);
}
