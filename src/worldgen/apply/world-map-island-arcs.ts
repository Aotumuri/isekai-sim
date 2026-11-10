import type { SeededRng } from "../../utils/seeded-rng";
import { distanceFromShore } from "./landform-shore";
import type { Landform } from "./continental-layout";
import { createIslandArc, type IslandArc } from "./island-arcs";

export function createWorldMapIslandArcs(
  landforms: Landform[],
  rng: SeededRng,
): IslandArc[] {
  const arcs: IslandArc[] = [];
  for (const land of landforms.slice(0, 3)) {
    for (let attempt = 0; attempt < 24; attempt++) {
      const angle = rng.range(0, 2 * Math.PI);
      const dx = Math.cos(angle), dy = Math.sin(angle);
      const direction = rng.nextFloat() < 0.5 ? -1 : 1;
      const radius = -distanceFromShore(land, { x: land.x + dx, y: land.y + dy }) + 1;
      const point = (offset: number, sideways: number) => ({
        x: land.x + (radius + offset) * dx - sideways * dy * direction,
        y: land.y + (radius + offset) * dy + sideways * dx * direction,
      });
      const start = point(0.025, -0.04);
      const bend = point(0.15, 0);
      const end = point(0.105, rng.range(0.16, 0.25));
      if ([start, bend, end].some((p) =>
        Math.min(p.x, p.y, 1 - p.x, 1 - p.y) < 0.095 ||
        landforms.some((other) => distanceFromShore(other, p) < 0.016))) continue;
      arcs.push(createIslandArc(start, bend, end, rng));
      break;
    }
  }
  return arcs;
}
