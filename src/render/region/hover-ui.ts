import { Container } from "pixi.js";
import type { Vec2 } from "../../utils/vector";
import type { MesoRegion } from "../../worldgen/meso-region";
import type { WorldState } from "../../sim/world-state";
import type { Renderer } from "../renderer";
import { buildRegionBounds, findRegion } from "./hit-test";
import { createRegionHoverPanel } from "./panel";
import { formatRegionTooltip } from "./tooltip";

export function attachRegionHoverUI(renderer: Renderer, world: WorldState): void {
  const uiLayer = new Container();
  uiLayer.name = "RegionHoverUI";
  renderer.uiContainer.addChild(uiLayer);

  const panel = createRegionHoverPanel(renderer.app.renderer.resolution);
  uiLayer.addChild(panel.container);

  const boundsByIndex = buildRegionBounds(world.microRegions);
  const mesoById = new Map<string, MesoRegion>();
  for (const meso of world.mesoRegions) {
    mesoById.set(meso.id, meso);
  }

  let activeRegionId: string | null = null;
  let isSpacePressed = false;
  let lastPointerGlobal: Vec2 | null = null;

  const updatePanel = (screenPos: Vec2 | null): void => {
    if (!screenPos || !isSpacePressed) {
      panel.hide();
      return;
    }

    const worldPos = renderer.worldContainer.toLocal(screenPos);
    const region = findRegion(worldPos, world.microRegions, boundsByIndex);

    if (!region) {
      activeRegionId = null;
      panel.hide();
      return;
    }

    if (activeRegionId !== region.id) {
      activeRegionId = region.id;
      const meso = region.mesoRegionId ? mesoById.get(region.mesoRegionId) ?? null : null;
      panel.setText(formatRegionTooltip(region, meso));
    }

    panel.position(screenPos, renderer.app.screen);
    panel.show();
  };

  renderer.app.stage.eventMode = "static";
  renderer.app.stage.hitArea = renderer.app.screen;
  renderer.app.stage.on("pointermove", (event) => {
    lastPointerGlobal = { x: event.global.x, y: event.global.y };
    updatePanel(lastPointerGlobal);
  });

  renderer.app.stage.on("pointerleave", () => {
    lastPointerGlobal = null;
    activeRegionId = null;
    panel.hide();
  });

  window.addEventListener("keydown", (event) => {
    if (event.code !== "Space") {
      return;
    }

    if (!isSpacePressed) {
      isSpacePressed = true;
      updatePanel(lastPointerGlobal);
    }

    event.preventDefault();
  });

  window.addEventListener("keyup", (event) => {
    if (event.code !== "Space") {
      return;
    }

    isSpacePressed = false;
    panel.hide();
    event.preventDefault();
  });

  window.addEventListener("blur", () => {
    isSpacePressed = false;
    panel.hide();
  });
}
