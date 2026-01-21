import { Graphics, type Container } from "pixi.js";
import type { UnitState } from "../../sim/unit";
import type { MesoRegion } from "../../worldgen/meso-region";
import type { Nation } from "../../worldgen/nation";
import { getNationColor } from "../nation-color";

const UNIT_RADIUS = 6;
const UNIT_STROKE_WIDTH = 1.5;
const UNIT_STROKE_COLOR = 0x000000;

export function drawUnits(
  layer: Container,
  units: UnitState[],
  mesoRegions: MesoRegion[],
  nations: Nation[],
): void {
  layer.removeChildren();

  if (units.length === 0 || mesoRegions.length === 0 || nations.length === 0) {
    return;
  }

  const mesoById = new Map<MesoRegion["id"], MesoRegion>();
  for (const region of mesoRegions) {
    mesoById.set(region.id, region);
  }

  const graphics = new Graphics();
  graphics.lineStyle(UNIT_STROKE_WIDTH, UNIT_STROKE_COLOR, 1);

  for (const unit of units) {
    const region = mesoById.get(unit.regionId);
    if (!region) {
      continue;
    }

    const fillColor = getNationColor(unit.nationId);
    graphics.beginFill(fillColor, 1);
    graphics.drawCircle(region.center.x, region.center.y, UNIT_RADIUS);
    graphics.endFill();
  }

  layer.addChild(graphics);
}
