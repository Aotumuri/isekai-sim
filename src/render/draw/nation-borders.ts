import { Graphics, type Container } from "pixi.js";
import type { MacroRegion } from "../../worldgen/macro-region";
import type { MicroRegion } from "../../worldgen/micro-region";
import type { Nation, NationId } from "../../worldgen/nation";
import { clearLayer } from "../clear-layer";
import { findSharedSegments, type Segment } from "../meso-border-geometry";
import { getNationColor } from "../nation-color";
import { getMicroRegionByIdMap } from "../region-index";

const BORDER_WIDTH = 2.2;
const BORDER_ALPHA = 1.0;
const FILL_ALPHA = 0.2;

type MacroGraphics = {
  fill: Graphics;
  border: Graphics;
  nationId: NationId;
};

type NationBorderCache = {
  microRegions: MicroRegion[];
  macroRegions: MacroRegion[];
  graphicsByMacroId: Map<MacroRegion["id"], MacroGraphics>;
};

const borderCacheByLayer = new WeakMap<Container, NationBorderCache>();

export function drawNationBorders(
  layer: Container,
  microRegions: MicroRegion[],
  macroRegions: MacroRegion[],
  nations: Nation[],
): void {
  if (macroRegions.length === 0 || nations.length === 0) {
    return;
  }

  const cache = getNationBorderCache(layer, microRegions, macroRegions);
  for (const macro of macroRegions) {
    const graphics = cache.graphicsByMacroId.get(macro.id);
    if (!graphics || graphics.nationId === macro.nationId) {
      continue;
    }
    const color = getNationColor(macro.nationId);
    graphics.fill.tint = color;
    graphics.border.tint = color;
    graphics.nationId = macro.nationId;
  }
}

function getNationBorderCache(
  layer: Container,
  microRegions: MicroRegion[],
  macroRegions: MacroRegion[],
): NationBorderCache {
  const cached = borderCacheByLayer.get(layer);
  if (cached && cached.microRegions === microRegions && cached.macroRegions === macroRegions) {
    return cached;
  }

  clearLayer(layer);

  const mesoToMacroId = new Map<string, MacroRegion["id"]>();
  const graphicsByMacroId = new Map<MacroRegion["id"], MacroGraphics>();
  for (const macro of macroRegions) {
    for (const mesoId of macro.mesoRegionIds) {
      mesoToMacroId.set(mesoId, macro.id);
    }

    const fill = new Graphics();
    fill.name = `NationFill:${macro.id}`;
    fill.beginFill(0xffffff, FILL_ALPHA);
    fill.tint = getNationColor(macro.nationId);

    const border = new Graphics();
    border.name = `NationBorder:${macro.id}`;
    border.lineStyle({
      width: BORDER_WIDTH,
      color: 0xffffff,
      alpha: BORDER_ALPHA,
      cap: "round",
      join: "round",
    });
    border.tint = getNationColor(macro.nationId);

    graphicsByMacroId.set(macro.id, {
      fill,
      border,
      nationId: macro.nationId,
    });
  }

  for (const region of microRegions) {
    const macroId = region.mesoRegionId ? mesoToMacroId.get(region.mesoRegionId) : null;
    if (!macroId) {
      continue;
    }
    const graphics = graphicsByMacroId.get(macroId);
    if (graphics) {
      drawPolygon(graphics.fill, region);
    }
  }
  for (const graphics of graphicsByMacroId.values()) {
    graphics.fill.endFill();
  }

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
      const macroB = neighbor.mesoRegionId
        ? mesoToMacroId.get(neighbor.mesoRegionId)
        : null;
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

      if (macroA) {
        const graphics = graphicsByMacroId.get(macroA);
        if (graphics) {
          drawSegments(graphics.border, segments);
        }
      }
      if (macroB && macroB !== macroA) {
        const graphics = graphicsByMacroId.get(macroB);
        if (graphics) {
          drawSegments(graphics.border, segments);
        }
      }
    }
  }

  for (const graphics of graphicsByMacroId.values()) {
    layer.addChild(graphics.fill);
  }
  for (const graphics of graphicsByMacroId.values()) {
    layer.addChild(graphics.border);
  }

  const cache: NationBorderCache = { microRegions, macroRegions, graphicsByMacroId };
  borderCacheByLayer.set(layer, cache);
  return cache;
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
