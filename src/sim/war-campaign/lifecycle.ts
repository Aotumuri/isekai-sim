import type { WorldState } from "../world-state";
import { isNationActive } from "../nation-active";
import { getOwnerByMesoId } from "../world-cache";
import { campaignWarKey, type WarCampaignState } from "./state";

/** Retain bounded terminal evidence, never active orders after a war ends. */
export function recordCompletedCampaignGoals(world: WorldState, state: WarCampaignState): void {
  const activeNations = new Set(world.nations.filter(isNationActive).map((nation) => nation.id));
  const wars = new Set(world.wars.filter((war) => activeNations.has(war.nationAId) && activeNations.has(war.nationBId))
    .map((war) => campaignWarKey(war.nationAId, war.nationBId, war.startedAtFastTick)));
  const owners = getOwnerByMesoId(world);
  for (const plan of state.byNationId.values()) {
    for (const goal of plan.objectives) {
      if (wars.has(goal.warKey)) continue;
      const survived = activeNations.has(plan.nationId);
      const secured = survived && goal.regionIds.length > 0 && goal.regionIds.every((id) =>
        (world.occupation.mesoById.get(id) ?? owners.get(id)) === plan.nationId);
      state.goalHistory.push({ nationId: plan.nationId, opponentId: goal.opponentId,
        warKey: goal.warKey, endedAtTick: world.time.fastTick,
        outcome: !survived ? "nation-eliminated" : secured ? "secured" : "unmet",
        reason: !survived ? "nation-eliminated" : secured ? "objectives-secured" :
          plan.mode === "seek-peace" ? "cost-limited-exit" : "war-ended-with-unmet-objectives",
      });
      state.version += 1;
    }
  }
  if (state.goalHistory.length > 100) state.goalHistory.splice(0, state.goalHistory.length - 100);
}
