import { hasTreaty, proposeTreaty, relationKey } from "./diplomacy";
import { areFactionPartners } from "./factions";
import { FAMINE_THRESHOLD, FOOD_INTERVAL } from "./food-supply";
import { findTradeRoute, hasTradeAgreement, proposeResourceTrade, resourceReserve, sendGrainAid, TRADE_RESOURCE_VALUES } from "./international-trade";
import { isNationActive } from "./nation-active";
import type { NationRuntime } from "./nation-runtime";
import { getManualGovernmentId } from "./player-nation";
import { RATION_POLICIES } from "./ration-policy";
import { getWarDeclarationMode } from "./simulation-settings";
import { isTradeEmbargoed } from "./trade-embargo";
import type { WorldState } from "./world-state";

const surplus = (nation: NationRuntime): number => nation.food ? nation.food.stock - Math.max(nation.food.demand * 5, resourceReserve(nation, "food")) : 0;

function dispatchGrainRelief(world: WorldState, buyer: NationRuntime, exporters: NationRuntime[], needed: number): boolean {
  for (const donor of exporters) {
    if (donor === buyer || !hasTradeAgreement(world, donor.id, buyer.id)) continue;
    const relation = world.diplomacy?.relations.get(relationKey(donor.id, buyer.id));
    if (relation?.crisis) continue;
    const partner = areFactionPartners(world, donor.id, buyer.id) || hasTreaty(world, donor.id, buyer.id, "alliance") ||
      (relation && relation.opinion >= 40 && relation.trust >= 55);
    if (!partner) continue;
    const amount = Math.min(needed, surplus(donor));
    if (amount >= 1 && sendGrainAid(world, donor.id, buyer.id, amount)) return true;
  }
  return false;
}

export function updateFoodTrade(world: WorldState): void {
  if (world.time.slowTick % FOOD_INTERVAL !== 0 || !world.settings?.tradeEnabled ||
    world.settings.foodEnabled === false || getWarDeclarationMode(world) !== "diplomacy") return;
  const player = getManualGovernmentId(world);
  const nations = world.nations.filter((nation) => isNationActive(nation) && nation.food);
  const exporters = nations.filter((nation) => nation.id !== player && surplus(nation) >= 1 &&
    nation.food!.harvest + (nation.food!.levy ?? 0) >= nation.food!.demand)
    .sort((a, b) => surplus(b) - surplus(a) || a.id.localeCompare(b.id));
  const shipments = world.internationalTrade?.deals.filter((deal) => deal.status === "in-transit") ?? [];
  const buyers = nations.filter((nation) => {
    const food = nation.food!;
    return food.demand > 0 && food.stock < food.demand * 5 && food.harvest + (food.levy ?? 0) < food.demand;
  }).sort((a, b) => a.food!.stock / a.food!.demand - b.food!.stock / b.food!.demand || a.id.localeCompare(b.id));

  for (const buyer of buyers) {
    const food = buyer.food!;
    const incoming = shipments.reduce((sum, shipment) =>
      shipment.buyerId === buyer.id && shipment.offeredResource === "food" ? sum + shipment.offeredAmount :
      shipment.sellerId === buyer.id && shipment.requestedResource === "food" ? sum + shipment.requestedAmount : sum, 0);
    const needed = food.demand * 7 - food.stock - incoming;
    const affordable = Math.max(0, ((buyer.treasury?.balance ?? 0) - resourceReserve(buyer, "cash")) / TRADE_RESOURCE_VALUES.food);
    // Cover a famine warning window at the current ration and harvest rates.
    const ration = RATION_POLICIES[food.rationPolicy ?? "normal"];
    const deficit = food.demand * ration - food.harvest - (food.levy ?? 0);
    const emergencyNeed = FAMINE_THRESHOLD * deficit - food.stock - incoming;
    if (emergencyNeed >= 1 && affordable < emergencyNeed && dispatchGrainRelief(world, buyer, exporters, emergencyNeed)) continue;
    if (buyer.id === player) continue;
    if (Math.min(needed, affordable) < 1) continue;
    for (const seller of exporters) {
      if (seller === buyer || !seller.treasury || isTradeEmbargoed(world, buyer.id, seller.id)) continue;
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
