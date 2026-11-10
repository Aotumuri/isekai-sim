import { clamp } from "../../utils/math";
import { sampleCoastRelief } from "./coast-relief";

export function sampleContinentalRelief(
  coastline: number,
  x: number,
  y: number,
  phase: number,
  noise: number,
  seed = 0,
): number {
  if (coastline <= 0) return coastline * 0.72;

  const along = x * Math.cos(phase) + y * Math.sin(phase);
  const across = y * Math.cos(phase) - x * Math.sin(phase);
  const deformation = sampleCoastRelief(along * 0.32 + phase, across * 0.28, seed ^ 0x74ac6d31);
  // A collision zone thickens the crust over a broad belt, with a narrower
  // mountain front on one side. The rest of the continent rises much less.
  const boundary = 0.21 * Math.sin(phase + 1.8 * along) + 0.55 * deformation;
  const offset = across - boundary;
  const convergence = clamp(0.61 + 0.27 * Math.sin(2.6 * along + phase) + deformation, 0.15, 1);
  const belt = Math.exp(-8 * (offset - 0.18) ** 2);
  const front = Math.exp(-59 * (offset + 0.12 + 0.24 * noise) ** 2);
  const ridge = front * (0.64 + 0.36 * Math.sin(6 * along + 8 * deformation) ** 2);
  const stableCrust = 0.055 + 0.04 * deformation;
  const uplift = convergence * (0.24 * belt + 0.26 * ridge);
  const shelf = 1 - Math.exp(-9 * coastline);
  return shelf * (stableCrust + uplift + 0.06 * noise);
}
