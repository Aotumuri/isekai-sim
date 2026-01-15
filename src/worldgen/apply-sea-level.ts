import type { WorldConfig } from "../data/world-config";
import type { MicroRegion } from "./micro-region";

export function applySeaLevel(microRegions: MicroRegion[], config: WorldConfig): void {
  for (const region of microRegions) {
    if (region.elevation <= config.elevationSeaLevel) {
      region.isSea = true;
      region.elevation = config.elevationSeaLevel;
    } else {
      region.isSea = false;
    }
  }
}
