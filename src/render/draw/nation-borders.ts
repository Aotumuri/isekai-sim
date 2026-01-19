import { Graphics, type Container } from "pixi.js";
import type { MacroRegion } from "../../worldgen/macro-region";
import type { MicroRegion } from "../../worldgen/micro-region";
import type { Nation } from "../../worldgen/nation";
import { findSharedSegments, type Segment } from "../meso-border-geometry";

const BORDER_WIDTH = 2.2;
const BORDER_ALPHA = 1.0;
const FILL_ALPHA = 0.2;

export function drawNationBorders(
  layer: Container,
  microRegions: MicroRegion[],
  macroRegions: MacroRegion[],
  nations: Nation[],
): void {
  layer.removeChildren();

  if (macroRegions.length === 0 || nations.length === 0) {
    return;
  }

  const mesoToMacroId = new Map<string, MacroRegion["id"]>();
  const nationIdByMacroId = new Map<MacroRegion["id"], Nation["id"]>();
  for (const macro of macroRegions) {
    nationIdByMacroId.set(macro.id, macro.nationId);
    for (const mesoId of macro.mesoRegionIds) {
      mesoToMacroId.set(mesoId, macro.id);
    }
  }

  const colorByNationId = new Map<Nation["id"], number>();
  for (const nation of nations) {
    colorByNationId.set(nation.id, colorFromId(nation.id));
  }

  const regionsByNationId = new Map<Nation["id"], MicroRegion[]>();
  for (const region of microRegions) {
    if (!region.mesoRegionId) {
      continue;
    }
    const macroId = mesoToMacroId.get(region.mesoRegionId);
    if (!macroId) {
      continue;
    }
    const nationId = nationIdByMacroId.get(macroId);
    if (!nationId) {
      continue;
    }
    const list = regionsByNationId.get(nationId);
    if (list) {
      list.push(region);
    } else {
      regionsByNationId.set(nationId, [region]);
    }
  }

  for (const nation of nations) {
    const regions = regionsByNationId.get(nation.id);
    if (!regions || regions.length === 0) {
      continue;
    }

    const fillGraphics = new Graphics();
    fillGraphics.beginFill(colorByNationId.get(nation.id) ?? 0xffffff, FILL_ALPHA);
    for (const region of regions) {
      drawPolygon(fillGraphics, region);
    }
    fillGraphics.endFill();
    layer.addChild(fillGraphics);
  }

  const graphicsByNationId = new Map<Nation["id"], Graphics>();
  const getGraphics = (nationId: Nation["id"]): Graphics => {
    let graphics = graphicsByNationId.get(nationId);
    if (!graphics) {
      graphics = new Graphics();
      graphics.lineStyle({
        width: BORDER_WIDTH,
        color: colorByNationId.get(nationId) ?? 0xffffff,
        alpha: BORDER_ALPHA,
        cap: "round",
        join: "round",
      });
      graphicsByNationId.set(nationId, graphics);
      layer.addChild(graphics);
    }
    return graphics;
  };

  const regionById = new Map<string, MicroRegion>();
  for (const region of microRegions) {
    regionById.set(region.id, region);
  }

  for (const region of microRegions) {
    for (const neighborId of region.neighbors) {
      if (region.id >= neighborId) {
        continue;
      }

      const neighbor = regionById.get(neighborId);
      if (!neighbor) {
        continue;
      }

      const macroA = region.mesoRegionId ? mesoToMacroId.get(region.mesoRegionId) : null;
      const macroB = neighbor.mesoRegionId ? mesoToMacroId.get(neighbor.mesoRegionId) : null;
      if (!macroA && !macroB) {
        continue;
      }
      if (macroA && macroA === macroB) {
        continue;
      }

      const segments = findSharedSegments(region, neighbor);
      if (segments.length === 0) {
        continue;
      }

      const nationA = macroA ? nationIdByMacroId.get(macroA) ?? null : null;
      const nationB = macroB ? nationIdByMacroId.get(macroB) ?? null : null;

      if (nationA) {
        drawSegments(getGraphics(nationA), segments);
      }
      if (nationB && nationB !== nationA) {
        drawSegments(getGraphics(nationB), segments);
      }
    }
  }
}

function drawSegments(graphics: Graphics, segments: Segment[]): void {
  for (const segment of segments) {
    graphics.moveTo(segment.a.x, segment.a.y);
    graphics.lineTo(segment.b.x, segment.b.y);
  }
}

function drawPolygon(graphics: Graphics, region: MicroRegion): void {
  const [firstPoint, ...rest] = region.polygon;
  if (!firstPoint) {
    return;
  }

  graphics.moveTo(firstPoint.x, firstPoint.y);
  for (const point of rest) {
    graphics.lineTo(point.x, point.y);
  }
  graphics.closePath();
}

function colorFromId(id: string): number {
  const hash = hashString(id);
  // Golden angle spreads sequential IDs across the hue wheel.
  const hue = (hash * 137.508) % 360;
  return hslToHex(hue, 0.62, 0.55);
}

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

function hslToHex(hue: number, saturation: number, lightness: number): number {
  const h = ((hue % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const hPrime = h / 60;
  const x = c * (1 - Math.abs((hPrime % 2) - 1));

  let r1 = 0;
  let g1 = 0;
  let b1 = 0;

  if (hPrime >= 0 && hPrime < 1) {
    r1 = c;
    g1 = x;
  } else if (hPrime >= 1 && hPrime < 2) {
    r1 = x;
    g1 = c;
  } else if (hPrime >= 2 && hPrime < 3) {
    g1 = c;
    b1 = x;
  } else if (hPrime >= 3 && hPrime < 4) {
    g1 = x;
    b1 = c;
  } else if (hPrime >= 4 && hPrime < 5) {
    r1 = x;
    b1 = c;
  } else {
    r1 = c;
    b1 = x;
  }

  const m = lightness - c / 2;
  const r = Math.round((r1 + m) * 255);
  const g = Math.round((g1 + m) * 255);
  const b = Math.round((b1 + m) * 255);

  return (r << 16) | (g << 8) | b;
}
