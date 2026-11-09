import type { SeededRng } from "../../utils/seeded-rng";

export function createInlandSeaCeiling(centerY: number, rng: SeededRng) {
  const bend = rng.range(0, Math.PI * 2);
  const detail = rng.range(0, Math.PI * 2);
  const direction = rng.nextFloat() < 0.5 ? -1 : 1;
  const westernY = centerY - direction * rng.range(0.045, 0.075);
  const easternY = centerY + direction * rng.range(0.025, 0.060);
  const bayX = rng.range(0.39, 0.57);
  const islandX = rng.range(0.40, 0.45);

  return (x: number, y: number): number => {
    // The basins meet at an oblique angle. Distorting their shores at two
    // scales creates headlands and smaller coves without relying on cell jitter.
    const shoreX = x + 0.020 * Math.sin(31 * y + bend) + 0.007 * Math.sin(94 * y + detail);
    const shoreY = y + 0.020 * Math.sin(30 * x + detail) + 0.008 * Math.sin(81 * x + bend);
    const west = Math.hypot((shoreX - 0.42) / 0.15, (shoreY - westernY) / 0.087) - 1;
    const east = Math.hypot((shoreX - 0.61) / 0.13, (shoreY - easternY) / 0.086) - 1;
    const bay = Math.hypot((shoreX - bayX) / 0.055, (shoreY - (westernY - direction * 0.065)) / 0.095) - 1;
    const middle = Math.hypot((x - 0.515) / 0.102, (y - centerY) / 0.047) - 1;
    const island = 1 - Math.hypot((shoreX - islandX) / 0.033, (shoreY - westernY) / 0.035);

    // Keep a continuous channel from the eastern basin to open water. The
    // banks converge at a headland and widen again toward the mouth.
    const channelY = easternY + direction * 0.065 * (x - 0.64)
      + 0.020 * Math.sin(19 * (x - 0.64)) + 0.007 * Math.sin(43 * x + bend);
    const width = 0.019 + 0.009 * Math.sin(24 * x + detail) ** 2;
    const channel = Math.max(0.61 - x, (Math.abs(y - channelY) - width) * 8);
    const basins = Math.min(west, east, bay, middle);
    return Math.min(Math.max(basins, island), channel);
  };
}
