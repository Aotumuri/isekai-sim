import type { SeededRng } from "../utils/seeded-rng";
import type { MacroRegion } from "../worldgen/macro-region";
import type { MesoRegion } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import type { WarState } from "./war-state";
import { declareWar } from "./war-state";

export function addTestWar(
  wars: WarState[],
  mesoRegions: MesoRegion[],
  macroRegions: MacroRegion[],
  rng: SeededRng,
  startedAtFastTick: number,
): void {
  void mesoRegions;
  void rng;

  const nationIds = collectNationIds(macroRegions);
  if (nationIds.length < 2) {
    console.info("[War] Not enough nations found for test war.");
    return;
  }

  let warCount = 0;
  for (let i = 0; i < nationIds.length; i += 1) {
    for (let j = i + 1; j < nationIds.length; j += 1) {
      const war = declareWar(
        wars,
        nationIds[i],
        nationIds[j],
        startedAtFastTick,
        true,
      );
      if (war) {
        warCount += 1;
      }
    }
  }
  console.info(`[War] Test: declared ${warCount} wars @${startedAtFastTick}`);
}

function collectNationIds(macroRegions: MacroRegion[]): NationId[] {
  const ids = new Set<NationId>();
  for (const macro of macroRegions) {
    ids.add(macro.nationId);
  }
  return [...ids];
}
