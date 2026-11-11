import type { WorldState } from "../sim/world-state";

/** Bounded detail in the existing optional strategic overlay, not the main UI. */
export function formatCampaignDebugLines(world: WorldState, nationLimit = 3): string[] {
  const state = world.settings?.warCampaignEnabled ? world.warCampaigns : undefined;
  if (!state || !state.byNationId.size && !state.goalHistory.length) return [];
  const lines = ["", "NATIONAL WAR CAMPAIGNS"];
  const plans = [...state.byNationId.values()].sort((a, b) =>
    Number(b.nationId === world.playerNation?.nationId) - Number(a.nationId === world.playerNation?.nationId));
  for (const plan of plans.slice(0, nationLimit)) {
    lines.push(`${plan.nationId}: ${plan.mode} | priority ${plan.primaryOpponentId ?? "-"} | rev ${plan.revision}`);
    lines.push(`  ${plan.reason} | cost ${plan.constraints.casualtyFraction.toFixed(2)}/${plan.constraints.costTolerance.toFixed(2)}`);
    for (const option of plan.alternatives?.slice(0, 3) ?? []) {
      lines.push(`  ALT ${option.mode} vs ${option.opponentId}: ${(option.score * 100).toFixed(1)} | benefit ${(option.benefit * 100).toFixed(1)} cost ${(option.resourceCost * 100).toFixed(1)} risk ${(option.failureRisk * 100).toFixed(1)}`);
    }
    for (const goal of plan.objectives.slice(0, 3)) {
      lines.push(`  ${goal.opponentId}: ${goal.kind} ${goal.achieved ? "military held" : "military pending"} | ${goal.rationale ?? "opening goal"} | ${goal.regionIds.slice(0, 3).join(",")}${goal.regionIds.length > 3 ? "..." : ""}`);
      if (goal.political) lines.push(`    POLITICAL ${goal.political.purpose}${goal.political.weaponTarget ? ` | weapons ${goal.political.weaponTarget}` : ""} | military ${goal.achieved ? "held" : "pending"}`);
    }
    const operations = world.offensiveOperations.operationsByNationId.get(plan.nationId) ?? [];
    for (const operation of operations) lines.push(`  OP ${operation.phase}: ${operation.capturedRegionIds.length} captured | ${operation.completionReason ?? "in progress"}`);
    const last = [...world.offensiveOperations.history].reverse().find((operation) => operation.nationId === plan.nationId);
    if (last) lines.push(`  LAST ${last.outcome}: ${last.completionReason}`);
  }
  for (const result of state.goalHistory.slice(-3)) lines.push(`GOAL ${result.nationId} vs ${result.opponentId}: ${result.outcome} | ${result.reason}`);
  return lines;
}
