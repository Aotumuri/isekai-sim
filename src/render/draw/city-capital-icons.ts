import { Graphics, type Container } from "pixi.js";
import { clearLayer } from "../clear-layer";
import type { MesoRegion } from "../../worldgen/meso-region";

const CAPITAL_STAR_POINTS = 5;
const CAPITAL_STAR_OUTER_RADIUS = 12;
const CAPITAL_STAR_INNER_RADIUS = 5.5;
const CAPITAL_STAR_FILL = 0xffd200;
const CAPITAL_STAR_STROKE = 0x000000;
const CAPITAL_STAR_STROKE_WIDTH = 2;
const CITY_MARKER_SIZE = 12;
const CITY_MARKER_FILL = 0xffffff;
const CITY_MARKER_STROKE = 0x000000;
const CITY_MARKER_STROKE_WIDTH = 1.5;
const PORT_MARKER_SIZE = 12;
const PORT_MARKER_FILL = 0x3aa7ff;
const PORT_MARKER_STROKE = 0x0b2233;
const PORT_MARKER_STROKE_WIDTH = 1.5;
const RESOURCE_ICON_SIZE = 8;
const RESOURCE_STROKE = 0x000000;
const RESOURCE_STROKE_WIDTH = 1.2;
const RESOURCE_OFFSET = { x: 10, y: -10 };
const STEEL_FILL = 0x9aa5b1;
const FUEL_FILL = 0xff8a2b;

export function drawCityCapitalIcons(layer: Container, mesoRegions: MesoRegion[]): void {
  clearLayer(layer);

  if (mesoRegions.length === 0) {
    return;
  }

  const graphics = new Graphics();

  for (const meso of mesoRegions) {
    if (meso.building !== "city") {
      continue;
    }
    graphics.lineStyle(CITY_MARKER_STROKE_WIDTH, CITY_MARKER_STROKE, 1);
    graphics.beginFill(CITY_MARKER_FILL, 1);
    drawSquare(graphics, meso.center, CITY_MARKER_SIZE);
    graphics.endFill();
  }

  for (const meso of mesoRegions) {
    if (meso.building !== "port") {
      continue;
    }
    graphics.lineStyle(PORT_MARKER_STROKE_WIDTH, PORT_MARKER_STROKE, 1);
    graphics.beginFill(PORT_MARKER_FILL, 1);
    drawTriangle(graphics, meso.center, PORT_MARKER_SIZE);
    graphics.endFill();
  }

  for (const meso of mesoRegions) {
    if (meso.building !== "capital") {
      continue;
    }
    graphics.lineStyle(CAPITAL_STAR_STROKE_WIDTH, CAPITAL_STAR_STROKE, 1);
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

  for (const meso of mesoRegions) {
    if (!meso.resource) {
      continue;
    }
    const hasBuilding =
      meso.building === "city" || meso.building === "capital" || meso.building === "port";
    const center = hasBuilding
      ? { x: meso.center.x + RESOURCE_OFFSET.x, y: meso.center.y + RESOURCE_OFFSET.y }
      : meso.center;
    graphics.lineStyle(RESOURCE_STROKE_WIDTH, RESOURCE_STROKE, 1);
    if (meso.resource === "steel") {
      graphics.beginFill(STEEL_FILL, 1);
      drawDiamond(graphics, center, RESOURCE_ICON_SIZE);
      graphics.endFill();
    } else if (meso.resource === "fuel") {
      graphics.beginFill(FUEL_FILL, 1);
      drawCircle(graphics, center, RESOURCE_ICON_SIZE * 0.45);
      graphics.endFill();
    }
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

function drawSquare(
  graphics: Graphics,
  center: { x: number; y: number },
  size: number,
): void {
  const half = size / 2;
  graphics.drawRect(center.x - half, center.y - half, size, size);
}

function drawTriangle(
  graphics: Graphics,
  center: { x: number; y: number },
  size: number,
): void {
  const half = size / 2;
  graphics.moveTo(center.x, center.y - half);
  graphics.lineTo(center.x + half, center.y + half);
  graphics.lineTo(center.x - half, center.y + half);
  graphics.closePath();
}

function drawDiamond(
  graphics: Graphics,
  center: { x: number; y: number },
  size: number,
): void {
  const half = size / 2;
  graphics.moveTo(center.x, center.y - half);
  graphics.lineTo(center.x + half, center.y);
  graphics.lineTo(center.x, center.y + half);
  graphics.lineTo(center.x - half, center.y);
  graphics.closePath();
}

function drawCircle(
  graphics: Graphics,
  center: { x: number; y: number },
  radius: number,
): void {
  graphics.drawCircle(center.x, center.y, radius);
}
