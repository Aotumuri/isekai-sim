import type { MicroRegion } from "../micro-region";

export function applyFluvialRelief(
  regions: MicroRegion[],
  indexById: ReadonlyMap<MicroRegion["id"], number>,
  downstream: Int32Array,
  order: number[],
  runoff: Float64Array,
  seaLevel: number,
): void {
  const cuts = new Float32Array(regions.length);
  const deposits = new Float32Array(regions.length);
  for (const index of order) {
    const region = regions[index]!;
    if (region.isSea) continue;
    const outlet = downstream[index]!;
    const lower = regions[outlet]!;
    const length = Math.hypot(region.site.x - lower.site.x, region.site.y - lower.site.y);
    const slope = Math.max(0, region.elevation - lower.elevation) / Math.max(length, 1);
    // Stream power is approximated by slope times the square root of upstream runoff.
    cuts[index] = Math.min(0.065, 1.1 * Math.sqrt(runoff[index]!) * slope);

    const next = regions[downstream[outlet]!];
    if (!lower.isSea && next && lower.elevation - next.elevation < 0.006) {
      deposits[outlet] = Math.min(0.018, deposits[outlet]! + 0.24 * cuts[index]!);
    }
  }

  for (const index of order) {
    const region = regions[index]!;
    if (region.isSea) continue;
    let incision = cuts[index]!;
    for (const neighbor of region.neighbors) {
      const adjacent = indexById.get(neighbor);
      if (adjacent !== undefined) incision = Math.max(incision, 0.28 * cuts[adjacent]!);
    }
    const aboveSea = region.elevation - seaLevel;
    region.elevation += deposits[index]! - Math.min(0.65 * aboveSea, incision);
  }
}
