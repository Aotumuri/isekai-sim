import { Delaunay } from "d3-delaunay";
import type { WorldConfig } from "../data/world-config";
import type { Vec2 } from "../utils/vector";
import { clamp } from "../utils/math";
import { SeededRng } from "../utils/seeded-rng";
import { createMicroRegionId, type MicroRegion } from "./micro-region";

export function generateMicroRegions(config: WorldConfig, rng: SeededRng): MicroRegion[] {
  const sites = createJitteredGridSites(config, rng);
  const delaunay = Delaunay.from(sites, (point) => point.x, (point) => point.y);
  const voronoi = delaunay.voronoi([0, 0, config.width, config.height]);
  const ids = sites.map((_, index) => createMicroRegionId(index));

  const regions: MicroRegion[] = [];
  for (let i = 0; i < sites.length; i += 1) {
    const polygon = voronoi.cellPolygon(i);
    if (!polygon || polygon.length < 3) {
      throw new Error(`Voronoi cell missing for site ${i}`);
    }

    const regionPolygon = polygon.map(([x, y]) => ({ x, y }));
    const neighbors: MicroRegion["neighbors"] = [];
    for (const neighborIndex of delaunay.neighbors(i)) {
      neighbors.push(ids[neighborIndex]);
    }

    regions.push({
      id: ids[i],
      site: sites[i],
      polygon: regionPolygon,
      neighbors,
      elevation: 0,
      isSea: false,
      isRiver: false,
    });
  }

  return regions;
}

function createJitteredGridSites(config: WorldConfig, rng: SeededRng): Vec2[] {
  const { width, height, microRegionCount, jitter } = config;
  const columns = Math.max(1, Math.ceil(Math.sqrt((microRegionCount * width) / height)));
  const rows = Math.max(1, Math.ceil(microRegionCount / columns));
  const cellWidth = width / columns;
  const cellHeight = height / rows;
  const jitterX = cellWidth * 0.5 * jitter;
  const jitterY = cellHeight * 0.5 * jitter;

  const sites: Vec2[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < columns; col += 1) {
      if (sites.length >= microRegionCount) {
        return sites;
      }

      const baseX = (col + 0.5) * cellWidth;
      const baseY = (row + 0.5) * cellHeight;
      const x = clamp(baseX + rng.range(-jitterX, jitterX), 0, width);
      const y = clamp(baseY + rng.range(-jitterY, jitterY), 0, height);

      sites.push({ x, y });
    }
  }

  return sites;
}
