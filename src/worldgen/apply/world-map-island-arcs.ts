import type { SeededRng } from "../../utils/seeded-rng";
import { distanceFromShore } from "./landform-shore";
import type { Landform } from "./continental-layout";
import { createIslandArc, type IslandArc, type IslandPeak } from "./island-arcs";

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
      const bend = point(0.19, 0.025);
      const end = point(0.105, rng.range(0.16, 0.25));
      if ([start, bend, end].some((p) =>
        Math.min(p.x, p.y, 1 - p.x, 1 - p.y) < 0.095 ||
        landforms.some((other) => distanceFromShore(other, p) < 0.016))) continue;
      const arc = createIslandArc(start, bend, end, rng);
      const islands = createArcIslands(arc, rng);
      arcs.push({ ...arc, islands });
      break;
    }
  }
  return arcs;
}

function createArcIslands(arc: IslandArc, rng: SeededRng): IslandPeak[] {
  const count = 2 + rng.nextInt(3);
  const main = rng.nextInt(count);
  return Array.from({ length: count }, (_, index) => {
    const at = (index + rng.range(0.3, 0.7)) / count;
    const segment = arc.segments[Math.floor(at * arc.segments.length)]!;
    const length = Math.sqrt(segment.lengthSquared);
    const offset = rng.range(-0.024, 0.024);
    const radius = index === main ? rng.range(0.030, 0.044) : rng.range(0.012, 0.028);
    return {
      x: segment.x - segment.dy / length * offset,
      y: segment.y + segment.dx / length * offset,
      rx: radius,
      ry: radius * rng.range(0.64, 1.24),
      angle: rng.range(0, Math.PI),
      height: rng.range(0.13, 0.23),
    };
  });
}
