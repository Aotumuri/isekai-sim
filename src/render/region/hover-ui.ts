import { Container } from "pixi.js";
import type { Vec2 } from "../../utils/vector";
import type { MacroRegion } from "../../worldgen/macro-region";
import type { MesoRegion } from "../../worldgen/meso-region";
import type { UnitState } from "../../sim/unit";
import type { WorldState } from "../../sim/world-state";
import type { Renderer } from "../renderer";
import { buildRegionBounds, findRegion } from "./hit-test";
import { createRegionHoverPanel } from "./panel";
import { formatRegionTooltip } from "./tooltip";
import type { Nation } from "../../worldgen/nation";

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
  const macroByMesoId = new Map<string, MacroRegion>();
  for (const macro of world.macroRegions) {
    for (const mesoId of macro.mesoRegionIds) {
      macroByMesoId.set(mesoId, macro);
    }
  }
  const nationById = new Map<string, Nation>();
  for (const nation of world.nations) {
    nationById.set(nation.id, nation);
  }
  let unitsByMesoId = new Map<string, UnitState[]>();
  let cachedUnitTick = -1;

  let activeRegionId: string | null = null;
  let isSpacePressed = false;
  let lastPointerGlobal: Vec2 | null = null;
  let lastInfoTick = -1;

  const isWorldPointer = (screenPos: Vec2 | null): boolean => {
    if (!screenPos) {
      return false;
    }
    const worldWidth = renderer.app.screen.width - renderer.uiRightWidth;
    return screenPos.x <= worldWidth;
  };

  const getUnitsForMeso = (mesoId: string | null): UnitState[] => {
    if (!mesoId) {
      return [];
    }
    if (cachedUnitTick !== world.time.fastTick) {
      unitsByMesoId = new Map<string, UnitState[]>();
      for (const unit of world.units) {
        const list = unitsByMesoId.get(unit.regionId);
        if (list) {
          list.push(unit);
        } else {
          unitsByMesoId.set(unit.regionId, [unit]);
        }
      }
      cachedUnitTick = world.time.fastTick;
    }
    return unitsByMesoId.get(mesoId) ?? [];
  };

  const updatePanel = (screenPos: Vec2 | null): void => {
    if (!screenPos || !isSpacePressed || !isWorldPointer(screenPos)) {
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

    if (activeRegionId !== region.id || lastInfoTick !== world.time.fastTick) {
      activeRegionId = region.id;
      lastInfoTick = world.time.fastTick;
      const meso = region.mesoRegionId ? mesoById.get(region.mesoRegionId) ?? null : null;
      const macro = region.mesoRegionId ? macroByMesoId.get(region.mesoRegionId) ?? null : null;
      const nation = macro ? nationById.get(macro.nationId) ?? null : null;
      const units = getUnitsForMeso(region.mesoRegionId);
      panel.setText(formatRegionTooltip(region, meso, macro, nation, units));
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
