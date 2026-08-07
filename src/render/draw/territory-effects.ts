import { Graphics, Texture, Renderer, Rectangle, type Container } from "pixi.js";
import type { OccupationState } from "../../sim/occupation";
import type { MacroRegion } from "../../worldgen/macro-region";
import type { MesoRegionId } from "../../worldgen/meso-region";
import type { MicroRegion } from "../../worldgen/micro-region";
import type { NationId } from "../../worldgen/nation";
import { clearLayer } from "../clear-layer";
import { getNationColor } from "../nation-color";

const HATCH_SPACING = 12;
const HATCH_WIDTH = 2;
const HATCH_ALPHA = 0.5;

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

type TerritoryEffectEntry = {
  graphics: Graphics;
  nationId: NationId | null;
  crossHatch: boolean;
  hasGeometry: boolean;
};

type TerritoryEffectCache = {
  microRegions: MicroRegion[];
  macroRegions: MacroRegion[];
  width: number;
  height: number;
  microByMesoId: Map<MesoRegionId, MicroRegion[]>;
  macroByMesoId: Map<MesoRegionId, MacroRegion>;
  allMesoIds: MesoRegionId[];
  entriesByMesoId: Map<MesoRegionId, TerritoryEffectEntry>;
};

const hatchTextureCache = new Map<string, Texture>();
const effectCacheByLayer = new WeakMap<Container, TerritoryEffectCache>();

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

  const graphics = new Graphics();
  graphics.lineStyle({ width: HATCH_WIDTH, color: 0xffffff, alpha: 1 });

  const localBounds: Bounds = { minX: 0, minY: 0, maxX: w, maxY: h };
  if (reverse) {
    drawHatchLinesReverse(graphics, localBounds, HATCH_SPACING);
  } else {
    drawHatchLines(graphics, localBounds, HATCH_SPACING);
  }

  if (!sharedRenderer) {
    throw new Error(
      "TerritoryEffects renderer not set. Call setTerritoryEffectsRenderer(renderer) once at init.",
    );
  }
  const texture = sharedRenderer.generateTexture(graphics, {
    region: new Rectangle(0, 0, w, h),
    resolution: 1,
  });
  graphics.destroy(true);

  hatchTextureCache.set(key, texture);
  return texture;
}

export function drawTerritoryEffects(
  layer: Container,
  microRegions: MicroRegion[],
  macroRegions: MacroRegion[],
  occupation: OccupationState,
  width: number,
  height: number,
  dirtyMesoIds?: Iterable<MesoRegionId>,
): void {
  const cache = getTerritoryEffectCache(
    layer,
    microRegions,
    macroRegions,
    width,
    height,
  );
  const candidates = dirtyMesoIds ? [...new Set(dirtyMesoIds)] : cache.allMesoIds;

  const bounds: Bounds = { minX: 0, minY: 0, maxX: width, maxY: height };
  for (const mesoId of candidates) {
    const regions = cache.microByMesoId.get(mesoId);
    if (!regions || regions.length === 0) {
      continue;
    }

    const macro = cache.macroByMesoId.get(mesoId);
    const macroOccupier = macro ? occupation.macroById.get(macro.id) ?? null : null;
    const nationId = macroOccupier ?? occupation.mesoById.get(mesoId) ?? null;
    const crossHatch = macroOccupier !== null;
    let entry = cache.entriesByMesoId.get(mesoId);

    if (!nationId) {
      if (entry?.graphics.visible) {
        entry.graphics.visible = false;
        entry.nationId = null;
      }
      continue;
    }

    if (!entry) {
      const graphics = new Graphics();
      graphics.name = `TerritoryEffect:${mesoId}`;
      layer.addChild(graphics);
      entry = { graphics, nationId: null, crossHatch, hasGeometry: false };
      cache.entriesByMesoId.set(mesoId, entry);
    }

    if (entry.crossHatch !== crossHatch || !entry.hasGeometry) {
      drawMesoEffect(entry.graphics, regions, bounds, crossHatch);
      entry.crossHatch = crossHatch;
      entry.hasGeometry = true;
    }

    if (entry.nationId !== nationId) {
      entry.graphics.tint = getNationColor(nationId);
      entry.nationId = nationId;
    }
    entry.graphics.visible = true;
  }
}

function getTerritoryEffectCache(
  layer: Container,
  microRegions: MicroRegion[],
  macroRegions: MacroRegion[],
  width: number,
  height: number,
): TerritoryEffectCache {
  const cached = effectCacheByLayer.get(layer);
  if (
    cached &&
    cached.microRegions === microRegions &&
    cached.macroRegions === macroRegions &&
    cached.width === width &&
    cached.height === height
  ) {
    return cached;
  }

  clearLayer(layer);
  const microByMesoId = new Map<MesoRegionId, MicroRegion[]>();
  for (const region of microRegions) {
    if (!region.mesoRegionId) {
      continue;
    }
    const existing = microByMesoId.get(region.mesoRegionId);
    if (existing) {
      existing.push(region);
    } else {
      microByMesoId.set(region.mesoRegionId, [region]);
    }
  }

  const macroByMesoId = new Map<MesoRegionId, MacroRegion>();
  const allMesoIds: MesoRegionId[] = [];
  for (const macro of macroRegions) {
    for (const mesoId of macro.mesoRegionIds) {
      macroByMesoId.set(mesoId, macro);
      allMesoIds.push(mesoId);
    }
  }

  const cache: TerritoryEffectCache = {
    microRegions,
    macroRegions,
    width,
    height,
    microByMesoId,
    macroByMesoId,
    allMesoIds,
    entriesByMesoId: new Map(),
  };
  effectCacheByLayer.set(layer, cache);
  return cache;
}

function drawMesoEffect(
  graphics: Graphics,
  regions: MicroRegion[],
  bounds: Bounds,
  crossHatch: boolean,
): void {
  graphics.clear();
  graphics.beginTextureFill({
    texture: getHatchTexture(bounds, false),
    color: 0xffffff,
    alpha: HATCH_ALPHA,
  });
  for (const region of regions) {
    drawPolygon(graphics, region);
  }
  graphics.endFill();

  if (crossHatch) {
    graphics.beginTextureFill({
      texture: getHatchTexture(bounds, true),
      color: 0xffffff,
      alpha: HATCH_ALPHA,
    });
    for (const region of regions) {
      drawPolygon(graphics, region);
    }
    graphics.endFill();
  }
}

function drawHatchLines(graphics: Graphics, bounds: Bounds, spacing: number): void {
  const height = bounds.maxY - bounds.minY;
  const startX = bounds.minX - height;
  const endX = bounds.maxX;
  for (let x = startX; x <= endX; x += spacing) {
    graphics.moveTo(x, bounds.minY);
    graphics.lineTo(x + height, bounds.maxY);
  }
}

function drawHatchLinesReverse(graphics: Graphics, bounds: Bounds, spacing: number): void {
  const height = bounds.maxY - bounds.minY;
  const startX = bounds.minX;
  const endX = bounds.maxX + height;
  for (let x = startX; x <= endX; x += spacing) {
    graphics.moveTo(x, bounds.minY);
    graphics.lineTo(x - height, bounds.maxY);
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
