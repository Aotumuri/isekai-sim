import { Container, Graphics, Sprite, Texture, Renderer, Rectangle } from "pixi.js";
import { clearLayer } from "../clear-layer";
import type { OccupationState } from "../../sim/occupation";
import type { MacroRegion } from "../../worldgen/macro-region";
import type { MicroRegion } from "../../worldgen/micro-region";
import type { NationId } from "../../worldgen/nation";
import { getNationColor } from "../nation-color";

const HATCH_SPACING = 12;
const HATCH_WIDTH = 2;
const HATCH_ALPHA = 0.5;

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

const hatchTextureCache = new Map<string, Texture>();

let sharedRenderer: Renderer | null = null;

export function setTerritoryEffectsRenderer(renderer: Renderer): void {
  sharedRenderer = renderer;
}

function boundsKey(bounds: Bounds, reverse: boolean): string {
  const w = Math.max(0, bounds.maxX - bounds.minX);
  const h = Math.max(0, bounds.maxY - bounds.minY);
  return `${w}x${h}:s${HATCH_SPACING}:w${HATCH_WIDTH}:r${reverse ? 1 : 0}`;
}

function getHatchTexture(bounds: Bounds, reverse: boolean): Texture {
  const key = boundsKey(bounds, reverse);
  const cached = hatchTextureCache.get(key);
  if (cached) {
    return cached;
  }

  const w = Math.max(0, bounds.maxX - bounds.minX);
  const h = Math.max(0, bounds.maxY - bounds.minY);

  const g = new Graphics();
  g.lineStyle({ width: HATCH_WIDTH, color: 0xffffff, alpha: 1 });

  // Draw in local coords (0..w/h) so the texture isn't shifted/cropped by negative start positions.
  const localBounds: Bounds = { minX: 0, minY: 0, maxX: w, maxY: h };
  if (reverse) {
    drawHatchLinesReverse(g, localBounds, HATCH_SPACING);
  } else {
    drawHatchLines(g, localBounds, HATCH_SPACING);
  }

  if (!sharedRenderer) {
    throw new Error("TerritoryEffects renderer not set. Call setTerritoryEffectsRenderer(renderer) once at init.");
  }
  const tex: Texture = sharedRenderer.generateTexture(g, {
    region: new Rectangle(0, 0, w, h),
    resolution: 1,
  });
  g.destroy(true);

  hatchTextureCache.set(key, tex);
  return tex;
}

export function drawTerritoryEffects(
  layer: Container,
  microRegions: MicroRegion[],
  macroRegions: MacroRegion[],
  occupation: OccupationState,
  width: number,
  height: number,
): void {
  clearLayer(layer);

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

  const bounds: Bounds = { minX: 0, minY: 0, maxX: width, maxY: height };

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
  bounds: Bounds,
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

  const color = getNationColor(nationId);

  const hatchTex = getHatchTexture(bounds, false);
  const hatch = new Sprite(hatchTex);
  hatch.position.set(0, 0);
  hatch.tint = color;
  hatch.alpha = HATCH_ALPHA;
  hatch.mask = mask;
  layer.addChild(hatch);

  if (crossHatch) {
    const hatchTexRev = getHatchTexture(bounds, true);
    const hatchRev = new Sprite(hatchTexRev);
    hatchRev.position.set(0, 0);
    hatchRev.tint = color;
    hatchRev.alpha = HATCH_ALPHA;
    hatchRev.mask = mask;
    layer.addChild(hatchRev);
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
