import type { NationId } from "../worldgen/nation";
import { foodReserveSeconds } from "./food-supply";
import { getWarDeclarationMode } from "./simulation-settings";
import { FAST_TICK_MS } from "./time";
import { findWar } from "./war-state";
import type { WorldState } from "./world-state";

export function getCampaignDeadline(world: WorldState, nationId: NationId, opponent: NationId): number {
  if (getWarDeclarationMode(world) !== "diplomacy") return Infinity;
  const war = findWar(world.wars, nationId, opponent);
  if (!war || war.isTest) return Infinity;
  const nation = world.nations.find(({ id }) => id === nationId);
  const reserve = nation?.food ? foodReserveSeconds(nation.food) : Infinity;
  const defenderReadiness = world.mobilization?.byNationId.get(opponent)?.readiness ?? 0;
  const exploitationWindow = war.cause === "diplomatic-crisis" && war.aggressorId === nationId && defenderReadiness < 0.9
    ? 75 - (world.time.fastTick - war.startedAtFastTick) * FAST_TICK_MS / 1000
    : Infinity;
  return Math.min(reserve, exploitationWindow > 0 ? exploitationWindow : Infinity);
}
