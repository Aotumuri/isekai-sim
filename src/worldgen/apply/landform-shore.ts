import type { Vec2 } from "../../utils/vector";
import type { Landform } from "./continental-layout";

export function distanceFromShore(land: Landform, point: Vec2): number {
  const dx = point.x - land.x, dy = point.y - land.y;
  const angle = Math.atan2(dy, dx) - (land.orientation ?? 0);
  const radius = 1 / Math.hypot(Math.cos(angle) / land.rx, Math.sin(angle) / land.ry);
  return Math.hypot(dx, dy) - radius;
}
