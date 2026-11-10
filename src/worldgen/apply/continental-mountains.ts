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

  const along = x * Math.cos(phase) + y * Math.sin(phase);
  const across = y * Math.cos(phase) - x * Math.sin(phase);
  const front = -0.17 + 0.16 * Math.sin(3.5 * along + phase) + 0.30 * noise;
  const plateau = smoothRange(front - 0.09, front + 0.17, across);
  const coastalSlope = smoothRange(0, 0.26, coastline);

  // A broad depression inside the upland, with an irregular rim and a flat floor.
  const basinX = along - 0.19 * Math.sin(phase + 1);
  const basinY = across - (0.38 + 0.06 * Math.cos(phase));
  const basinWidth = 0.32 + 0.06 * Math.sin(phase);
  const basinLength = 0.22 + 0.05 * Math.sin(2 * phase);
  const basinDistance = Math.hypot(
    (basinX + 0.22 * basinY) / basinWidth,
    (basinY + 0.075 * Math.sin(9 * basinX + phase)) / basinLength,
  );
  const basinDepth = smoothRange(-0.35, 0.65, Math.cos(phase));
  const basinRim = 1 - basinDepth * (1 - smoothRange(0.51, 1.28, basinDistance + 0.72 * noise));
  const lowland = 0.043 + 0.012 * noise;
  const upland = 0.25 + 0.035 * noise;
  const mountains = 0.19 * sampleContinentalMountains(x, y, phase, noise);
  const interior = lowland + plateau * basinRim * (upland - lowland + mountains);
  return coastalSlope * interior;
}

function smoothRange(min: number, max: number, value: number): number {
  const t = clamp((value - min) / (max - min), 0, 1);
  return t * t * (3 - 2 * t);
}
