import type { WorldState } from "../sim/world-state";

/** Bounded detail in the existing optional strategic overlay, not the main UI. */
export function formatCampaignDebugLines(world: WorldState): string[] {
  const state = world.settings?.warCampaignEnabled ? world.warCampaigns : undefined;
  if (!state?.byNationId.size) return [];
  const lines = ["", "NATIONAL WAR CAMPAIGNS"];
  for (const plan of [...state.byNationId.values()].slice(0, 6)) {
    lines.push(`${plan.nationId}: ${plan.mode} | priority ${plan.primaryOpponentId ?? "-"} | rev ${plan.revision}`);
    lines.push(`  ${plan.reason} | cost ${plan.constraints.casualtyFraction.toFixed(2)}/${plan.constraints.costTolerance.toFixed(2)}`);
    for (const goal of plan.objectives.slice(0, 3)) {
      lines.push(`  ${goal.opponentId}: ${goal.kind} ${goal.achieved ? "SECURED" : "pending"} | ${goal.regionIds.slice(0, 3).join(",")}${goal.regionIds.length > 3 ? "..." : ""}`);
    }
    const operations = world.offensiveOperations.operationsByNationId.get(plan.nationId) ?? [];
    for (const operation of operations) lines.push(`  OP ${operation.phase}: ${operation.capturedRegionIds.length} captured | ${operation.completionReason ?? "in progress"}`);
    const last = [...world.offensiveOperations.history].reverse().find((operation) => operation.nationId === plan.nationId);
    if (last) lines.push(`  LAST ${last.outcome}: ${last.completionReason}`);
  }
  return lines;
}
