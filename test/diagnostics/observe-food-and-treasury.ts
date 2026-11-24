import type { SimulationCounterName } from "../../src/sim/instrumentation";
import type { WorldState } from "../../src/sim/world-state";

function snapshot(world: WorldState) {
  let food = 0, cash = 0, spent = 0, taxes = 0;
  for (const nation of world.nations) {
    food += nation.food?.stock ?? 0;
    if (!nation.treasury) continue;
    cash += nation.treasury.balance;
    for (const amount of Object.values(nation.treasury.spent)) spent += amount;
    if (world.lastTaxCollectionTick === world.time.slowTick) taxes += nation.treasury.lastRevenue;
  }
  for (const deal of world.internationalTrade?.deals ?? []) {
    if (deal.status !== "in-transit") continue;
    if (deal.offeredResource === "food") food += deal.offeredAmount;
    if (deal.requestedResource === "food") food += deal.requestedAmount;
    if (deal.offeredResource === "cash") cash += deal.offeredAmount;
    if (deal.requestedResource === "cash") cash += deal.requestedAmount;
  }
  return { food, cash, spent, taxes };
}

export function observeFoodAndTreasury(world: WorldState, counters: Partial<Record<SimulationCounterName, number>>) {
  const initial = snapshot(world);
  let opening = initial, previousFoodFlow = 0, previousTreasuryOpened = 0;
  let maxFoodError = 0, maxCashError = 0, foodErrorCycles = 0, cashErrorCycles = 0, taxes = 0;
  return {
    afterCycle() {
      const closing = snapshot(world);
      const foodFlow = (counters["economy.foodHarvest"] ?? 0) - (counters["economy.foodConsumption"] ?? 0) -
        (counters["economy.foodStorageOverflow"] ?? 0);
      const treasuryOpened = counters["economy.treasuryOpened"] ?? 0;
      const foodError = Math.abs(closing.food - opening.food - (foodFlow - previousFoodFlow));
      const cashError = Math.abs(closing.cash - opening.cash - closing.taxes - (treasuryOpened - previousTreasuryOpened) +
        (closing.spent - opening.spent));
      maxFoodError = Math.max(maxFoodError, foodError);
      maxCashError = Math.max(maxCashError, cashError);
      foodErrorCycles += Number(foodError > 1e-7);
      cashErrorCycles += Number(cashError > 1e-7);
      taxes += closing.taxes;
      opening = closing;
      previousFoodFlow = foodFlow;
      previousTreasuryOpened = treasuryOpened;
    },
    summarize() {
      return { initial, closing: opening, taxes, maxFoodError, maxCashError, foodErrorCycles, cashErrorCycles };
    },
  };
}
