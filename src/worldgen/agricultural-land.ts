import type { MesoRegion, MesoRegionId } from "./meso-region";
import type { MicroRegion } from "./micro-region";
import { clamp } from "../utils/math";

export interface AgriculturalLand {
  arableShare: number;
  harvest: number;
}

/** Estimate workable land from height, local relief and access to river water. */
export function mapAgriculturalLand(districts: readonly MesoRegion[], cells: readonly MicroRegion[],
  seaLevel: number, height: number): Map<MesoRegionId, AgriculturalLand> {
  const byId = new Map(cells.map((cell) => [cell.id, cell]));
  const agriculture = new Map<MesoRegionId, AgriculturalLand>();
  for (const district of districts) {
    if (district.type === "sea") continue;
    let land = 0, arable = 0, yieldScore = 0;
    for (const id of district.microRegionIds) {
      const cell = byId.get(id);
      if (!cell || cell.isSea) continue;
      land++;
      if (cell.isRiver || cell.elevation - seaLevel >= 0.55) continue;
      let relief = 0, watered = false;
      for (const neighborId of cell.neighbors) {
        const neighbor = byId.get(neighborId);
        if (!neighbor || neighbor.isSea) continue;
        relief = Math.max(relief, Math.abs(neighbor.elevation - cell.elevation));
        watered ||= neighbor.isRiver;
      }
      if (relief >= 0.14) continue;
      arable++;
      const altitude = clamp(1 - Math.max(0, cell.elevation - seaLevel - 0.12) / 0.45, 0.15, 1);
      const latitude = Math.abs(cell.site.y / Math.max(1, height) - 0.5);
      yieldScore += altitude * (1 - latitude * 0.6) * (1 - relief * 3) * (watered ? 1.35 : 1);
    }
    agriculture.set(district.id, { arableShare: arable / Math.max(1, land), harvest: 1.65 * yieldScore / Math.max(1, land) });
  }
  return agriculture;
}
