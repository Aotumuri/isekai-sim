import { Container, Graphics, Sprite, type Renderer as PixiRenderer, type Texture } from "pixi.js";
import type { UnitId, UnitState, UnitType } from "../../sim/unit";
import { getMoveMsPerRegion } from "../../sim/movement";
import type { MesoRegion } from "../../worldgen/meso-region";
import { getNationColor } from "../nation-color";
import { clearLayer } from "../clear-layer";
import { getMesoRegionByIdMap } from "../region-index";

const UNIT_RADIUS = 4.5;
const UNIT_STROKE_WIDTH = 1.5;
const UNIT_STROKE_COLOR = 0x000000;
const TANK_MARK_WIDTH = 2;
const TANK_MARK_COLOR = 0x000000;
const TANK_MARK_RATIO = 0.7;
const NAVAL_MARK_WIDTH = 1.5;
const NAVAL_MARK_COLOR = 0x000000;
const NAVAL_MARK_RATIO = 0.6;
const TRANSPORT_MARK_INNER_RATIO = 0.32;

interface UnitSpriteCache {
  container: Container;
  spritesById: Map<UnitId, Sprite>;
  textures: Record<UnitType, Texture>;
}

const spriteCacheByLayer = new WeakMap<Container, UnitSpriteCache>();

export function drawUnits(
  layer: Container,
  renderer: PixiRenderer,
  units: UnitState[],
  mesoRegions: MesoRegion[],
  interpolationMs = 0,
  animateMovement = true,
): void {
  if (units.length === 0 || mesoRegions.length === 0) {
    const cache = spriteCacheByLayer.get(layer);
    if (cache) {
      clearSprites(cache);
    }
    return;
  }

  const cache = getSpriteCache(layer, renderer);
  const mesoById = getMesoRegionByIdMap(mesoRegions);
  const activeUnits = new Set<UnitId>();

  for (const unit of units) {
    const pos = resolveUnitPosition(unit, mesoById, interpolationMs, animateMovement);
    if (!pos) {
      continue;
    }

    activeUnits.add(unit.id);
    let sprite = cache.spritesById.get(unit.id);
    if (!sprite) {
      sprite = new Sprite(cache.textures[unit.type]);
      sprite.anchor.set(0.5);
      cache.container.addChild(sprite);
      cache.spritesById.set(unit.id, sprite);
    } else if (sprite.texture !== cache.textures[unit.type]) {
      sprite.texture = cache.textures[unit.type];
    }
    sprite.tint = getNationColor(unit.nationId);
    sprite.position.set(pos.x, pos.y);
  }

  pruneUnusedSprites(cache, activeUnits);
}

function resolveUnitPosition(
  unit: UnitState,
  mesoById: Map<MesoRegion["id"], MesoRegion>,
  interpolationMs: number,
  animateMovement: boolean,
): { x: number; y: number } | null {
  const region = mesoById.get(unit.regionId);
  if (animateMovement && unit.moveFromId && unit.moveToId) {
    const from = mesoById.get(unit.moveFromId);
    const to = mesoById.get(unit.moveToId);
    if (from && to) {
      const moveMsPerRegion = getMoveMsPerRegion(unit);
      const t = clamp(
        (unit.moveProgressMs + interpolationMs) / moveMsPerRegion,
        0,
        1,
      );
      return {
        x: lerp(from.center.x, to.center.x, t),
        y: lerp(from.center.y, to.center.y, t),
      };
    }
  }

  return region ? { x: region.center.x, y: region.center.y } : null;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getSpriteCache(layer: Container, renderer: PixiRenderer): UnitSpriteCache {
  const existing = spriteCacheByLayer.get(layer);
  if (existing) {
    return existing;
  }

  clearLayer(layer);
  const container = new Container();
  container.name = "UnitSpriteContainer";
  layer.addChild(container);

  const cache: UnitSpriteCache = {
    container,
    spritesById: new Map<UnitId, Sprite>(),
    textures: createUnitTextures(renderer),
  };
  spriteCacheByLayer.set(layer, cache);
  return cache;
}

function clearSprites(cache: UnitSpriteCache): void {
  for (const sprite of cache.spritesById.values()) {
    sprite.destroy({ children: true, texture: false, baseTexture: false });
  }
  cache.spritesById.clear();
  cache.container.removeChildren();
}

function pruneUnusedSprites(cache: UnitSpriteCache, activeUnits: Set<UnitId>): void {
  for (const [unitId, sprite] of cache.spritesById) {
    if (activeUnits.has(unitId)) {
      continue;
    }
    cache.container.removeChild(sprite);
    sprite.destroy({ children: true, texture: false, baseTexture: false });
    cache.spritesById.delete(unitId);
  }
}

function createUnitTextures(renderer: PixiRenderer): Record<UnitType, Texture> {
  return {
    Infantry: createUnitTexture(renderer, "Infantry"),
    Tank: createUnitTexture(renderer, "Tank"),
    TransportShip: createUnitTexture(renderer, "TransportShip"),
    CombatShip: createUnitTexture(renderer, "CombatShip"),
  };
}

function createUnitTexture(renderer: PixiRenderer, unitType: UnitType): Texture {
  const graphics = new Graphics();
  graphics.lineStyle(UNIT_STROKE_WIDTH, UNIT_STROKE_COLOR, 1);
  graphics.beginFill(0xffffff, 1);
  graphics.drawCircle(0, 0, UNIT_RADIUS);
  graphics.endFill();

  if (unitType === "Tank") {
    const half = UNIT_RADIUS * TANK_MARK_RATIO;
    graphics.lineStyle(TANK_MARK_WIDTH, TANK_MARK_COLOR, 1);
    graphics.moveTo(-half, 0);
    graphics.lineTo(half, 0);
  } else if (unitType === "CombatShip") {
    const half = UNIT_RADIUS * NAVAL_MARK_RATIO;
    graphics.lineStyle(NAVAL_MARK_WIDTH, NAVAL_MARK_COLOR, 1);
    graphics.moveTo(-half, half);
    graphics.lineTo(0, -half);
    graphics.lineTo(half, half);
    graphics.closePath();
  } else if (unitType === "TransportShip") {
    const half = UNIT_RADIUS * NAVAL_MARK_RATIO;
    const inner = UNIT_RADIUS * TRANSPORT_MARK_INNER_RATIO;
    graphics.lineStyle(NAVAL_MARK_WIDTH, NAVAL_MARK_COLOR, 1);
    graphics.drawRect(-half, -half, half * 2, half * 2);
    graphics.moveTo(-inner, 0);
    graphics.lineTo(inner, 0);
    graphics.moveTo(0, -inner);
    graphics.lineTo(0, inner);
  }

  const texture = renderer.generateTexture(graphics);
  graphics.destroy();
  return texture;
}
