import { Graphics } from "pixi.js";
import type { WorldState } from "../sim/world-state";

export const AGRICULTURE_COLORS = [
  { label: "Limited farmland", color: 0xe3bc68, minimum: 0.03 },
  { label: "Workable farmland", color: 0x93cf65, minimum: 0.55 },
  { label: "Productive farmland", color: 0x35a958, minimum: 1.05 },
] as const;

export function createAgricultureOverlay(world: WorldState): Graphics {
  const layer = new Graphics();
  for (let index = 0; index < AGRICULTURE_COLORS.length; index++) {
    const { color, minimum } = AGRICULTURE_COLORS[index]!;
    const maximum = AGRICULTURE_COLORS[index + 1]?.minimum ?? Infinity;
    layer.beginFill(color, 0.58);
    for (const cell of world.microRegions) {
      if (!cell.mesoRegionId || cell.isSea) continue;
      const harvest = world.agriculturalLand?.get(cell.mesoRegionId)?.harvest ?? 0;
      if (harvest < minimum || harvest >= maximum || !cell.polygon.length) continue;
      const [first, ...rest] = cell.polygon;
      layer.moveTo(first!.x, first!.y);
      for (const point of rest) layer.lineTo(point.x, point.y);
      layer.closePath();
    }
    layer.endFill();
  }
  return layer;
}
