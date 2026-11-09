import { sampleCoastRelief } from "./coast-relief";
import { createContinentalLayout } from "./continental-layout";
import { sampleIslandArc } from "./island-arcs";
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
  const layout = createContinentalLayout(config.seed, config.continentalLayout);
  const islandArcs = layout.islandArcs ?? [];
  const cosine = Math.cos(layout.rotation ?? 0), sine = Math.sin(layout.rotation ?? 0);

  for (const region of regions) {
    const u = region.site.x / config.width;
    const v = region.site.y / config.height;
    const horizontal = layout.swapAxes ? v : u;
    const vertical = layout.swapAxes ? u : v;
    let x = layout.flipX ? 1 - horizontal : horizontal;
    let y = layout.flipY ? 1 - vertical : vertical;
    if (layout.rotation) {
      const localX = x - 0.5, localY = y - 0.5;
      x = localX * cosine - localY * sine + 0.5;
      y = localX * sine + localY * cosine + 0.5;
    }
    let interior = -Infinity;
    for (const continent of layout.landforms) {
      const dx = (x - continent.x) / continent.rx;
      const dy = (y - continent.y) / continent.ry;
      let distance = Math.hypot(dx, dy);
      if (continent.coastPhase !== undefined) {
        const angle = Math.atan2(dy, dx), phase = continent.coastPhase;
        // The outline itself forms bays and peninsulas before finer coastline noise is added.
        const shape = 0.24 * Math.cos(3 * angle + phase) +
          0.15 * Math.sin(5 * angle - 2 * phase) + 0.08 * Math.cos(8 * angle + phase);
        // Favor deep bays over outward growth so nearby continents stay separated.
        const radius = 1 + shape * (0.72 - shape);
        distance /= radius;
      }
      const strength = clamp(continent.rx / 0.20, layout.minimumLandformStrength, 1);
      interior = Math.max(interior, (1 - distance) * strength);
    }
    // Mountain belts bend across the interior. Coastal shelves stay low.
    const belt = Math.sin(17 * x + 10 * y + 1.4 * Math.sin(13 * y + beltBend) + beltOffset);
    const ridges = Math.exp(-8 * belt ** 2);
    const hills = Math.sin(34 * x + hillX) * Math.sin(39 * y + hillY);
    const rim = Math.min(u, 1 - u, v, 1 - v);
    const edgeFade = Math.max(0, 1 - rim / 0.12) ** 2;
    // Fade the coastal displacement inland so the mountain belts keep their relief.
    const coastalWeight = clamp(1 - interior / 0.30, 0, 1);
    const coastalNoise = sampleCoastRelief(x, y, config.seed);
    let coastline = interior + coastalWeight * layout.coastReliefScale * coastalNoise;
    for (const arc of islandArcs) {
      coastline = Math.max(coastline, sampleIslandArc(arc, x, y) + 0.24 * coastalNoise);
    }
    coastline -= edgeFade;
    const relief = Math.min(coastline, layout.seaCeiling(x, y)) * (0.40 + 0.56 * ridges + 0.14 * hills);
    region.elevation = clamp(config.elevationSeaLevel + relief, config.elevationRange.min, config.elevationRange.max);
  }
}
