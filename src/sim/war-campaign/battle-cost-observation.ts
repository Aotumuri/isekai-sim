import type { NationId } from "../../worldgen/nation";
import type { UnitState } from "../unit";
import type { WorldState } from "../world-state";
import { createWarCampaignState } from "./state";
import { recordDirectBattleDamage, recordFormationRemoval } from "./battle-costs";

function costs(world: WorldState) {
  if (!world.settings?.warCampaignEnabled) return undefined;
  const state = world.warCampaigns ??= createWarCampaignState();
  return state.battleCosts ??= new Map();
}

export function observeCampaignBattleDamage(world: WorldState, nation: NationId, manpower: number): void {
  if (!(manpower > 0)) return;
  const ledger = costs(world);
  if (ledger) recordDirectBattleDamage(ledger, nation, manpower);
}

export function observeCampaignFormationRemoval(world: WorldState, unit: UnitState): void {
  const ledger = costs(world);
  if (ledger) recordFormationRemoval(ledger, unit);
}
