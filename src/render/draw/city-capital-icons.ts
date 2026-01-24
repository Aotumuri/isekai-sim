import { Graphics, type Container } from "pixi.js";
import type { MesoRegion } from "../../worldgen/meso-region";

const CAPITAL_STAR_POINTS = 5;
const CAPITAL_STAR_OUTER_RADIUS = 12;
const CAPITAL_STAR_INNER_RADIUS = 5.5;
const CAPITAL_STAR_FILL = 0xffd200;
const CAPITAL_STAR_STROKE = 0x000000;
const CAPITAL_STAR_STROKE_WIDTH = 2;

export function drawCityCapitalIcons(layer: Container, mesoRegions: MesoRegion[]): void {
  layer.removeChildren();

  if (mesoRegions.length === 0) {
    return;
  }

  const graphics = new Graphics();
  graphics.lineStyle(CAPITAL_STAR_STROKE_WIDTH, CAPITAL_STAR_STROKE, 1);

  for (const meso of mesoRegions) {
    if (meso.building !== "capital") {
      continue;
    }
    graphics.beginFill(CAPITAL_STAR_FILL, 1);
    drawStar(
      graphics,
      meso.center,
      CAPITAL_STAR_POINTS,
      CAPITAL_STAR_OUTER_RADIUS,
      CAPITAL_STAR_INNER_RADIUS,
    );
    graphics.endFill();
  }

  layer.addChild(graphics);
}

function drawStar(
  graphics: Graphics,
  center: { x: number; y: number },
  points: number,
  outerRadius: number,
  innerRadius: number,
): void {
  const step = Math.PI / points;
  const startAngle = -Math.PI / 2;

  graphics.moveTo(
    center.x + Math.cos(startAngle) * outerRadius,
    center.y + Math.sin(startAngle) * outerRadius,
  );

  for (let i = 1; i < points * 2; i += 1) {
    const radius = i % 2 === 0 ? outerRadius : innerRadius;
    const angle = startAngle + step * i;
    graphics.lineTo(
      center.x + Math.cos(angle) * radius,
      center.y + Math.sin(angle) * radius,
    );
  }

  graphics.closePath();
}
