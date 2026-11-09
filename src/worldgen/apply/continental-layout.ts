import { SeededRng } from "../../utils/seeded-rng";
import type { WorldConfig } from "../../data/world-config";
import { createInlandSeaCeiling } from "./inland-sea";

export function createContinentalLayout(seed: number, layout?: WorldConfig["continentalLayout"]) {
  const rng = new SeededRng(seed ^ 0x671295ab);
  if (layout === "oceanic") {
    const continents = [
      { x: 0.23, y: 0.25, rx: rng.range(0.18, 0.21), ry: rng.range(0.14, 0.18) },
      { x: 0.23, y: 0.74, rx: rng.range(0.15, 0.18), ry: rng.range(0.16, 0.19) },
      { x: 0.77, y: 0.47, rx: rng.range(0.15, 0.19), ry: rng.range(0.30, 0.35) },
    ].map(({ x, y, rx, ry }) => ({
      x: x + rng.range(-0.025, 0.025),
      y: y + rng.range(-0.025, 0.025),
      rx,
      ry,
    }));
    const easternCoast = { x: continents[2]!.x + 0.09, y: continents[2]!.y + 0.21, rx: 0.13, ry: 0.15 };
    const islands = [
      { x: 0.45, y: 0.55 },
      { x: 0.49, y: 0.69 },
      { x: 0.52, y: 0.84 },
      { x: 0.53, y: 0.21 },
    ].map(({ x, y }) => ({ x, y, rx: rng.range(0.025, 0.038), ry: rng.range(0.03, 0.055) }));

    return {
      flipX: rng.nextFloat() < 0.5,
      flipY: rng.nextFloat() < 0.5,
      landforms: [...continents, easternCoast, ...islands],
      // Leave room for the coastline noise between landforms instead of carving a channel through them.
      coastReliefScale: 0.65,
      minimumLandformStrength: 0.4,
      seaCeiling: () => Infinity,
    };
  }

  const style = rng.nextInt(3);
  const flipX = rng.nextFloat() < 0.5;
  const flipY = rng.nextFloat() < 0.5;
  const centerY = rng.range(0.46, 0.54);
  const seaSeed = rng.nextFloat();
  const continents = style === 1
    ? [
      { x: 0.25, y: centerY - 0.07, rx: 0.21, ry: 0.33 },
      { x: 0.74, y: centerY + 0.07, rx: 0.20, ry: 0.32 },
      { x: 0.50, y: 0.78, rx: 0.075, ry: 0.10 },
    ]
    : [
      { x: rng.range(0.28, 0.34), y: centerY - 0.06, rx: 0.30, ry: 0.37 },
      { x: rng.range(0.62, 0.69), y: centerY + 0.06, rx: 0.29, ry: 0.36 },
    ];
  const islands = Array.from({ length: 5 }, () => ({
    x: rng.range(0.10, 0.90), y: rng.range(0.12, 0.88),
    rx: rng.range(0.035, 0.085), ry: rng.range(0.045, 0.12),
  }));

  return {
    flipX,
    flipY,
    landforms: [...continents, ...islands],
    coastReliefScale: 1,
    minimumLandformStrength: 0,
    seaCeiling: style === 2
      ? createInlandSeaCeiling(centerY, new SeededRng(seaSeed * 0x100000000))
      : () => Infinity,
  };
}
