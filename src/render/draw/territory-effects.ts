import { Container, Graphics } from "pixi.js";
import type { OccupationState } from "../../sim/occupation";
import type { MacroRegion } from "../../worldgen/macro-region";
import type { MicroRegion } from "../../worldgen/micro-region";
import type { NationId } from "../../worldgen/nation";
import { getNationColor } from "../nation-color";

const HATCH_SPACING = 12;
const HATCH_WIDTH = 2;
const HATCH_ALPHA = 0.5;

export function drawTerritoryEffects(
  layer: Container,
  microRegions: MicroRegion[],
  macroRegions: MacroRegion[],
  occupation: OccupationState,
  width: number,
  height: number,
): void {
  layer.removeChildren();

  if (occupation.macroById.size === 0 && occupation.mesoById.size === 0) {
    return;
  }

  const mesoToMacroId = new Map<string, MacroRegion["id"]>();
  for (const macro of macroRegions) {
    for (const mesoId of macro.mesoRegionIds) {
      mesoToMacroId.set(mesoId, macro.id);
    }
  }

  const macroOccupierByMesoId = new Map<string, NationId>();
  for (const macro of macroRegions) {
    const macroOccupier = occupation.macroById.get(macro.id);
    if (!macroOccupier) {
      continue;
    }
    for (const mesoId of macro.mesoRegionIds) {
      macroOccupierByMesoId.set(mesoId, macroOccupier);
    }
  }

  const macroRegionsByNationId = new Map<NationId, MicroRegion[]>();
  const mesoRegionsByNationId = new Map<NationId, MicroRegion[]>();
  for (const region of microRegions) {
    if (!region.mesoRegionId) {
      continue;
    }
    const macroId = mesoToMacroId.get(region.mesoRegionId);
    if (!macroId) {
      continue;
    }
    const macroOccupier = macroOccupierByMesoId.get(region.mesoRegionId);
    if (macroOccupier) {
      const list = macroRegionsByNationId.get(macroOccupier);
      if (list) {
        list.push(region);
      } else {
        macroRegionsByNationId.set(macroOccupier, [region]);
      }
      continue;
    }
    const mesoOccupier = occupation.mesoById.get(region.mesoRegionId);
    if (!mesoOccupier) {
      continue;
    }
    const list = mesoRegionsByNationId.get(mesoOccupier);
    if (list) {
      list.push(region);
    } else {
      mesoRegionsByNationId.set(mesoOccupier, [region]);
    }
  }

  const bounds = { minX: 0, minY: 0, maxX: width, maxY: height };

  for (const [nationId, regions] of macroRegionsByNationId.entries()) {
    if (regions.length === 0) {
      continue;
    }

    drawHatchedRegions(layer, nationId, regions, bounds, true);
  }

  for (const [nationId, regions] of mesoRegionsByNationId.entries()) {
    if (regions.length === 0) {
      continue;
    }

    drawHatchedRegions(layer, nationId, regions, bounds, false);
  }
}

function drawHatchLines(
  graphics: Graphics,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  spacing: number,
): void {
  const height = bounds.maxY - bounds.minY;
  let startX = bounds.minX - height;
  const endX = bounds.maxX;
  for (let x = startX; x <= endX; x += spacing) {
    graphics.moveTo(x, bounds.minY);
    graphics.lineTo(x + height, bounds.maxY);
  }
}

function drawHatchLinesReverse(
  graphics: Graphics,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  spacing: number,
): void {
  const height = bounds.maxY - bounds.minY;
  let startX = bounds.minX;
  const endX = bounds.maxX + height;
  for (let x = startX; x <= endX; x += spacing) {
    graphics.moveTo(x, bounds.minY);
    graphics.lineTo(x - height, bounds.maxY);
  }
}

function drawHatchedRegions(
  layer: Container,
  nationId: NationId,
  regions: MicroRegion[],
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  crossHatch: boolean,
): void {
  const mask = new Graphics();
  mask.beginFill(0xffffff, 1);
  for (const region of regions) {
    drawPolygon(mask, region);
  }
  mask.endFill();
  mask.renderable = false;
  layer.addChild(mask);

  const hatch = new Graphics();
  hatch.lineStyle({
    width: HATCH_WIDTH,
    color: getNationColor(nationId),
    alpha: HATCH_ALPHA,
  });
  drawHatchLines(hatch, bounds, HATCH_SPACING);
  if (crossHatch) {
    drawHatchLinesReverse(hatch, bounds, HATCH_SPACING);
  }
  hatch.mask = mask;
  layer.addChild(hatch);
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
