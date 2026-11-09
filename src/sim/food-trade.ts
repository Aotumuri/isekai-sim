import { proposeTreaty, relationKey } from "./diplomacy";
import { FOOD_INTERVAL } from "./food-supply";
import { findTradeRoute, hasTradeAgreement, proposeResourceTrade, resourceReserve, TRADE_RESOURCE_VALUES } from "./international-trade";
import { isNationActive } from "./nation-active";
import type { NationRuntime } from "./nation-runtime";
import { getWarDeclarationMode } from "./simulation-settings";
import { isTradeEmbargoed } from "./trade-embargo";
import type { WorldState } from "./world-state";

const surplus = (nation: NationRuntime): number => nation.food ? nation.food.stock - nation.food.demand * 5 : 0;

export function updateFoodTrade(world: WorldState): void {
  if (world.time.slowTick % FOOD_INTERVAL !== 0 || !world.settings?.tradeEnabled ||
    world.settings.foodEnabled === false || getWarDeclarationMode(world) !== "diplomacy") return;
  const nations = world.nations.filter((nation) => isNationActive(nation) && nation.food && nation.treasury);
  const exporters = nations.filter((nation) => surplus(nation) >= 1 && nation.food!.harvest >= nation.food!.demand)
    .sort((a, b) => surplus(b) - surplus(a) || a.id.localeCompare(b.id));
  const shipments = world.internationalTrade?.deals.filter((deal) => deal.status === "in-transit") ?? [];
  const buyers = nations.filter((nation) => {
    const food = nation.food!;
    return food.demand > 0 && food.stock < food.demand * 5 && food.harvest < food.demand;
  }).sort((a, b) => a.food!.stock / a.food!.demand - b.food!.stock / b.food!.demand || a.id.localeCompare(b.id));

  for (const buyer of buyers) {
    const food = buyer.food!;
    const incoming = shipments.reduce((sum, shipment) =>
      shipment.buyerId === buyer.id && shipment.offeredResource === "food" ? sum + shipment.offeredAmount :
      shipment.sellerId === buyer.id && shipment.requestedResource === "food" ? sum + shipment.requestedAmount : sum, 0);
    const needed = food.demand * 7 - food.stock - incoming;
    const affordable = (buyer.treasury!.balance - resourceReserve(buyer, "cash")) / TRADE_RESOURCE_VALUES.food;
    if (Math.min(needed, affordable) < 1) continue;
    for (const seller of exporters) {
      if (seller === buyer || isTradeEmbargoed(world, buyer.id, seller.id)) continue;
      const amount = Math.min(needed, affordable, surplus(seller));
      if (amount < 1) continue;
      if (!hasTradeAgreement(world, buyer.id, seller.id)) {
        const relation = world.diplomacy?.relations.get(relationKey(buyer.id, seller.id));
        if (!relation || relation.crisis || relation.opinion < 10 || relation.trust < 30 ||
          !findTradeRoute(world, seller.id, buyer.id) || !proposeTreaty(world, buyer.id, seller.id, "trade")) continue;
      }
      if (proposeResourceTrade(world, seller.id, buyer.id, "food", amount, "cash", amount * TRADE_RESOURCE_VALUES.food)) break;
    }
  }
}
