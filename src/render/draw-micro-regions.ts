import { Graphics, type Container } from "pixi.js";
import type { MicroRegion } from "../worldgen/micro-region";

const SEA_COLOR = 0xf1f1ff;

export function drawMicroRegions(layer: Container, microRegions: MicroRegion[]): void {
  layer.removeChildren();

  const graphics = new Graphics();

  for (let i = 0; i < microRegions.length; i += 1) {
    const region = microRegions[i];

    graphics.lineStyle(0, 0x000000, 0);
    graphics.beginFill(SEA_COLOR, 1);

    const [firstPoint, ...rest] = region.polygon;
    if (!firstPoint) {
      continue;
    }

    graphics.moveTo(firstPoint.x, firstPoint.y);
    for (const point of rest) {
      graphics.lineTo(point.x, point.y);
    }
    graphics.closePath();
    graphics.endFill();
  }

  layer.addChild(graphics);
}
