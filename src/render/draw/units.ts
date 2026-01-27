import { Graphics, type Container } from "pixi.js";
import type { UnitState } from "../../sim/unit";
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

export function drawUnits(
  layer: Container,
  units: UnitState[],
  mesoRegions: MesoRegion[],
  interpolationMs = 0,
): void {
  const graphics = ensureGraphics(layer);
  graphics.clear();

  if (units.length === 0 || mesoRegions.length === 0) {
    return;
  }

  const mesoById = getMesoRegionByIdMap(mesoRegions);

  for (const unit of units) {
    const pos = resolveUnitPosition(unit, mesoById, interpolationMs);
    if (!pos) {
      continue;
    }

    const fillColor = getNationColor(unit.nationId);
    graphics.lineStyle(UNIT_STROKE_WIDTH, UNIT_STROKE_COLOR, 1);
    graphics.beginFill(fillColor, 1);
    graphics.drawCircle(pos.x, pos.y, UNIT_RADIUS);
    graphics.endFill();

    if (unit.type === "Tank") {
      const half = UNIT_RADIUS * TANK_MARK_RATIO;
      graphics.lineStyle(TANK_MARK_WIDTH, TANK_MARK_COLOR, 1);
      graphics.moveTo(pos.x - half, pos.y);
      graphics.lineTo(pos.x + half, pos.y);
    }
  }

}

function resolveUnitPosition(
  unit: UnitState,
  mesoById: Map<MesoRegion["id"], MesoRegion>,
  interpolationMs: number,
): { x: number; y: number } | null {
  const region = mesoById.get(unit.regionId);
  if (unit.moveFromId && unit.moveToId) {
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

function ensureGraphics(layer: Container): Graphics {
  const existing = layer.getChildByName("UnitGraphics");
  if (existing && existing instanceof Graphics) {
    return existing;
  }

  clearLayer(layer);
  const graphics = new Graphics();
  graphics.name = "UnitGraphics";
  layer.addChild(graphics);
  return graphics;
}
