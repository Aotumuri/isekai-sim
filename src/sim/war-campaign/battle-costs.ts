import type { NationId } from "../../worldgen/nation";
import type { UnitState } from "../unit";
import { WORLD_BALANCE } from "../../data/balance";

/** Removed formations are unavailable force, not a count of people killed.
 * Equipment is a replacement equivalent, never a resource-stock mutation. */
export interface CampaignBattleCost {
  directManpowerDamage: number;
  removedManpower: number;
  removedWeaponEquivalent: number;
  formationsRemoved: number;
}
export type CampaignBattleCosts = Map<NationId, CampaignBattleCost>;

function costFor(costs: CampaignBattleCosts, nation: NationId): CampaignBattleCost {
  let cost = costs.get(nation);
  if (!cost) {
    cost = { directManpowerDamage: 0, removedManpower: 0, removedWeaponEquivalent: 0, formationsRemoved: 0 };
    costs.set(nation, cost);
  }
  return cost;
}

export function recordDirectBattleDamage(costs: CampaignBattleCosts, nation: NationId, manpower: number): void {
  if (Number.isFinite(manpower) && manpower > 0) costFor(costs, nation).directManpowerDamage += manpower;
}

/** Call once when the engine removes a root unit, after its direct damage has
 * been recorded. Its remaining manpower and any embarked cargo disappear too. */
export function recordFormationRemoval(costs: CampaignBattleCosts, unit: UnitState, seen = new Set<string>()): void {
  if (seen.has(unit.id)) return;
  seen.add(unit.id);
  const cost = costFor(costs, unit.nationId);
  cost.removedManpower += Math.max(0, unit.manpower);
  cost.formationsRemoved++;
  const fill = unit.equipment.length ? unit.equipment.reduce((sum, slot) => sum + slot.fill, 0) / unit.equipment.length : 1;
  cost.removedWeaponEquivalent += (WORLD_BALANCE.unit.types[unit.type].weaponCost ?? 0) * Math.max(0, Math.min(1, fill));
  for (const cargo of unit.cargoUnits) recordFormationRemoval(costs, cargo, seen);
}

export function unavailableManpower(cost: CampaignBattleCost | undefined): number {
  return cost ? cost.directManpowerDamage + cost.removedManpower : 0;
}
