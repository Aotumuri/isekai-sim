import type { MicroRegion } from "../worldgen/micro-region";

const SEA_COLOR = 0x24465b;
const RIVER_COLOR = 0x668eb3;
export const TERRAIN_LABELS = { plains: "平原", highlands: "高地", mountains: "山地" };
export const TERRAIN_COLORS = {
  plains: 0x80aa69,
  highlands: 0xb49e6b,
  mountains: 0xeee5d5,
};

export function createTerrainColorScale(
  microRegions: MicroRegion[],
): (region: MicroRegion) => number {
  let landMin = Infinity;
  let landMax = -Infinity;
  for (const region of microRegions) {
    if (!region.isSea && !region.isRiver) {
      landMin = Math.min(landMin, region.elevation);
      landMax = Math.max(landMax, region.elevation);
    }
  }

  if (landMin === Infinity || landMax === -Infinity) {
    landMin = 0;
    landMax = 1;
  }
  const landRange = landMax - landMin;

  return (region: MicroRegion): number => {
    if (region.isRiver) {
      return RIVER_COLOR;
    }
    if (region.isSea) {
      return SEA_COLOR;
    }

    const t = landRange === 0 ? 0 : (region.elevation - landMin) / landRange;
    if (t <= 0.15) return TERRAIN_COLORS.plains;
    if (t < 0.52) return mixColor(TERRAIN_COLORS.plains, TERRAIN_COLORS.highlands, (t - 0.15) / 0.37);
    return mixColor(TERRAIN_COLORS.highlands, TERRAIN_COLORS.mountains, (t - 0.52) / 0.48);
  };
}

function mixColor(colorA: number, colorB: number, t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  const rA = (colorA >> 16) & 0xff;
  const gA = (colorA >> 8) & 0xff;
  const bA = colorA & 0xff;
  const rB = (colorB >> 16) & 0xff;
  const gB = (colorB >> 8) & 0xff;
  const bB = colorB & 0xff;

  const r = Math.round(rA + (rB - rA) * clamped);
  const g = Math.round(gA + (gB - gA) * clamped);
  const b = Math.round(bA + (bB - bA) * clamped);

  return (r << 16) | (g << 8) | b;
}
