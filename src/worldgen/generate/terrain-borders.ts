import type { WorldConfig } from "../../data/world-config";
import { clamp } from "../../utils/math";
import { SeededRng } from "../../utils/seeded-rng";
import { sampleCoastRelief } from "../apply/coast-relief";
import type { MesoRegion } from "../meso-region";
import type { MicroRegion } from "../micro-region";

interface Arrival {
  district: number;
  owner: number;
  cost: number;
}

interface Crossing {
  district: number;
  cost: number;
  dx: number;
  dy: number;
  bend: number;
}

export function growTerrainBorders(
  regions: readonly MesoRegion[],
  cells: readonly MicroRegion[],
  capitals: readonly number[],
  neighbors: readonly number[][],
  config: WorldConfig,
): { ownerByIndex: number[]; distanceByIndex: number[]; capitalIndices: readonly number[] } {
  const terrain = collectDistrictHeights(regions, cells);
  const landCount = regions.filter(({ type }) => type !== "sea").length;
  const span = Math.sqrt(config.width * config.height / Math.max(1, landCount * 2));
  const seed = config.seed ^ 0x6813ad5b;
  const crossings = regions.map((region, index) => {
    const rivers = new Set(region.neighbors.filter(({ hasRiver }) => hasRiver).map(({ id }) => id));
    return neighbors[index]!.map((next) => {
      const neighbor = regions[next]!;
      const dx = neighbor.center.x - region.center.x, dy = neighbor.center.y - region.center.y;
      const distance = Math.hypot(dx, dy);
      const ridge = Math.max(0, Math.min(terrain[index]!, terrain[next]!) - config.elevationSeaLevel - 0.15);
      const slope = Math.abs(terrain[index]! - terrain[next]!);
      const river = rivers.has(neighbor.id);
      const x = (neighbor.center.x + region.center.x) / (2 * config.width);
      const y = (neighbor.center.y + region.center.y) / (2 * config.height);
      const relief = sampleCoastRelief(x * 1.5, y * 1.5, seed);
      const cost = clamp(distance / span, 0.45, 2.3) * (1 + relief * 1.2) + 7 * ridge + 4 * slope + (river ? 3.8 : 0);
      return { district: next, cost, bend: 18 * x + 15 * y, dx: distance ? dx / distance : 0, dy: distance ? dy / distance : 0 };
    });
  });
  const rng = new SeededRng(seed);
  const longBorderSpan = Math.min(config.width, config.height) * 0.0275;
  const initial = expandFromCapitals(capitals, crossings, new SeededRng(seed), false);
  let best = initial;
  let bestCapitals = capitals;
  // Alternate seats stay near their original capital and inside its initial territory.
  const seats = capitals.map((capital, owner) => {
    const nearby = new Set([capital]);
    const firstRing = crossings[capital]!.filter(({ district }) => initial.ownerByIndex[district] === owner);
    for (const { district } of [...firstRing, ...firstRing.flatMap(({ district }) => crossings[district]!)]) {
      if (initial.ownerByIndex[district] === owner && regions[district]!.type === "land") nearby.add(district);
    }
    return [...nearby];
  });
  let bestScore = borderRegularity(regions, crossings, best.ownerByIndex, longBorderSpan);
  for (let attempt = 1; attempt < 18 && bestScore > 0; attempt++) {
    const candidateCapitals = attempt <= 3 ? capitals : seats.map((options) => options[rng.nextInt(options.length)]!);
    const candidate = expandFromCapitals(candidateCapitals, crossings, rng, true);
    const score = borderRegularity(regions, crossings, candidate.ownerByIndex, longBorderSpan);
    if (score < bestScore) {
      best = candidate;
      bestCapitals = candidateCapitals;
      bestScore = score;
    }
  }
  return { ...best, capitalIndices: bestCapitals };
}

