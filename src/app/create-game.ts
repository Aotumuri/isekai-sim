import { createWorldConfig } from "../data/world-config";
import { drawCityCapitalIcons } from "../render/draw/city-capital-icons";
import { drawMesoBorders } from "../render/draw/meso-borders";
import { drawMicroRegions } from "../render/draw/micro-regions";
import { drawNationBorders } from "../render/draw/nation-borders";
import { drawTerritoryEffects } from "../render/draw/territory-effects";
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
  drawTerritoryEffects(
    renderer.worldLayers.layers.TerritoryEffects,
    world.microRegions,
    world.macroRegions,
    world.occupation,
    config.width,
    config.height,
  );
  drawCityCapitalIcons(
    renderer.worldLayers.layers.CityCapitalResourceIcons,
    world.mesoRegions,
  );
  drawUnits(
    renderer.worldLayers.layers.Unit,
    world.units,
    world.mesoRegions,
    0,
  );
  attachViewControls(renderer);
  attachRegionHoverUI(renderer, world);
  const clock = createSimClock();
  attachTimeControls(clock);
  const timeHud = attachTimeHud(renderer);
  let lastOccupationVersion = world.occupation.version;
  let lastTerritoryVersion = world.territoryVersion;

  renderer.app.ticker.add(() => {
    updateSimulation(world, clock, renderer.app.ticker.deltaMS);
    if (world.territoryVersion !== lastTerritoryVersion) {
      drawNationBorders(
        renderer.worldLayers.layers.NationFill,
        world.microRegions,
        world.macroRegions,
        world.nations,
      );
      drawCityCapitalIcons(
        renderer.worldLayers.layers.CityCapitalResourceIcons,
        world.mesoRegions,
      );
      lastTerritoryVersion = world.territoryVersion;
    }
    if (world.occupation.version !== lastOccupationVersion) {
      drawTerritoryEffects(
        renderer.worldLayers.layers.TerritoryEffects,
        world.microRegions,
        world.macroRegions,
        world.occupation,
        config.width,
        config.height,
      );
      lastOccupationVersion = world.occupation.version;
    }
    timeHud.update(world.time, clock);
    drawUnits(
      renderer.worldLayers.layers.Unit,
      world.units,
      world.mesoRegions,
      clock.accumulatorMs,
    );
  });
}
