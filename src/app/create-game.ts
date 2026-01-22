import { createWorldConfig } from "../data/world-config";
import { drawMesoBorders } from "../render/draw/meso-borders";
import { drawMicroRegions } from "../render/draw/micro-regions";
import { drawNationBorders } from "../render/draw/nation-borders";
import { drawUnits } from "../render/draw/units";
import { attachRegionHoverUI } from "../render/region/hover-ui";
import { createRenderer } from "../render/renderer";
import { attachTimeHud } from "../render/time-hud";
import { attachViewControls } from "../render/view/controls";
import { createWorld } from "../sim/create-world";
import { createSimClock } from "../sim/time";
import { updateSimulation } from "../sim/update";
import { attachTimeControls } from "./time-controls";

export function createGame(root: HTMLElement): void {
  const config = createWorldConfig(window.innerWidth, window.innerHeight);
  const renderer = createRenderer(root, config);
  const world = createWorld(config);

  drawMicroRegions(renderer.worldLayers.layers.MicroTerrain, world.microRegions);
  drawMesoBorders(renderer.worldLayers.layers.MesoBorder, world.microRegions);
  drawNationBorders(
    renderer.worldLayers.layers.NationFill,
    world.microRegions,
    world.macroRegions,
    world.nations,
  );
  drawUnits(
    renderer.worldLayers.layers.Unit,
    world.units,
    world.mesoRegions,
    world.nations,
  );
  attachViewControls(renderer);
  attachRegionHoverUI(renderer, world);
  const clock = createSimClock();
  attachTimeControls(clock);
  const timeHud = attachTimeHud(renderer);
  let lastFastTick = world.time.fastTick;

  renderer.app.ticker.add(() => {
    updateSimulation(world, clock, renderer.app.ticker.deltaMS);
    timeHud.update(world.time, clock);
    if (world.time.fastTick !== lastFastTick) {
      lastFastTick = world.time.fastTick;
      drawUnits(
        renderer.worldLayers.layers.Unit,
        world.units,
        world.mesoRegions,
        world.nations,
      );
    }
  });
}
