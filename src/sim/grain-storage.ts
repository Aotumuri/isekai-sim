import type { NationId } from "../worldgen/nation";
import { changeResource } from "./international-trade";
import { isNationActive } from "./nation-active";
import { recordSimulationEvent } from "./simulation-settings";
import { isNationRegionSupplied } from "./supply-assessment";
import { spendTreasury } from "./treasury";
import type { WorldState } from "./world-state";

export const GRAIN_STORAGE_MAX = 3;
export const grainStorageCost = (level: number) => ({ cash: 28 + level * 18, steel: 20 + level * 10 });

export function expandGrainStorage(world: WorldState, id: NationId): boolean {
  const nation = world.nations.find((item) => item.id === id);
  if (world.settings?.foodEnabled === false || !nation?.food || !isNationActive(nation) ||
    !isNationRegionSupplied(world, id, nation.capitalMesoId)) return false;
  const level = nation.food.storageLevel ?? 0;
  const cost = grainStorageCost(level);
  if (level >= GRAIN_STORAGE_MAX || nation.resources.steel < cost.steel ||
    !spendTreasury(nation.treasury, "construction", cost.cash)) return false;
  changeResource(nation, "steel", -cost.steel);
  nation.food.storageLevel = level + 1;
  recordSimulationEvent(world, { category: "politics", nationIds: [id],
    message: `${id} expanded its strategic grain reserve capacity.` });
  return true;
}
