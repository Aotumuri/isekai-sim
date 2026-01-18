import { Graphics, type Container } from "pixi.js";
import type { MicroRegion } from "../worldgen/micro-region";
import { createTerrainColorScale } from "../terrain-color";

export function drawMicroRegions(layer: Container, microRegions: MicroRegion[]): void {
  layer.removeChildren();

  const graphics = new Graphics();

  graphics.lineStyle(1, 0xffffff, 0);
  // TODO: remove debug outline when terrain styling is finalized.
  // graphics.lineStyle(1, 0x2b2d36, 0.4);
  const getFillColor = createTerrainColorScale(microRegions);

  for (let i = 0; i < microRegions.length; i += 1) {
    const region = microRegions[i];

    const fillColor = getFillColor(region);
    graphics.beginFill(fillColor, 1);

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
