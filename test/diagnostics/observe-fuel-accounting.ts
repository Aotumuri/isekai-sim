import { WORLD_BALANCE } from "../../src/data/balance";
import type { FuelFlowObservation, FuelUseCategory } from "../../src/sim/instrumentation";
import { getTradeStock } from "../../src/sim/international-trade";
import type { WorldState } from "../../src/sim/world-state";
import { DAYS_PER_SLOW_TICK } from "../../src/sim/time";

const auditedResources = ["steel", "fuel", "weapons", "copper", "rubber", "tungsten"] as const;
type Category = FuelUseCategory | "upkeep";

function totalFuel(world: WorldState): number {
  let total = world.nations.reduce((sum, nation) => sum + getTradeStock(nation, "fuel"), 0);
  for (const deal of world.internationalTrade?.deals ?? []) {
    if (deal.status !== "in-transit") continue;
    if (deal.offeredResource === "fuel") total += deal.offeredAmount;
    if (deal.requestedResource === "fuel") total += deal.requestedAmount;
  }
  return total;
}

export function observeFuelAccounting(world: WorldState) {
  const categories: Partial<Record<Category, ReturnType<typeof emptyCategory>>> = {};
  const nations: Record<string, { observations: number; shortageDays: number; longestShortageDays: number;
    currentShortageDays: number; output: number; requested: number; consumed: number; lastTick: number }> = {};
  const productionErrors = Object.fromEntries(auditedResources.map((resource) => [resource, 0]));
  let output = 0, consumed = 0, inconsistentNationCycles = 0, excessSuppliedFuel = 0;
  let openingFuel = totalFuel(world), previousOutput = 0, previousConsumed = 0;
  const initialFuel = openingFuel;
  let fuelResidual = 0, maxCycleResidual = 0, fuelResidualCycles = 0;

  function emptyCategory() {
    return { observations: 0, shortages: 0, requested: 0, consumed: 0, unmet: 0, stock: 0, transferred: 0 };
  }

  function record(sample: Omit<FuelFlowObservation, "category"> & { category: Category }): void {
    const sums = categories[sample.category] ??= emptyCategory();
    const unmet = Math.max(0, sample.requested - sample.consumed - (sample.transferred ?? 0));
    sums.observations++;
    sums.shortages += Number(unmet > 1e-8);
    sums.requested += sample.requested;
    sums.consumed += sample.consumed;
    sums.unmet += unmet;
    sums.stock += sample.stock;
    sums.transferred += sample.transferred ?? 0;
    consumed += sample.consumed;
  }

  return {
    record,
    afterProduction() {
      const implied = new Map<string, number>();
      for (const unit of world.units) {
        if (!Number.isFinite(unit.moveTicksPerRegion)) continue;
        const rate = Math.max(0, Math.round(WORLD_BALANCE.unit.types[unit.type].fuelUse ?? 0));
        if (rate > 0) implied.set(unit.nationId, (implied.get(unit.nationId) ?? 0) + rate * (unit.design?.fuelUse ?? 1));
      }
      for (const nation of world.nations) {
        const previous = nations[nation.id];
        const flow = nation.resourceFlow;
        const industry = flow.industry;
        if (flow.lastTick !== world.time.slowTick || !industry) {
          if (previous) previous.currentShortageDays = 0;
          continue;
        }
        output += industry.output.fuel;
        for (const resource of auditedResources) {
          const residual = (flow.delta[resource] ?? 0) - (flow.income[resource] ?? 0) + (flow.usage[resource] ?? 0);
          if (Math.abs(residual) > 1e-8) productionErrors[resource]!++;
        }
        const gap = (implied.get(nation.id) ?? 0) - industry.fuelConsumed;
        if (Math.abs(gap) > 1e-8) inconsistentNationCycles++;
        excessSuppliedFuel += Math.max(0, gap);
        if (industry.fuelDemand === 0) {
          if (previous) previous.currentShortageDays = 0;
          continue;
        }
        record({ category: "upkeep", nationId: nation.id, requested: industry.fuelDemand, consumed: industry.fuelConsumed,
          stock: nation.resources.fuel + industry.fuelConsumed - industry.prototypeFuelReserve });
        const totals = nations[nation.id] ??= { observations: 0, shortageDays: 0, longestShortageDays: 0,
          currentShortageDays: 0, output: 0, requested: 0, consumed: 0, lastTick: -1 };
        totals.observations++;
        totals.output += industry.output.fuel;
        totals.requested += industry.fuelDemand;
        totals.consumed += industry.fuelConsumed;
        if (totals.lastTick !== flow.lastTick - 1) totals.currentShortageDays = 0;
        totals.lastTick = flow.lastTick;
        const shortage = industry.fuelDemand - industry.fuelConsumed > 1e-8;
        totals.currentShortageDays = shortage ? totals.currentShortageDays + DAYS_PER_SLOW_TICK : 0;
        if (shortage) totals.shortageDays += DAYS_PER_SLOW_TICK;
        totals.longestShortageDays = Math.max(totals.longestShortageDays, totals.currentShortageDays);
      }
    },
    afterCycle() {
      const closingFuel = totalFuel(world);
      const residual = closingFuel - openingFuel - (output - previousOutput) + (consumed - previousConsumed);
      fuelResidual += residual;
      maxCycleResidual = Math.max(maxCycleResidual, Math.abs(residual));
      if (Math.abs(residual) > 1e-7) fuelResidualCycles++;
      openingFuel = closingFuel;
      previousOutput = output;
      previousConsumed = consumed;
    },
    summarize() {
      return { output, consumed, initialFuel, endingFuel: openingFuel, categories, nations, inconsistentNationCycles,
        excessSuppliedFuel, productionErrors, fuelResidual, maxCycleResidual, fuelResidualCycles };
    },
  };
}