function expandFromCapitals(capitals: readonly number[], crossings: Crossing[][], rng: SeededRng, curved: boolean) {
  const ownerByIndex = crossings.map(() => -1);
  const distanceByIndex = crossings.map(() => Infinity);
  const growth = capitals.map(() => {
    const direction = rng.range(0, Math.PI);
    return { direction, pace: rng.range(0.75, 1.26) };
  });
  const queue: Arrival[] = [];
  capitals.forEach((district, owner) => {
    distanceByIndex[district] = 0;
    pushArrival(queue, { district, owner, cost: 0 });
  });
  while (queue.length) {
    const { district, owner, cost } = popArrival(queue);
    if (ownerByIndex[district] !== -1 || cost !== distanceByIndex[district]) continue;
    ownerByIndex[district] = owner;
    const { direction, pace } = growth[owner]!;
    // Every claim extends already-held land. No capital acquires districts across a rival or the sea.
    for (const edge of crossings[district]!) {
      if (ownerByIndex[edge.district] !== -1) continue;
      const bearing = curved ? direction + 0.9 * Math.sin(edge.bend + 2 * direction) : direction;
      const along = edge.dx * Math.cos(bearing) + edge.dy * Math.sin(bearing);
      const directionalCost = curved ? 1.65 - 0.85 * along ** 2 : 1.5 - 0.65 * along ** 2;
      const arrival = cost + edge.cost * pace * directionalCost;
      if (arrival >= distanceByIndex[edge.district]!) continue;
      distanceByIndex[edge.district] = arrival;
      pushArrival(queue, { district: edge.district, owner, cost: arrival });
    }
  }
  return { ownerByIndex, distanceByIndex };
}

function borderRegularity(
  regions: readonly MesoRegion[], crossings: Crossing[][], owners: readonly number[], longBorderSpan: number,
): number {
  const borders = new Map<string, { x: number; y: number }[]>();
  for (const [index, edges] of crossings.entries()) {
    const a = owners[index]!;
    if (a < 0) continue;
    for (const { district } of edges) {
      const b = owners[district]!;
      if (district <= index || b < 0 || a === b) continue;
      const first = regions[index]!.center, second = regions[district]!.center;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const points = borders.get(key) ?? [];
      points.push({ x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 });
      borders.set(key, points);
    }
  }
  let score = 0;
  for (const points of borders.values()) {
    if (points.length < 6) continue;
    const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
    const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
    let xx = 0, xy = 0, yy = 0;
    for (const point of points) {
      const x = point.x - meanX, y = point.y - meanY;
      xx += x * x;
      xy += x * y;
      yy += y * y;
    }
    // The covariance axes estimate how long and narrow the shared frontier is at district scale.
    const spread = Math.hypot(xx - yy, 2 * xy);
    const length = Math.sqrt((xx + yy + spread) / (2 * points.length));
    const width = Math.sqrt(Math.max(0, xx + yy - spread) / (2 * points.length));
    if (length > longBorderSpan && width < length * 0.18) {
      score += 2 + (length / longBorderSpan) * (1 - width / (length * 0.18));
    }
  }
  return score;
}

function collectDistrictHeights(regions: readonly MesoRegion[], cells: readonly MicroRegion[]): number[] {
  const totals = new Map<MesoRegion["id"], { sum: number; count: number }>();
  for (const cell of cells) {
    if (cell.isSea || !cell.mesoRegionId) continue;
    const total = totals.get(cell.mesoRegionId);
    if (total) {
      total.sum += cell.elevation;
      total.count++;
    } else totals.set(cell.mesoRegionId, { sum: cell.elevation, count: 1 });
  }
  return regions.map(({ id }) => {
    const total = totals.get(id);
    return total ? total.sum / total.count : 0;
  });
}

function pushArrival(queue: Arrival[], arrival: Arrival): void {
  let index = queue.length;
  queue.push(arrival);
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (queue[parent]!.cost <= arrival.cost) break;
    queue[index] = queue[parent]!;
    index = parent;
  }
  queue[index] = arrival;
}

function popArrival(queue: Arrival[]): Arrival {
  const first = queue[0]!;
  const last = queue.pop()!;
  if (!queue.length) return first;
  let index = 0;
  while (index * 2 + 1 < queue.length) {
    const left = index * 2 + 1, right = left + 1;
    const child = right < queue.length && queue[right]!.cost < queue[left]!.cost ? right : left;
    if (last.cost <= queue[child]!.cost) break;
    queue[index] = queue[child]!;
    index = child;
  }
  queue[index] = last;
  return first;
}
