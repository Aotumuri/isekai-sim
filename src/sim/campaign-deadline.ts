import type { NationId } from "../worldgen/nation";
import { foodReserveDays } from "./food-supply";
import { getWarDeclarationMode } from "./simulation-settings";
import { fastTicksToDays } from "./time";
import { findWar } from "./war-state";
import type { WorldState } from "./world-state";

export const CAMPAIGN_URGENCY_DAYS = 750;

export function getCampaignDeadlineDays(world: WorldState, nationId: NationId, opponent: NationId): number {
  if (getWarDeclarationMode(world) !== "diplomacy") return Infinity;
  const war = findWar(world.wars, nationId, opponent);
  if (!war || war.isTest) return Infinity;
  const nation = world.nations.find(({ id }) => id === nationId);
  const reserve = nation?.food ? foodReserveDays(nation.food) : Infinity;
  const defenderReadiness = world.mobilization?.byNationId.get(opponent)?.readiness ?? 0;
  const exploitationWindow = war.cause === "diplomatic-crisis" && war.aggressorId === nationId && defenderReadiness < 0.9
    ? CAMPAIGN_URGENCY_DAYS - fastTicksToDays(world.time.fastTick - war.startedAtFastTick)
    : Infinity;
  return Math.min(reserve, exploitationWindow > 0 ? exploitationWindow : Infinity);
}
