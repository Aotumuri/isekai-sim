import { Graphics, type Container } from "pixi.js";
import { clearLayer } from "../clear-layer";
import { getMicroRegionByIdMap } from "../region-index";
import type { MacroRegion } from "../../worldgen/macro-region";
import type { MicroRegion } from "../../worldgen/micro-region";
import type { Nation } from "../../worldgen/nation";
import { findSharedSegments, type Segment } from "../meso-border-geometry";
import { getNationColor } from "../nation-color";

const BORDER_WIDTH = 2.2;
const BORDER_ALPHA = 1.0;
const FILL_ALPHA = 0.2;

export function drawNationBorders(
  layer: Container,
  microRegions: MicroRegion[],
  macroRegions: MacroRegion[],
  nations: Nation[],
): void {
  clearLayer(layer);

  if (macroRegions.length === 0 || nations.length === 0) {
    return;
  }

  const mesoToMacroId = new Map<string, MacroRegion["id"]>();
  const nationIdByMacroId = new Map<MacroRegion["id"], Nation["id"]>();
  for (const macro of macroRegions) {
    nationIdByMacroId.set(macro.id, macro.nationId);
    for (const mesoId of macro.mesoRegionIds) {
      mesoToMacroId.set(mesoId, macro.id);
    }
  }

  const colorByNationId = new Map<Nation["id"], number>();
  for (const nation of nations) {
    colorByNationId.set(nation.id, getNationColor(nation.id));
  }

  const regionsByNationId = new Map<Nation["id"], MicroRegion[]>();
  for (const region of microRegions) {
    if (!region.mesoRegionId) {
      continue;
    }
    const macroId = mesoToMacroId.get(region.mesoRegionId);
    if (!macroId) {
      continue;
    }
    const nationId = nationIdByMacroId.get(macroId);
    if (!nationId) {
      continue;
    }
    const list = regionsByNationId.get(nationId);
    if (list) {
      list.push(region);
    } else {
      regionsByNationId.set(nationId, [region]);
    }
  }

  for (const nation of nations) {
    const regions = regionsByNationId.get(nation.id);
    if (!regions || regions.length === 0) {
      continue;
    }

    const fillGraphics = new Graphics();
    fillGraphics.beginFill(colorByNationId.get(nation.id) ?? 0xffffff, FILL_ALPHA);
    for (const region of regions) {
      drawPolygon(fillGraphics, region);
    }
    fillGraphics.endFill();
    layer.addChild(fillGraphics);
  }

  const graphicsByNationId = new Map<Nation["id"], Graphics>();
  const getGraphics = (nationId: Nation["id"]): Graphics => {
    let graphics = graphicsByNationId.get(nationId);
    if (!graphics) {
      graphics = new Graphics();
      graphics.lineStyle({
        width: BORDER_WIDTH,
        color: colorByNationId.get(nationId) ?? 0xffffff,
        alpha: BORDER_ALPHA,
        cap: "round",
        join: "round",
      });
      graphicsByNationId.set(nationId, graphics);
      layer.addChild(graphics);
    }
    return graphics;
  };

  const regionById = getMicroRegionByIdMap(microRegions);

  for (const region of microRegions) {
    for (const neighborId of region.neighbors) {
      if (region.id >= neighborId) {
        continue;
      }

      const neighbor = regionById.get(neighborId);
      if (!neighbor) {
        continue;
      }

      const macroA = region.mesoRegionId ? mesoToMacroId.get(region.mesoRegionId) : null;
      const macroB = neighbor.mesoRegionId ? mesoToMacroId.get(neighbor.mesoRegionId) : null;
      if (!macroA && !macroB) {
        continue;
      }
      if (macroA && macroA === macroB) {
        continue;
      }

      const segments = findSharedSegments(region, neighbor);
      if (segments.length === 0) {
        continue;
      }

      const nationA = macroA ? nationIdByMacroId.get(macroA) ?? null : null;
      const nationB = macroB ? nationIdByMacroId.get(macroB) ?? null : null;

      if (nationA) {
        drawSegments(getGraphics(nationA), segments);
      }
      if (nationB && nationB !== nationA) {
        drawSegments(getGraphics(nationB), segments);
      }
    }
  }
}

function drawSegments(graphics: Graphics, segments: Segment[]): void {
  for (const segment of segments) {
    graphics.moveTo(segment.a.x, segment.a.y);
    graphics.lineTo(segment.b.x, segment.b.y);
  }
}

function drawPolygon(graphics: Graphics, region: MicroRegion): void {
  const [firstPoint, ...rest] = region.polygon;
  if (!firstPoint) {
    return;
  }

  graphics.moveTo(firstPoint.x, firstPoint.y);
  for (const point of rest) {
    graphics.lineTo(point.x, point.y);
  }
  graphics.closePath();
}
