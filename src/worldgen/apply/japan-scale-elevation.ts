import type { WorldConfig } from "../../data/world-config";
import { clamp } from "../../utils/math";
import { SeededRng } from "../../utils/seeded-rng";
import type { MicroRegion } from "../micro-region";
import { sampleCoastRelief } from "./coast-relief";

export function applyJapanScaleElevation(regions: MicroRegion[], config: WorldConfig): void {
  const sample = createIslandArcRelief(config.seed);
  for (const region of regions) {
    const x = region.site.x / config.width;
    const y = region.site.y / config.height;
    region.elevation = clamp(config.elevationSeaLevel + sample(x, y),
      config.elevationRange.min, config.elevationRange.max);
  }
}

export function createIslandArcRelief(seed: number): (x: number, y: number) => number {
  const rng = new SeededRng(seed ^ 0x86b5419d);
  const bend = rng.range(0.12, 0.26);
  const tilt = rng.range(0.20, 0.48);
  const mirror = rng.nextFloat() < 0.5 ? -1 : 1;
  const arcOffset = rng.range(-0.09, 0.07);
  const phase = rng.range(0, Math.PI * 2);
  const islands = [
    { center: rng.range(0.14, 0.22), length: rng.range(0.065, 0.105), width: rng.range(0.067, 0.13), offset: rng.range(-0.045, 0.065) },
    { center: rng.range(0.45, 0.53), length: rng.range(0.18, 0.25), width: rng.range(0.10, 0.18), offset: 0 },
    { center: rng.range(0.83, 0.88), length: rng.range(0.06, 0.09), width: rng.range(0.07, 0.14), offset: rng.range(-0.075, 0.04) },
    { center: rng.range(0.60, 0.69), length: rng.range(0.047, 0.076), width: rng.range(0.034, 0.060), offset: rng.range(0.12, 0.18) },
    { center: rng.range(0.11, 0.17), length: 0.028, width: 0.044, offset: 0.12 },
  ];

  return (u, v) => {
    const y = 0.5 + mirror * (v - 0.5);
    const x = mirror < 0 ? 1 - u : u;
    const axis = 0.41 + arcOffset + tilt * (x - 0.5) + bend * Math.sin(Math.PI * x) + 0.032 * Math.sin(10 * x + phase);
    const across = y - axis;
    const coast = sampleCoastRelief(x * 1.4, y * 1.5, seed);
    let crust = -Infinity;
    for (const island of islands) {
      const width = island.width * (1 + 0.20 * Math.sin(25 * x + phase));
      const length = (x - island.center) / island.length;
      const flank = (across - island.offset) / width;
      crust = Math.max(crust, 1 - Math.hypot(length, flank));
    }
    const margin = Math.min(u, v, 1 - u, 1 - v);
    const edgeFade = Math.max(0, 1 - margin / 0.07) ** 2;
    const shore = crust + 0.80 * coast - edgeFade;
    if (shore <= 0) return shore * 0.22;

    // Compression raises a continuous but uneven backbone, with smaller
    // ranges on the far side of the arc and broad low ground on the flanks.
    const fault = across + 0.027 * Math.sin(19 * x + phase) + 0.09 * coast;
    const backbone = Math.exp(-190 * (fault + 0.03) ** 2);
    const backArc = Math.exp(-410 * (fault - 0.085) ** 2);
    const relief = sampleCoastRelief(x * 2.9, y * 3.2, seed ^ 0x9c8342b1);
    const uplift = 0.55 + 0.32 * Math.sin(17 * x + phase) ** 2 + 0.30 * relief;
    return (1 - Math.exp(-4.2 * shore)) * (0.044 + uplift * (0.32 * backbone + 0.13 * backArc) + 0.11 * relief);
  };
}
