import type { UnitState } from "../unit";
import type { WorldState } from "../world-state";
import { getFrontlineCoverage } from "../frontline-coverage";
import { getUnitCombatStrength } from "../unit-strength";
import { getWarCampaign } from "./state";

/** Shared extraction ledger. Existing reserve/recovery eligibility still applies.
 * Rebuilt after allocation or on the next strategic tick; no permanent leases. */
export interface CampaignForceBudget {
  slowTick: number;
  allocationVersion: number;
  remainingByFrontNation: Map<string, number>;
}

export function remainingAfterExtraction(remaining: number, strength: number, floor: number): number | null {
  if (![remaining, strength, floor].every(Number.isFinite) || strength < 0 || floor < 0) return null;
  return remaining - strength + 1e-6 >= floor ? Math.max(0, remaining - strength) : null;
}

export function claimCampaignFrontExtraction(world: WorldState, unit: UnitState, requiredFloor: number): boolean {
  if (!getWarCampaign(world, unit.nationId)) return true;
  if (world.playerNation?.landOrders.has(unit.id)) return false;
  const frontId = world.frontAllocations.frontIdByUnitId.get(unit.id);
  if (!frontId) return true;
  const allocation = world.frontAllocations.allocationsByFrontNation.get(`${frontId}::${unit.nationId}`);
  if (!allocation) return true;
  const state = world.warCampaigns!;
  let budget = state.forceBudget;
  if (!budget || budget.slowTick !== world.time.slowTick || budget.allocationVersion !== world.frontAllocations.version) {
    budget = state.forceBudget = { slowTick: world.time.slowTick,
      allocationVersion: world.frontAllocations.version, remainingByFrontNation: new Map() };
  }
  const key = `${frontId}::${unit.nationId}`;
  const remaining = budget.remainingByFrontNation.get(key) ?? currentFrontStrength(world, allocation.unitIds);
  const coverageFloor = getFrontlineCoverage(world, frontId, unit.nationId)?.minimumRequiredStrength ?? 0;
  const after = remainingAfterExtraction(remaining, getUnitCombatStrength(unit), Math.max(coverageFloor, requiredFloor));
  if (after === null) return false;
  budget.remainingByFrontNation.set(key, after);
  return true;
}

function currentFrontStrength(world: WorldState, unitIds: readonly string[]): number {
  const ids = new Set(unitIds);
  return world.units.reduce((total, unit) => total + (ids.has(unit.id) &&
    !world.retreatPlans.retreatIdByUnitId.has(unit.id) &&
    !world.reorganization.planIdByUnitId.has(unit.id) &&
    !world.strategicReserves.reserveNationByUnitId.has(unit.id) ? getUnitCombatStrength(unit) : 0), 0);
}
