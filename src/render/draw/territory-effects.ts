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

  const occupierByMesoId = new Map<string, NationId>();
  for (const macro of macroRegions) {
    const macroOccupier = occupation.macroById.get(macro.id);
    if (!macroOccupier) {
      continue;
    }
    for (const mesoId of macro.mesoRegionIds) {
      occupierByMesoId.set(mesoId, macroOccupier);
    }
  }

  for (const [mesoId, occupier] of occupation.mesoById.entries()) {
    if (!occupierByMesoId.has(mesoId)) {
      occupierByMesoId.set(mesoId, occupier);
    }
  }

  const regionsByNationId = new Map<NationId, MicroRegion[]>();
  for (const region of microRegions) {
    if (!region.mesoRegionId) {
      continue;
    }
    const macroId = mesoToMacroId.get(region.mesoRegionId);
    if (!macroId) {
      continue;
    }
    const occupier = occupierByMesoId.get(region.mesoRegionId);
    if (!occupier) {
      continue;
    }
    const list = regionsByNationId.get(occupier);
    if (list) {
      list.push(region);
    } else {
      regionsByNationId.set(occupier, [region]);
    }
  }

  const bounds = { minX: 0, minY: 0, maxX: width, maxY: height };

  for (const [nationId, regions] of regionsByNationId.entries()) {
    if (regions.length === 0) {
      continue;
    }

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
    hatch.mask = mask;
    layer.addChild(hatch);
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
