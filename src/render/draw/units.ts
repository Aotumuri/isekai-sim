import { Graphics, type Container } from "pixi.js";
import type { UnitState } from "../../sim/unit";
import { MOVE_MS_PER_REGION } from "../../sim/movement";
import type { MesoRegion } from "../../worldgen/meso-region";
import { getNationColor } from "../nation-color";

const UNIT_RADIUS = 6;
const UNIT_STROKE_WIDTH = 1.5;
const UNIT_STROKE_COLOR = 0x000000;

export function drawUnits(
  layer: Container,
  units: UnitState[],
  mesoRegions: MesoRegion[],
  interpolationMs = 0,
): void {
  layer.removeChildren();

  if (units.length === 0 || mesoRegions.length === 0) {
    return;
  }

  const mesoById = new Map<MesoRegion["id"], MesoRegion>();
  for (const region of mesoRegions) {
    mesoById.set(region.id, region);
  }

  const graphics = new Graphics();
  graphics.lineStyle(UNIT_STROKE_WIDTH, UNIT_STROKE_COLOR, 1);

  for (const unit of units) {
    const pos = resolveUnitPosition(unit, mesoById, interpolationMs);
    if (!pos) {
      continue;
    }

    const fillColor = getNationColor(unit.nationId);
    graphics.beginFill(fillColor, 1);
    graphics.drawCircle(pos.x, pos.y, UNIT_RADIUS);
    graphics.endFill();
  }

  layer.addChild(graphics);
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
      const t = clamp(
        (unit.moveProgressMs + interpolationMs) / MOVE_MS_PER_REGION,
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
