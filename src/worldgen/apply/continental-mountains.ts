import { clamp } from "../../utils/math";

export function sampleContinentalMountains(x: number, y: number, phase: number, noise: number): number {
  const along = x * Math.cos(phase) + y * Math.sin(phase);
  const across = y * Math.cos(phase) - x * Math.sin(phase);
  const offset = 0.45 * Math.sin(2 * phase);
  const bend = offset + 0.23 * Math.sin(4 * along + phase);
  const spine = Math.exp(-18 * (across - bend + 0.55 * noise) ** 2 - 1.7 * (along - 0.23) ** 2);
  const branch = Math.exp(-27 * (across + 0.72 * along - 0.25 + noise) ** 2 - 5 * (along + 0.30) ** 2);
  return clamp(Math.max(spine, 0.72 * branch) * (0.85 + noise), 0, 1);
}
