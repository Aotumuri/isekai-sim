// Interpolate a seeded lattice so nearby cells share the same headlands.
// Successively smaller displacements break up the coast at several scales.
export function sampleCoastRelief(x: number, y: number, seed: number): number {
  return 0.32 * sampleLattice(x * 7, y * 5, seed)
    + 0.15 * sampleLattice(x * 18, y * 11, seed ^ 0x54b71c23)
    + 0.075 * sampleLattice(x * 42, y * 26, seed ^ 0x239ace6b)
    + 0.028 * sampleLattice(x * 97, y * 60, seed ^ 0x693f541d);
}

function sampleLattice(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const tx = smoothstep(x - ix);
  const ty = smoothstep(y - iy);
  const top = mix(latticeHeight(ix, iy, seed), latticeHeight(ix + 1, iy, seed), tx);
  const bottom = mix(latticeHeight(ix, iy + 1, seed), latticeHeight(ix + 1, iy + 1, seed), tx);
  return mix(top, bottom, ty);
}

function latticeHeight(x: number, y: number, seed: number): number {
  let hash = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ seed;
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d);
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b);
  return ((hash ^ (hash >>> 16)) >>> 0) / 0x80000000 - 1;
}

function smoothstep(value: number): number {
  return value * value * (3 - 2 * value);
}

function mix(a: number, b: number, weight: number): number {
  return a + (b - a) * weight;
}
