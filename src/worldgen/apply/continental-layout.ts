import { SeededRng } from "../../utils/seeded-rng";
import type { WorldConfig } from "../../data/world-config";
import { createInlandSeaCeiling } from "./inland-sea";
import { createIslandArc, type IslandArc } from "./island-arcs";

interface Landform {
  x: number;
  y: number;
  rx: number;
  ry: number;
  coastPhase?: number;
}

interface ContinentalLayout {
  flipX: boolean;
  flipY: boolean;
  swapAxes?: boolean;
  rotation?: number;
  landforms: Landform[];
  islandArcs?: IslandArc[];
  coastReliefScale: number;
  minimumLandformStrength: number;
  seaCeiling: (x: number, y: number) => number;
}

export function createContinentalLayout(seed: number, layout?: WorldConfig["continentalLayout"]): ContinentalLayout {
  const rng = new SeededRng(seed ^ 0x671295ab);
  if (layout === "oceanic") {
    const continents = [
      { x: rng.range(0.19, 0.26), y: rng.range(0.20, 0.27), rx: rng.range(0.18, 0.21), ry: rng.range(0.14, 0.18) },
      { x: rng.range(0.18, 0.28), y: rng.range(0.73, 0.80), rx: rng.range(0.15, 0.18), ry: rng.range(0.16, 0.19) },
      { x: rng.range(0.75, 0.80), y: rng.range(0.40, 0.55), rx: rng.range(0.15, 0.19), ry: rng.range(0.30, 0.35) },
    ];
    const easternCoast = { x: continents[2]!.x + 0.09, y: continents[2]!.y + 0.21, rx: 0.13, ry: 0.15 };
    const [north, , east] = continents;
    const arcs = new SeededRng(seed ^ 0x3f62ad91);
    const islandArcs = [
      createIslandArc({ x: east!.x - east!.rx * 0.82, y: east!.y + 0.12 },
        { x: arcs.range(0.57, 0.63), y: arcs.range(0.57, 0.69) },
        { x: arcs.range(0.52, 0.56), y: arcs.range(0.77, 0.85) }, arcs),
      createIslandArc({ x: north!.x + 0.10, y: north!.y + 0.015 },
        { x: arcs.range(0.42, 0.48), y: arcs.range(0.23, 0.33) },
        { x: arcs.range(0.48, 0.54), y: arcs.range(0.45, 0.54) }, arcs),
    ];
    const flipX = rng.nextFloat() < 0.5;
    const flipY = rng.nextFloat() < 0.5;

    return {
      flipX,
      flipY,
      landforms: [...continents, easternCoast]
        .map((landform) => ({ ...landform, coastPhase: rng.range(0, 2 * Math.PI) })),
      islandArcs,
      swapAxes: rng.nextFloat() < 0.5,
      rotation: rng.range(-0.16, 0.16),
      // Leave room for the coastline noise between landforms instead of carving a channel through them.
      coastReliefScale: 0.52,
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
