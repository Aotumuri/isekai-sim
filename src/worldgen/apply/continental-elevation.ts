import { sampleContinentalRelief } from "./continental-mountains";
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
  const worldMap = config.continentalLayout === "world-map";
  const islandArcs = layout.islandArcs ?? [];
  const landforms = layout.landforms.map((landform) => ({
    ...landform,
    cosine: Math.cos(landform.orientation ?? 0),
    sine: Math.sin(landform.orientation ?? 0),
  }));
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
    // Regional crustal deformation shifts coastlines and relief together.
    const warpedX = worldMap ? x + 0.16 * sampleCoastRelief(x * 0.63, y * 0.63, config.seed ^ 0x4e630a5d) : x;
    const warpedY = worldMap ? y + 0.16 * sampleCoastRelief(x * 0.63, y * 0.63, config.seed ^ 0x1c3786e5) : y;
    let interior = -Infinity;
    let inlandX = 0, inlandY = 0, mountainPhase = 0;
    for (const continent of landforms) {
      const offsetX = warpedX - continent.x, offsetY = warpedY - continent.y;
      const dx = (offsetX * continent.cosine + offsetY * continent.sine) / continent.rx;
      const dy = (offsetY * continent.cosine - offsetX * continent.sine) / continent.ry;
      let distance = Math.hypot(dx, dy);
      if (continent.coastPhase !== undefined) {
        const angle = Math.atan2(dy, dx), phase = continent.coastPhase;
        // The outline itself forms bays and peninsulas before finer coastline noise is added.
        const shape = worldMap
          ? 0.20 * Math.sin(2 * angle - phase) + 0.14 * Math.cos(3 * angle + phase)
            + 0.10 * Math.sin(5 * angle + 2 * phase)
          : 0.24 * Math.cos(3 * angle + phase) +
            0.15 * Math.sin(5 * angle - 2 * phase) + 0.08 * Math.cos(8 * angle + phase);
        // Favor deep bays over outward growth so nearby continents stay separated.
        const radius = 1 + shape * (0.72 - shape);
        distance /= radius;
      }
      const strength = clamp(continent.rx / 0.20, layout.minimumLandformStrength, 1);
      const landHeight = (1 - distance) * strength;
      if (landHeight > interior) {
        interior = landHeight;
        inlandX = dx;
        inlandY = dy;
        mountainPhase = continent.coastPhase ?? 0;
      }
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
    let ridge = -Infinity;
    for (const arc of islandArcs) {
      ridge = Math.max(ridge, sampleIslandArc(arc, warpedX, warpedY) + 0.24 * coastalNoise);
    }
    if (ridge - edgeFade > -0.22) region.seaRidge = clamp(1 + (ridge - edgeFade) / 0.22, 0, 1);
    const coastline = Math.max(interior + coastalWeight * layout.coastReliefScale * coastalNoise, ridge) - edgeFade;
    const relief = worldMap
      ? sampleContinentalRelief(coastline, inlandX, inlandY, mountainPhase, coastalNoise, config.seed)
      : Math.min(coastline, layout.seaCeiling(x, y)) * (0.40 + 0.56 * ridges + 0.14 * hills);
    region.elevation = clamp(config.elevationSeaLevel + relief, config.elevationRange.min, config.elevationRange.max);
  }
}
