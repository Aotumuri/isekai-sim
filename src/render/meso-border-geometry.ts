import type { Vec2 } from "../utils/vector";
import type { MicroRegion } from "../worldgen/micro-region";

const POINT_EPSILON = 1e-6;
const LINE_DISTANCE_EPSILON = 1e-3;
const OVERLAP_EPSILON = 1e-3;

export interface Segment {
  a: Vec2;
  b: Vec2;
}

export function findSharedSegments(regionA: MicroRegion, regionB: MicroRegion): Segment[] {
  const segmentsA = buildSegments(regionA.polygon);
  const segmentsB = buildSegments(regionB.polygon);
  const results: Segment[] = [];

  for (const segmentA of segmentsA) {
    for (const segmentB of segmentsB) {
      const overlap = overlapColinearSegments(segmentA, segmentB);
      if (!overlap) {
        continue;
      }
      results.push(overlap);
    }
  }

  return results;
}

function buildSegments(points: Vec2[]): Segment[] {
  if (points.length < 2) {
    return [];
  }

  const segments: Segment[] = [];
  const lastIndex = points.length - 1;
  const isClosed = pointsAlmostEqual(points[0], points[lastIndex]);
  const limit = isClosed ? lastIndex : points.length;

  for (let i = 0; i < limit; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % limit];
    if (pointsAlmostEqual(a, b)) {
      continue;
    }
    segments.push({ a, b });
  }

  return segments;
}

function overlapColinearSegments(segmentA: Segment, segmentB: Segment): Segment | null {
  if (!segmentsAreColinear(segmentA, segmentB)) {
    return null;
  }

  const dx = segmentA.b.x - segmentA.a.x;
  const dy = segmentA.b.y - segmentA.a.y;
  const axis: "x" | "y" = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
  const aMin = Math.min(segmentA.a[axis], segmentA.b[axis]);
  const aMax = Math.max(segmentA.a[axis], segmentA.b[axis]);
  const bMin = Math.min(segmentB.a[axis], segmentB.b[axis]);
  const bMax = Math.max(segmentB.a[axis], segmentB.b[axis]);
  const overlapMin = Math.max(aMin, bMin);
  const overlapMax = Math.min(aMax, bMax);

  if (overlapMax - overlapMin <= OVERLAP_EPSILON) {
    return null;
  }

  const start = pointOnSegmentAtValue(segmentA, axis, overlapMin);
  const end = pointOnSegmentAtValue(segmentA, axis, overlapMax);
  if (pointsAlmostEqual(start, end)) {
    return null;
  }

  return { a: start, b: end };
}

function segmentsAreColinear(segmentA: Segment, segmentB: Segment): boolean {
  const dx1 = segmentA.b.x - segmentA.a.x;
  const dy1 = segmentA.b.y - segmentA.a.y;
  const dx2 = segmentB.b.x - segmentB.a.x;
  const dy2 = segmentB.b.y - segmentB.a.y;
  const len1 = Math.hypot(dx1, dy1);
  const len2 = Math.hypot(dx2, dy2);
  if (len1 === 0 || len2 === 0) {
    return false;
  }

  const cross = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(cross) > LINE_DISTANCE_EPSILON * len1 * len2) {
    return false;
  }

  return pointNearLine(segmentA.a, segmentA.b, segmentB.a, len1);
}

function pointNearLine(a: Vec2, b: Vec2, point: Vec2, length: number): boolean {
  if (length === 0) {
    return false;
  }
  const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
  const distance = Math.abs(cross) / length;
  return distance <= LINE_DISTANCE_EPSILON;
}

function pointOnSegmentAtValue(segment: Segment, axis: "x" | "y", value: number): Vec2 {
  const dx = segment.b.x - segment.a.x;
  const dy = segment.b.y - segment.a.y;

  if (axis === "x") {
    if (dx === 0) {
      return { x: segment.a.x, y: segment.a.y };
    }
    const t = (value - segment.a.x) / dx;
    return { x: value, y: segment.a.y + dy * t };
  }

  if (dy === 0) {
    return { x: segment.a.x, y: segment.a.y };
  }

  const t = (value - segment.a.y) / dy;
  return { x: segment.a.x + dx * t, y: value };
}

function pointsAlmostEqual(a: Vec2, b: Vec2): boolean {
  return Math.abs(a.x - b.x) <= POINT_EPSILON && Math.abs(a.y - b.y) <= POINT_EPSILON;
}
