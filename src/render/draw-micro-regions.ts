import { Graphics, type Container } from "pixi.js";
import type { MicroRegion } from "../worldgen/micro-region";

const SEA_COLOR = 0xc4c4e0;
const LAND_LOW_COLOR = 0xf1f1f1;
const LAND_HIGH_COLOR = 0xc4c4af;

export function drawMicroRegions(layer: Container, microRegions: MicroRegion[]): void {
  layer.removeChildren();

  const graphics = new Graphics();
  
  graphics.lineStyle(1, 0xffffff, 0);
  // TODO: remove debug outline when terrain styling is finalized.
  // graphics.lineStyle(1, 0x2b2d36, 0.4);

  let landMin = Infinity;
  let landMax = -Infinity;
  for (const region of microRegions) {
    if (!region.isSea) {
      landMin = Math.min(landMin, region.elevation);
      landMax = Math.max(landMax, region.elevation);
    }
  }

  if (landMin === Infinity || landMax === -Infinity) {
    landMin = 0;
    landMax = 1;
  }
  const landRange = landMax - landMin;

  for (let i = 0; i < microRegions.length; i += 1) {
    const region = microRegions[i];

    const fillColor = region.isSea
      ? SEA_COLOR
      : mixColor(
          LAND_LOW_COLOR,
          LAND_HIGH_COLOR,
          landRange === 0 ? 1 : (region.elevation - landMin) / landRange,
        );
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

function mixColor(colorA: number, colorB: number, t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  const rA = (colorA >> 16) & 0xff;
  const gA = (colorA >> 8) & 0xff;
  const bA = colorA & 0xff;
  const rB = (colorB >> 16) & 0xff;
  const gB = (colorB >> 8) & 0xff;
  const bB = colorB & 0xff;

  const r = Math.round(rA + (rB - rA) * clamped);
  const g = Math.round(gA + (gB - gA) * clamped);
  const b = Math.round(bA + (bB - bA) * clamped);

  return (r << 16) | (g << 8) | b;
}
