import { sampleCoastRelief } from "./coast-relief";
import { createContinentalLayout } from "./continental-layout";
import type { WorldConfig } from "../../data/world-config";
import { clamp } from "../../utils/math";
import type { SeededRng } from "../../utils/seeded-rng";
import type { MicroRegion } from "../micro-region";

export function applyContinentalElevation(
  regions: MicroRegion[],
  config: WorldConfig,
  rng: SeededRng,
): void {
  // Keep the mountain and hill phases stable when changing the coastline.
  const [, , , , beltBend, beltOffset, hillX, hillY] =
    Array.from({ length: 8 }, () => rng.range(0, 2 * Math.PI));
  const layout = createContinentalLayout(config.seed);

  for (const region of regions) {
    const u = region.site.x / config.width;
    const v = region.site.y / config.height;
    const x = layout.flipX ? 1 - u : u;
    const y = layout.flipY ? 1 - v : v;
    let interior = -Infinity;
    for (const continent of layout.landforms) {
      const distance = Math.hypot((x - continent.x) / continent.rx, (y - continent.y) / continent.ry);
      interior = Math.max(interior, (1 - distance) * Math.min(1, continent.rx / 0.20));
    }
    // Mountain belts bend across the interior. Coastal shelves stay low.
    const belt = Math.sin(17 * x + 10 * y + 1.4 * Math.sin(13 * y + beltBend) + beltOffset);
    const ridges = Math.exp(-8 * belt ** 2);
    const hills = Math.sin(34 * x + hillX) * Math.sin(39 * y + hillY);
    const rim = Math.min(x, 1 - x, y, 1 - y);
    const edgeFade = Math.max(0, 1 - rim / 0.12) ** 2;
    // Fade the coastal displacement inland so the mountain belts keep their relief.
    const coastalWeight = clamp(1 - interior / 0.30, 0, 1);
    const coastline = interior + coastalWeight * sampleCoastRelief(x, y, config.seed) - edgeFade;
    const relief = Math.min(coastline, layout.seaCeiling(x, y)) * (0.40 + 0.56 * ridges + 0.14 * hills);
    region.elevation = clamp(config.elevationSeaLevel + relief, config.elevationRange.min, config.elevationRange.max);
  }
}
