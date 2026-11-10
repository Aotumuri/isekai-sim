import type { SeededRng } from "../../utils/seeded-rng";
import type { Vec2 } from "../../utils/vector";
import type { ContinentalLayout, Landform } from "./continental-layout";

export function createWorldMapLayout(rng: SeededRng): ContinentalLayout {
  const landforms: Landform[] = [];
  const radii = [
    rng.range(0.24, 0.30),
    rng.range(0.17, 0.23),
    rng.range(0.12, 0.18),
    ...Array.from({ length: rng.nextInt(3) + 1 }, () => rng.range(0.055, 0.115)),
  ];
  for (const radius of radii) {
    const shape = {
      rx: radius * rng.range(0.85, 1.06),
      ry: radius * rng.range(0.65, 1.18),
      orientation: rng.range(0, Math.PI),
      coastPhase: rng.range(0, 2 * Math.PI),
    };
    landforms.push(placeLandform(shape, landforms, rng));
  }
  return {
    flipX: false,
    flipY: false,
    landforms,
    coastReliefScale: 0.64,
    minimumLandformStrength: 0.42,
    seaCeiling: () => Infinity,
  };
}

function placeLandform(shape: Omit<Landform, "x" | "y">, existing: Landform[], rng: SeededRng): Landform {
  const margin = 0.07 + Math.min(shape.rx, shape.ry) * 0.55;
  const sample = () => ({ ...shape, x: rng.range(margin, 1 - margin), y: rng.range(margin, 1 - margin) });
  let best = sample();
  // Once there is an ocean gap, keep the sampled position. This allows both
  // nearby pairs of continents and isolated ones without a fixed grid.
  const clearance = (candidate: Landform) => Math.min(...existing.map((land) =>
    distanceFromShore(land, candidate) + distanceFromShore(candidate, land) -
    Math.hypot(land.x - candidate.x, land.y - candidate.y)));
  let bestGap = clearance(best);
  for (let attempt = 0; attempt < 24 && bestGap < 0.038; attempt++) {
    const candidate = sample();
    const gap = clearance(candidate);
    if (gap > bestGap) {
      best = candidate;
      bestGap = gap;
    }
  }
  return best;
}

export function distanceFromShore(land: Landform, point: Vec2): number {
  const dx = point.x - land.x, dy = point.y - land.y;
  const angle = Math.atan2(dy, dx) - (land.orientation ?? 0);
  const radius = 1 / Math.hypot(Math.cos(angle) / land.rx, Math.sin(angle) / land.ry);
  return Math.hypot(dx, dy) - radius;
}
