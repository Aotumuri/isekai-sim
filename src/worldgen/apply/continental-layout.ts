import { SeededRng } from "../../utils/seeded-rng";
import type { WorldConfig } from "../../data/world-config";
import { createInlandSeaCeiling } from "./inland-sea";

export function createContinentalLayout(seed: number, layout?: WorldConfig["continentalLayout"]) {
  const rng = new SeededRng(seed ^ 0x671295ab);
  if (layout === "oceanic") {
    const continents = [
      { x: 0.27, y: 0.29, rx: rng.range(0.22, 0.25), ry: rng.range(0.17, 0.22) },
      { x: 0.22, y: 0.73, rx: rng.range(0.13, 0.17), ry: rng.range(0.14, 0.18) },
      { x: 0.75, y: 0.47, rx: rng.range(0.16, 0.20), ry: rng.range(0.30, 0.35) },
    ].map(({ x, y, rx, ry }) => ({
      x: x + rng.range(-0.025, 0.025),
      y: y + rng.range(-0.025, 0.025),
      rx,
      ry,
    }));
    const easternCoast = { x: continents[2]!.x + 0.09, y: continents[2]!.y + 0.21, rx: 0.13, ry: 0.15 };
    const islands = [
      { x: 0.43, y: 0.64 },
      { x: 0.46, y: 0.73 },
      { x: 0.52, y: 0.84 },
      { x: 0.64, y: 0.15 },
    ].map(({ x, y }) => ({ x, y, rx: rng.range(0.025, 0.045), ry: rng.range(0.03, 0.06) }));
    const straitPhase = rng.range(0, 2 * Math.PI);

    return {
      flipX: rng.nextFloat() < 0.5,
      flipY: rng.nextFloat() < 0.5,
      landforms: [...continents, easternCoast, ...islands],
      seaCeiling: (x: number, y: number) => {
        // Preserve navigable water between continents even where coastal noise creates headlands.
        const meridian = 0.55 + 0.07 * Math.sin(5 * y + straitPhase);
        const westernPassage = 0.51 + 0.15 * x + 0.035 * Math.sin(10 * x - straitPhase);
        const oceanDistance = Math.abs(x - meridian);
        const distance = x < meridian ? Math.min(oceanDistance, Math.abs(y - westernPassage)) : oceanDistance;
        return 10 * (distance - 0.018);
      },
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
    seaCeiling: style === 2
      ? createInlandSeaCeiling(centerY, new SeededRng(seaSeed * 0x100000000))
      : () => Infinity,
  };
}
