import { getDomesticUnrest } from "./domestic-unrest";
import { militaryFundingCost } from "./military-funding";
import { isNationActive } from "./nation-active";
import { distributePublicRelief, reliefCost } from "./public-relief";
import { TAX_COLLECTION_INTERVAL } from "./treasury";
import type { WorldState } from "./world-state";

export function updateBudgetPolicies(world: WorldState): void {
  if (world.time.slowTick % TAX_COLLECTION_INTERVAL !== 0) return;
  const belligerents = new Set(world.wars.flatMap((war) => [war.nationAId, war.nationBId]));
  for (const nation of world.nations) {
    const treasury = nation.treasury;
    if (!treasury?.automaticBudget || !isNationActive(nation)) continue;
    const atWar = belligerents.has(nation.id);
    const pressure = getDomesticUnrest(world, nation.id).pressure;
    const militaryCost = militaryFundingCost(treasury);
    const reserve = 20 + militaryCost * 3;
    treasury.taxRate = pressure >= 45 ? 10 : atWar && treasury.balance < reserve ? 25 : 15;
    treasury.militaryFunding = atWar && treasury.balance >= reserve;
    treasury.researchFunding = treasury.balance >= reserve * (atWar ? 3 : 1.5);
    if (pressure >= 55 && treasury.balance >= reserve + reliefCost(treasury)) distributePublicRelief(world, nation.id);
  }
}
