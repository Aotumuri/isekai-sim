import type { SeededRng } from "../../utils/seeded-rng";
import type { Vec2 } from "../../utils/vector";
import { clamp } from "../../utils/math";

interface RidgeSegment {
  x: number;
  y: number;
  dx: number;
  dy: number;
  lengthSquared: number;
  crest: number;
  rise: number;
}

export interface IslandArc {
  segments: RidgeSegment[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  slope: number;
}

export function createIslandArc(start: Vec2, bend: Vec2, end: Vec2, rng: SeededRng): IslandArc {
  const peaks = Array.from({ length: rng.nextInt(2) + 3 }, (_, index) => ({
    at: 0.19 + index * 0.21 + rng.range(-0.055, 0.055),
    width: rng.range(0.075, 0.14),
    height: rng.range(0.22, 0.34),
  }));
  const points = Array.from({ length: 25 }, (_, index) => {
    const t = index / 24, rest = 1 - t;
    const crest = Math.max(...peaks.map((peak) => {
      const distance = (t - peak.at) / peak.width;
      return peak.height * Math.exp(-distance * distance);
    }));
    return {
      x: rest ** 2 * start.x + 2 * rest * t * bend.x + t ** 2 * end.x,
      y: rest ** 2 * start.y + 2 * rest * t * bend.y + t ** 2 * end.y,
      crest: crest - 0.15,
    };
  });
  const margin = 0.09;
  return {
    segments: points.slice(0, -1).map((point, index) => {
      const next = points[index + 1]!;
      const dx = next.x - point.x, dy = next.y - point.y;
      return { x: point.x, y: point.y, dx, dy, lengthSquared: dx * dx + dy * dy,
        crest: point.crest, rise: next.crest - point.crest };
    }),
    minX: Math.min(...points.map(({ x }) => x)) - margin,
    maxX: Math.max(...points.map(({ x }) => x)) + margin,
    minY: Math.min(...points.map(({ y }) => y)) - margin,
    maxY: Math.max(...points.map(({ y }) => y)) + margin,
    slope: rng.range(4.0, 5.6),
  };
}

export function sampleIslandArc(arc: IslandArc, x: number, y: number): number {
  if (x < arc.minX || x > arc.maxX || y < arc.minY || y > arc.maxY) return -Infinity;
  let distanceSquared = Infinity;
  let crest = 0;
  for (const segment of arc.segments) {
    const dx = x - segment.x, dy = y - segment.y;
    const t = clamp((dx * segment.dx + dy * segment.dy) / segment.lengthSquared, 0, 1);
    const distance = (dx - t * segment.dx) ** 2 + (dy - t * segment.dy) ** 2;
    if (distance >= distanceSquared) continue;
    distanceSquared = distance;
    crest = segment.crest + t * segment.rise;
  }
  return crest - Math.sqrt(distanceSquared) * arc.slope;
}
