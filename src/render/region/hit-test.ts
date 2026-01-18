import type { Vec2 } from "../../utils/vector";
import type { MicroRegion } from "../../worldgen/micro-region";

export interface RegionBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function buildRegionBounds(microRegions: MicroRegion[]): RegionBounds[] {
  return microRegions.map((region) => computeBounds(region.polygon));
}

export function findRegion(
  point: Vec2,
  microRegions: MicroRegion[],
  boundsByIndex: RegionBounds[],
): MicroRegion | null {
  for (let i = 0; i < microRegions.length; i += 1) {
    const bounds = boundsByIndex[i];
    if (
      point.x < bounds.minX ||
      point.x > bounds.maxX ||
      point.y < bounds.minY ||
      point.y > bounds.maxY
    ) {
      continue;
    }

    if (pointInPolygon(point, microRegions[i].polygon)) {
      return microRegions[i];
    }
  }

  return null;
}

function computeBounds(polygon: Vec2[]): RegionBounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of polygon) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }

  return { minX, minY, maxX, maxY };
}

function pointInPolygon(point: Vec2, polygon: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersect =
      (yi > point.y) !== (yj > point.y) &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersect) {
      inside = !inside;
    }
  }
  return inside;
}
