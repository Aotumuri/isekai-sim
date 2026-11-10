import type { MesoRegionId } from "../worldgen/meso-region";
import { attachPlayerControls } from "./player-controls";
import { attachMapControls } from "./map-controls";
import { attachPlayerMap } from "../render/player-map";
import { attachSocietyPanel } from "./society-panel";
import { createDefaultWorldConfig, createWorldConfig, type WorldMapPreset } from "../data/world-config";
import { drawCityCapitalIcons } from "../render/draw/city-capital-icons";
import { drawMesoBorders } from "../render/draw/meso-borders";
import { drawMicroRegions } from "../render/draw/micro-regions";
import { drawNationBorders } from "../render/draw/nation-borders";
import { drawTerritoryEffects, setTerritoryEffectsRenderer } from "../render/draw/territory-effects";
import { drawUnits } from "../render/draw/units";
import { attachRegionHoverUI } from "../render/region/hover-ui";
import { createRenderer } from "../render/renderer";
import { attachTimeHud } from "../render/time-hud";
import { attachViewControls } from "../render/view/controls";
import { attachNationInfoBar } from "../render/nation-info-bar";
import { getNationColor } from "../render/nation-color";
import type { NationId } from "../worldgen/nation";
import { attachFrontDebugOverlay } from "../render/front-debug-overlay";
import { createWorld } from "../sim/create-world";
import { createSimClock, getSpeedMultiplier } from "../sim/time";
import { updateSimulation } from "../sim/update";
import { attachTimeControls } from "./time-controls";
import type { WorldState } from "../sim/world-state";

const MAX_UNIT_ANIMATION_SPEED = 4;

export function createGame(root: HTMLElement, setup: { world?: WorldState; paused?: boolean; preset?: WorldMapPreset } = {}): void {
  const config = setup.world
    ? createWorldConfig(setup.world.width, setup.world.height)
    : createDefaultWorldConfig(setup.preset);
  if (setup.world?.worldSeed !== undefined) config.seed = setup.world.worldSeed;
  console.log("World generation seed:", config.seed);
  const renderer = createRenderer(root);
  setTerritoryEffectsRenderer(renderer.app.renderer);
  const world = setup.world ?? createWorld(config);
  const nationColor = (id: NationId) => getNationColor(id, world);
  drawMicroRegions(renderer.worldLayers.layers.MicroTerrain, world.microRegions);
  drawMesoBorders(renderer.worldLayers.layers.MesoBorder, world.microRegions);
  drawNationBorders(
    renderer.worldLayers.layers.NationFill,
    world.microRegions,
    world.macroRegions,
    world.nations,
    nationColor,
  );
  drawTerritoryEffects(
    renderer.worldLayers.layers.TerritoryEffects,
    world.microRegions,
    world.macroRegions,
    world.occupation,
    config.width,
    config.height,
    nationColor,
  );
  world.occupation.dirtyMesoIds.clear();
  drawCityCapitalIcons(
    renderer.worldLayers.layers.CityCapitalResourceIcons,
    world.mesoRegions,
  );
  drawUnits(
    renderer.worldLayers.layers.Unit,
    renderer.app.renderer,
    world.units,
    world.mesoRegions,
    nationColor,
    0,
  );
  attachRegionHoverUI(renderer, world);
  const nationInfoBar = attachNationInfoBar(renderer, world);
  let overviewScale: number | undefined;
  if (!setup.world) {
    const { width, height } = renderer.app.screen;
    const mapWidth = width - renderer.uiRightWidth;
    overviewScale = Math.min(1, mapWidth / world.width, height / world.height);
    const scale = overviewScale * 1.5;
    renderer.worldContainer.scale.set(scale);
    renderer.worldContainer.position.set((mapWidth - world.width * scale) / 2, (height - world.height * scale) / 2);
  }
  attachViewControls(renderer, overviewScale);
  const clock = createSimClock();
  clock.paused = setup.paused ?? false;
  const societyPanel = attachSocietyPanel(root, world, clock);
  attachTimeControls(clock);
  const timeHud = attachTimeHud(renderer);
  const frontDebugOverlay = attachFrontDebugOverlay(renderer, world);
  const playerMap = attachPlayerMap(renderer, world);
  let selectedDistrict: MesoRegionId | null = null;
  const mapControls = attachMapControls(root, renderer, world, frontDebugOverlay, societyPanel, (id) => { selectedDistrict = id; });
  const updatePlayerControls = attachPlayerControls(root, world, () => selectedDistrict, societyPanel.setEmbedded);
  playerMap.update();
  let lastOccupationVersion = world.occupation.version;
  let lastTerritoryVersion = world.territoryVersion;
  let lastBuildingVersion = world.buildingVersion;

  renderer.app.ticker.add(() => {
    updateSimulation(world, clock, renderer.app.ticker.deltaMS);
    let shouldRedrawIcons = false;
    if (world.territoryVersion !== lastTerritoryVersion) {
      drawNationBorders(
        renderer.worldLayers.layers.NationFill,
        world.microRegions,
        world.macroRegions,
        world.nations,
        nationColor,
      );
      lastTerritoryVersion = world.territoryVersion;
      shouldRedrawIcons = true;
    }
    if (world.occupation.version !== lastOccupationVersion) {
      drawTerritoryEffects(
        renderer.worldLayers.layers.TerritoryEffects,
        world.microRegions,
        world.macroRegions,
        world.occupation,
        config.width,
        config.height,
        nationColor,
        world.occupation.dirtyMesoIds.size > 0
          ? world.occupation.dirtyMesoIds
          : undefined,
      );
      world.occupation.dirtyMesoIds.clear();
      lastOccupationVersion = world.occupation.version;
      shouldRedrawIcons = true;
    }
    if (world.buildingVersion !== lastBuildingVersion) {
      lastBuildingVersion = world.buildingVersion;
      shouldRedrawIcons = true;
    }
    if (shouldRedrawIcons) {
      drawCityCapitalIcons(
        renderer.worldLayers.layers.CityCapitalResourceIcons,
        world.mesoRegions,
      );
    }
    timeHud.update(world.time, clock);
    mapControls.update();
    updatePlayerControls();
    playerMap.update();
    societyPanel.update();
    nationInfoBar.update();
    frontDebugOverlay.update();
    drawUnits(
      renderer.worldLayers.layers.Unit,
      renderer.app.renderer,
      world.units,
      world.mesoRegions,
      nationColor,
      clock.accumulatorMs,
      getSpeedMultiplier(clock) <= MAX_UNIT_ANIMATION_SPEED,
    );
  });
}
