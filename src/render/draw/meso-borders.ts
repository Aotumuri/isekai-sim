import { Graphics, type Container } from "pixi.js";
import { clearLayer } from "../clear-layer";
import { getMicroRegionByIdMap } from "../region-index";
import type { MicroRegion } from "../worldgen/micro-region";
import { findSharedSegments } from "../meso-border-geometry";

const MESO_BORDER_COLOR = 0x000000;
const MESO_BORDER_WIDTH = 1.5;

export function drawMesoBorders(layer: Container, microRegions: MicroRegion[]): void {
  clearLayer(layer);

  const graphics = new Graphics();
  graphics.lineStyle({
    width: MESO_BORDER_WIDTH,
    color: MESO_BORDER_COLOR,
    alpha: 0.9,
    cap: "round",
    join: "round",
  });

  const regionById = getMicroRegionByIdMap(microRegions);

  const seenPairs = new Set<string>();
  for (const region of microRegions) {
    for (const neighborId of region.neighbors) {
      if (region.id >= neighborId) {
        continue;
      }

      const pairKey = `${region.id}|${neighborId}`;
      if (seenPairs.has(pairKey)) {
        continue;
      }
      seenPairs.add(pairKey);

      const neighbor = regionById.get(neighborId);
      if (!neighbor) {
        continue;
      }

      if (!region.mesoRegionId || !neighbor.mesoRegionId) {
        continue;
      }
      if (region.mesoRegionId === neighbor.mesoRegionId) {
        continue;
      }

      const segments = findSharedSegments(region, neighbor);
      for (const segment of segments) {
        graphics.moveTo(segment.a.x, segment.a.y);
        graphics.lineTo(segment.b.x, segment.b.y);
      }
    }
  }

  layer.addChild(graphics);
}
