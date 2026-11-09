import type { NationId } from "../worldgen/nation";
import { getAdjacentNationPairs } from "../sim/world-cache";
import type { WorldState } from "../sim/world-state";

const colorProfiles = [
  { saturation: 0.79, lightness: 0.49 },
  { saturation: 0.54, lightness: 0.65 },
  { saturation: 0.72, lightness: 0.57 },
  { saturation: 0.45, lightness: 0.53 },
  { saturation: 0.72, lightness: 0.71 },
];

const colorsByWorld = new WeakMap<WorldState, Map<NationId, number>>();

export function getNationColor(nationId: NationId, world?: WorldState): number {
  if (world) {
    const assigned = colorsByWorld.get(world) ?? new Map<NationId, number>();
    if (assigned.size < world.nations.length) {
      assignNationColors(world, assigned);
      colorsByWorld.set(world, assigned);
    }
    const color = assigned.get(nationId);
    if (color !== undefined) return color;
  }
  const sequence = /^nation-(\d+)$/.exec(nationId);
  const index = sequence ? Number(sequence[1]) : hashString(nationId);
  return paletteColor(index);
}

function paletteColor(index: number): number {
  // Spread consecutive nations across hues and rotate between vivid, soft and light colors.
  const hue = (12 + index * 137.508) % 360;
  const { saturation, lightness } = colorProfiles[index % colorProfiles.length]!;
  return hslToHex(hue, saturation, lightness);
}

function assignNationColors(world: WorldState, assigned: Map<NationId, number>): void {
  const neighbors = new Map(world.nations.map(({ id }) => [id, new Set<NationId>()]));
  for (const [a, b] of getAdjacentNationPairs(world)) {
    neighbors.get(a)?.add(b);
    neighbors.get(b)?.add(a);
  }
  const used = new Set(assigned.values());
  const palette = Array.from({ length: Math.max(60, world.nations.length * 2) }, (_, index) => paletteColor(index));
  const pending = world.nations.filter(({ id }) => !assigned.has(id))
    .sort((a, b) => neighbors.get(b.id)!.size - neighbors.get(a.id)!.size || a.id.localeCompare(b.id));
  for (const { id } of pending) {
    const adjacentColors = [...neighbors.get(id)!].flatMap((neighbor) => {
      const color = assigned.get(neighbor);
      return color === undefined ? [] : [color];
    });
    let best = getNationColor(id), bestScore = -Infinity;
    for (const color of palette) {
      if (used.has(color)) continue;
      const overall = nearestColorDistance(color, used);
      const adjacent = adjacentColors.length ? nearestColorDistance(color, adjacentColors) : overall;
      const score = adjacent + overall * 0.4;
      if (score > bestScore) {
        best = color;
        bestScore = score;
      }
    }
    assigned.set(id, best);
    used.add(best);
  }
}

function nearestColorDistance(color: number, others: Iterable<number>): number {
  let nearest = 3 * 255 ** 2;
  for (const other of others) {
    const red = (color >> 16) - (other >> 16);
    const green = ((color >> 8) & 0xff) - ((other >> 8) & 0xff);
    const blue = (color & 0xff) - (other & 0xff);
    nearest = Math.min(nearest, red ** 2 + green ** 2 + blue ** 2);
  }
  return nearest;
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
