import { WORLD_BALANCE } from "../data/balance";
import { STRATEGIC_RESOURCES } from "../data/strategic-resources";
import type { NationRuntime } from "./nation-runtime";

export const INDUSTRIAL_RESOURCES = ["steel", "fuel", "weapons", ...STRATEGIC_RESOURCES] as const;
export type IndustrialResource = typeof INDUSTRIAL_RESOURCES[number];

/** All demand rates describe one ten-day production cycle. */
export function weaponReserve(nation: NationRuntime, fielded: number, atWar: boolean): number {
  const infantryCost = WORLD_BALANCE.unit.types.Infantry.weaponCost;
  const aggression = nation.character?.aggression ?? 0.5;
  const replacements = Math.max(atWar ? 3 : 2, Math.sqrt(fielded) * (atWar ? 2 : 0.65));
  const observedDemand = nation.resourceFlow.industry?.weaponDemandAverage ?? 0;
  return Math.ceil(Math.max(infantryCost * (replacements + aggression * 2),
    observedDemand * (atWar ? 12 : 6)));
}

export function steelForResearch(nation: NationRuntime, atWar: boolean, researchEnabled: boolean): number {
  if (!researchEnabled) return 0;
  const demand = nation.resourceFlow.industry?.researchDemand?.steel ?? 0;
  return Math.ceil(6 + Math.max(2, demand * (atWar ? 2 : 6)));
}

/** A small share of local output can build a prototype buffer through a peacetime shortage. */
export function fuelForPrototypes(nation: NationRuntime, stockBeforeOutput: number, output: number): number {
  const previous = nation.resourceFlow.industry;
  const demand = previous?.researchDemand?.fuel ?? 0;
  if (demand === 0) return 0;
  const innovation = nation.character?.innovation ?? 0.5;
  const carried = Math.min(stockBeforeOutput, previous?.prototypeFuelReserve ?? 0);
  return Math.min(2 + demand, carried + output * (0.05 + innovation * 0.1));
}

export interface IndustrialReserve {
  target: number;
  shortage: number;
  exportFloor: number;
}

export function assessIndustrialReserve(nation: NationRuntime, resource: IndustrialResource, atWar: boolean): IndustrialReserve {
  const industry = nation.resourceFlow.industry;
  const research = industry?.researchDemand?.[resource] ?? 0;
  const stock = nation.resources[resource] ?? 0;
  const output = industry?.output[resource] ?? 0;
  const cycles = atWar ? 12 : 8;
  const base = resource === "weapons" ? Math.max(32, industry?.weaponsTarget ?? 0)
    : resource === "steel" ? 36 : resource === "fuel" ? 20 : 6;
  const upkeep = resource === "fuel" ? industry?.fuelDemand ?? 0 :
    resource === "weapons" ? industry?.weaponDemandAverage ?? 0 : 0;
  const netDemand = Math.max(0, upkeep + research - output);
  const target = Math.max(base, upkeep * 2 + netDemand * cycles, base + research * cycles);
  const netOutput = Math.max(0, output - upkeep - research);
  const replenishable = stock + netOutput * 3 >= target;
  // Strategic materials have no independent demand when their systems are absent.
  const hasDemand = resource === "steel" || resource === "weapons" || upkeep + research > 0;
  return { target, exportFloor: target, shortage: hasDemand && !replenishable ? Math.max(0, target - stock) : 0 };
}
