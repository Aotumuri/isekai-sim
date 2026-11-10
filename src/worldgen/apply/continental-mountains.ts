import { clamp } from "../../utils/math";

function sampleContinentalMountains(x: number, y: number, phase: number, noise: number): number {
  const along = x * Math.cos(phase) + y * Math.sin(phase);
  const across = y * Math.cos(phase) - x * Math.sin(phase);
  const offset = 0.45 * Math.sin(2 * phase);
  const bend = offset + 0.23 * Math.sin(4 * along + phase);
  const spine = Math.exp(-18 * (across - bend + 0.55 * noise) ** 2 - 1.7 * (along - 0.23) ** 2);
  const branch = Math.exp(-27 * (across + 0.72 * along - 0.25 + noise) ** 2 - 5 * (along + 0.30) ** 2);
  return clamp(Math.max(spine, 0.72 * branch) * (0.85 + noise), 0, 1);
}

export function sampleContinentalRelief(
  coastline: number,
  x: number,
  y: number,
  phase: number,
  noise: number,
): number {
  if (coastline <= 0) return coastline * 0.72;

  // Low coastal plains rise gradually into broad, asymmetric uplands.
  const inland = clamp((coastline - 0.10) / 0.40, 0, 1);
  const uplift = 0.5 + 0.5 * Math.sin(2.2 * x - 1.7 * y + phase + 1.4 * noise);
  const plateau = clamp((inland + 0.55 * uplift - 0.38) / 0.55, 0, 1);
  const highland = plateau ** 2 * (3 - 2 * plateau);
  const mountains = sampleContinentalMountains(x, y, phase, noise);
  return coastline * (0.17 + 0.28 * highland + 0.52 * inland * mountains);
}
