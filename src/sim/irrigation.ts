import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import { isSafeControlledRegion } from "./ai-geography";
import { changeResource } from "./international-trade";
import { isNationActive } from "./nation-active";
import { recordSimulationEvent } from "./simulation-settings";
import { isNationRegionSupplied } from "./supply-assessment";
import { spendTreasury } from "./treasury";
import { getOwnerByMesoId } from "./world-cache";
import type { WorldState } from "./world-state";

export const IRRIGATION_COST = { cash: 18, steel: 12 };
export const IRRIGATION_MULTIPLIER = 1.4;

export function canIrrigate(world: WorldState, id: NationId, district: MesoRegionId): boolean {
  return getOwnerByMesoId(world).get(district) === id && !world.irrigatedDistricts?.has(district) &&
    (world.agriculturalLand?.get(district)?.arableShare ?? 0) >= 0.35;
}

export function installIrrigation(world: WorldState, id: NationId, district: MesoRegionId): boolean {
  const nation = world.nations.find((item) => item.id === id);
  if (world.settings?.foodEnabled === false || !nation || !isNationActive(nation) ||
    !canIrrigate(world, id, district) || !isSafeControlledRegion(world, id, district, { excludeBattles: true }) ||
    !isNationRegionSupplied(world, id, district) || nation.resources.steel < IRRIGATION_COST.steel ||
    !spendTreasury(nation.treasury, "construction", IRRIGATION_COST.cash)) return false;
  changeResource(nation, "steel", -IRRIGATION_COST.steel);
  (world.irrigatedDistricts ??= new Set()).add(district);
  recordSimulationEvent(world, { category: "politics", nationIds: [id],
    message: `${id} completed irrigation in District ${district.replace("meso-", "")}.` });
  return true;
}
