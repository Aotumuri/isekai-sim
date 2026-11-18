import { WORLD_BALANCE } from "../../data/balance";
import type { NationId } from "../../worldgen/nation";
import type { NationResources } from "../nation-runtime";
import type { WorldState } from "../world-state";
import { getUnitEquipmentFulfillment } from "../reorganization";
import { isNationRegionSupplied } from "../supply-assessment";
import { getMesoById } from "../world-cache";
import { getWarCampaign } from "./state";

export interface CampaignRecoveryStock { manpower: number; weapons: number }

/** Earmark only one tick of feasible, already committed recovery. No new income,
 * unit capacity, cost discounts or indefinitely accumulated stock reservations. */
export function getCampaignRecoveryStock(world: WorldState, nationId: NationId): CampaignRecoveryStock {
  const result = { manpower: 0, weapons: 0 };
  if (!getWarCampaign(world, nationId) || !world.reorganization.enabled) return result;
  const units = new Map(world.units.map((unit) => [unit.id, unit]));
  const regions = getMesoById(world);
  const settings = WORLD_BALANCE.war.landFront.reorganization;
  for (const plan of world.reorganization.plans) {
    if (plan.nationId !== nationId || plan.phase !== "reorganizing") continue;
    const unit = units.get(plan.unitId);
    if (!unit || !isNationRegionSupplied(world, nationId, unit.regionId)) continue;
    const building = regions.get(unit.regionId)?.building;
    const multiplier = building === "capital" ? settings.capitalRecoveryMultiplier :
      building === "city" ? settings.cityRecoveryMultiplier : 1;
    const type = WORLD_BALANCE.unit.types[unit.type];
    result.manpower += Math.min(Math.max(0, type.manpower - unit.manpower), settings.manpowerPerSlowTick * multiplier);
    result.weapons += Math.min((1 - getUnitEquipmentFulfillment(unit)) * (type.weaponCost ?? 0), settings.equipmentStockPerSlowTick * multiplier);
  }
  return result;
}

export function campaignProductionResources(resources: NationResources, reserve: CampaignRecoveryStock): NationResources {
  if (reserve.manpower === 0 && reserve.weapons === 0) return resources;
  return { ...resources, manpower: Math.max(0, resources.manpower - reserve.manpower),
    weapons: Math.max(0, resources.weapons - reserve.weapons) };
}
