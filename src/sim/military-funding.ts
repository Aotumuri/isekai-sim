import { isNationActive } from "./nation-active";
import { spendTreasury, TAX_COLLECTION_INTERVAL, type NationalTreasury } from "./treasury";
import type { WorldState } from "./world-state";

export const militaryFundingCost = (treasury: NationalTreasury): number => Math.ceil(3 + treasury.population * 0.07);

export function updateMilitaryFunding(world: WorldState): void {
  if (world.time.slowTick % TAX_COLLECTION_INTERVAL !== 0) return;
  for (const nation of world.nations) {
    const treasury = nation.treasury;
    if (!treasury?.militaryFunding || !isNationActive(nation) ||
      (treasury.militaryFundedUntil ?? 0) > world.time.slowTick) continue;
    if (spendTreasury(treasury, "military", militaryFundingCost(treasury))) {
      treasury.militaryFundedUntil = world.time.slowTick + TAX_COLLECTION_INTERVAL;
    }
  }
}

export function isMilitaryFunded(world: WorldState, treasury?: NationalTreasury): boolean {
  return !!treasury?.militaryFunding && (treasury.militaryFundedUntil ?? 0) > world.time.slowTick;
}
