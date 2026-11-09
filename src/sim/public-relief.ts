import type { NationId } from "../worldgen/nation";
import { getDomesticUnrest } from "./domestic-unrest";
import { isNationActive } from "./nation-active";
import { recordSimulationEvent } from "./simulation-settings";
import { spendTreasury, type NationalTreasury } from "./treasury";
import type { WorldState } from "./world-state";

export const RELIEF_COOLDOWN = 60;
export const reliefCost = (treasury: NationalTreasury): number => Math.ceil(8 + treasury.population * 0.25);

export function distributePublicRelief(world: WorldState, id: NationId): boolean {
  const nation = world.nations.find((item) => item.id === id);
  const treasury = nation?.treasury;
  if (!nation || !treasury || !isNationActive(nation) || (treasury.nextReliefTick ?? 0) > world.time.slowTick) return false;
  const unrest = getDomesticUnrest(world, id);
  if (unrest.pressure <= 0 || !spendTreasury(treasury, "relief", reliefCost(treasury))) return false;
  unrest.pressure = Math.max(0, unrest.pressure - 22);
  unrest.lowSupportSeconds = Math.max(0, unrest.lowSupportSeconds - 15);
  treasury.nextReliefTick = world.time.slowTick + RELIEF_COOLDOWN;
  recordSimulationEvent(world, { category: "politics", nationIds: [id],
    message: `${id} distributed emergency cash relief to households.` });
  return true;
}
