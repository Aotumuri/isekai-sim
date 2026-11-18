import { writeFile, rename } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createScenarioWorld } from "../scenarios";
import { runSimulation } from "../helpers/simulation-driver";
import { withMutedSimulationLogs } from "../helpers/muted-logs";
import type { BenchmarkScenarioName } from "../benchmark/types";

// New-arm-only descriptive audit: internal limited goals differ from the fixed
// neutral A/B proxies. A preservation goal starting secured is not a conquest.
const args = process.argv.slice(2);
function option(name: string, fallback: string) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1] ?? "";
}
const seeds = Number(option("--seeds", "20"));
const ticks = Number(option("--ticks", "10000"));
if (![seeds, ticks].every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error("Positive integers required");
const output = option("--output", "diagnostics/war-ai-intent-v5.json");
const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (execFileSync("git", ["diff", "--", "src"], { encoding: "utf8" })) throw new Error("Commit simulation source first");
interface Goal {
  key: string; nationId: string; opponentId: string; kind: string; rationale: string;
  adoptedAt: number; regionCount: number; firstAchievedAt: number | null;
  endedAt: number | null; outcome: string; exitReason: string | null;
}
const results: ReturnType<typeof audit>[] = [];
for (let i = 0; i < seeds; i++) {
  for (const scenario of ["active-war", "matched-war", "two-island-amphibious"] as BenchmarkScenarioName[]) {
    results.push(withMutedSimulationLogs(() => audit(822_748_319_780 + i, scenario)));
    await writeFile(`${output}.tmp`, JSON.stringify({ revision, seeds, ticks, results }, null, 2));
    await rename(`${output}.tmp`, output);
  }
  console.log(`intent audit ${i + 1}/${seeds}`);
}
function audit(seed: number, scenario: BenchmarkScenarioName) {
  const world = createScenarioWorld(scenario, { seed, width: 640, height: 360, quick: true,
    reserveEnabled: true, reorganizationEnabled: true, exploitationEnabled: true, pocketReductionEnabled: true,
    config: { systems: { warCampaignEnabled: true, diplomacyEnabled: true, mobilizationEnabled: true,
      researchEnabled: true, armsAidEnabled: true, tradeEnabled: true, politicalTurbulenceEnabled: true } },
  });
  world.wars.forEach((war) => { war.isTest = false; });
  const goals = new Map<string, Goal>();
  let checkedTick = -1;
  runSimulation(world, { ticks, observe(current) {
    if (checkedTick === current.time.slowTick) return;
    checkedTick = current.time.slowTick;
    const state = current.warCampaigns;
    for (const campaign of state?.byNationId.values() ?? []) {
      for (const goal of campaign.objectives) {
        const key = `${campaign.nationId}:${goal.warKey}`;
        let record = goals.get(key);
        if (!record) {
          record = { key, nationId: campaign.nationId, opponentId: goal.opponentId,
            kind: goal.kind, rationale: goal.rationale ?? "unknown", adoptedAt: current.time.fastTick,
            regionCount: goal.regionIds.length, firstAchievedAt: null, endedAt: null,
            outcome: "ongoing-unmet", exitReason: null };
          goals.set(key, record);
        }
        if (goal.achieved) record.firstAchievedAt ??= current.time.fastTick;
        record.outcome = goal.achieved ? "ongoing-secured" : "ongoing-unmet";
      }
    }
    for (const goal of state?.goalHistory ?? []) {
      const record = goals.get(`${goal.nationId}:${goal.warKey}`);
      if (!record) throw new Error("Terminal goal was never observed at adoption");
      record.endedAt = goal.endedAtTick;
      record.outcome = goal.outcome;
      record.exitReason = goal.reason;
    }
  } });
  return { seed, scenario, goals: [...goals.values()] };
}
