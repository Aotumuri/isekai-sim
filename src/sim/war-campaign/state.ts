import type { NationId } from "../../worldgen/nation";
import type { MesoRegionId } from "../../worldgen/meso-region";
import type { WorldState } from "../world-state";
import type { CampaignConstraints, CampaignMode } from "./policy";
import type { CampaignForceBudget } from "./force-budget";
import type { PoliticalObjective } from "./political-objectives";
import type { CampaignAlternative } from "./alternatives";
import type { CampaignObservation } from "./forecast";

export interface CampaignObjective {
  warKey: string;
  opponentId: NationId;
  kind: "limited-occupation" | "preserve-sovereignty";
  rationale?: string;
  regionIds: MesoRegionId[];
  openingStrength: number;
  achieved: boolean;
  political?: PoliticalObjective;
}
export interface WarCampaign {
  nationId: NationId;
  objectives: CampaignObjective[];
  mode: CampaignMode;
  primaryOpponentId: NationId | null;
  adoptedAtTick: number;
  evaluatedAtTick: number;
  revision: number;
  reason: string;
  constraints: CampaignConstraints;
  alternatives?: CampaignAlternative[];
  observation?: CampaignObservation;
}
export interface WarCampaignState {
  goalHistory: {
    nationId: NationId; opponentId: NationId; warKey: string; endedAtTick: number;
    outcome: "secured" | "unmet" | "nation-eliminated"; reason: string;
  }[];
  forceBudget?: CampaignForceBudget;
  byNationId: Map<NationId, WarCampaign>;
  version: number;
  events: { nationId: NationId; tick: number; mode: CampaignMode; reason: string; revision: number }[];
}
export function getWarCampaign(world: WorldState, nationId: NationId): WarCampaign | undefined {
  return world.settings?.warCampaignEnabled ? world.warCampaigns?.byNationId.get(nationId) : undefined;
}
export function campaignWarKey(a: NationId, b: NationId, startedAt: number): string {
  return `${a < b ? `${a}:${b}` : `${b}:${a}`}@${startedAt}`;
}
export function formatWarCampaignSummary(world: WorldState): string {
  return [...(world.warCampaigns?.byNationId.values() ?? [])].map((plan) =>
    `${plan.nationId}: ${plan.mode}, primary=${plan.primaryOpponentId}, revision=${plan.revision}, reason=${plan.reason}\n` +
    plan.objectives.map((goal) => `  ${goal.opponentId}: ${goal.kind} [${goal.regionIds.join(",")}] achieved=${goal.achieved}`).join("\n"),
  ).join("\n");
}
