import { SeededRng } from "../../utils/seeded-rng";
import { createInlandSeaCeiling } from "./inland-sea";

export function createContinentalLayout(seed: number) {
  const rng = new SeededRng(seed ^ 0x671295ab);
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
