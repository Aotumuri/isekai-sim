import type { NationRuntime } from "../nation-runtime";
import type { WarState } from "../war-state";
import type { NationId } from "../../worldgen/nation";
import { getCapitalDefenseAssessment } from "../capital-defense";
import { foodReserveSeconds } from "../food-supply";
import { getNationCharacter } from "../nation-character";
import { isNationActive } from "../nation-active";
import { allFieldUnits } from "../mobilization";
import { getUnitCombatStrength } from "../unit-strength";
import { getWarCasualties } from "../war-state";
import type { WorldState } from "../world-state";
import { evaluateCampaignPolicy, requiresCampaignReview, type CampaignConstraints } from "./policy";
import { getOpposingFrontSide } from "../land-fronts";
import { createWarCampaignState, type CampaignObjective, type WarCampaign, type WarCampaignState } from "./state";
import { buildCampaignObjectives } from "./objectives";
import { recordCompletedCampaignGoals } from "./lifecycle";
import { observeCampaignCost, forecastCampaignOpportunities } from "./forecast";
import { evaluateCampaignAlternatives } from "./alternatives";
import { unavailableManpower } from "./battle-costs";

/** One campaign per nation spanning every current opponent; no direct orders. */
export function updateWarCampaigns(world: WorldState): void {
  if (!world.settings?.warCampaignEnabled) {
    delete world.warCampaigns;
    return;
  }
  const state: WarCampaignState = world.warCampaigns ??= createWarCampaignState();
  recordCompletedCampaignGoals(world, state);
  const strengths = new Map<NationId, number>();
  const manpower = new Map<NationId, number>();
  for (const unit of allFieldUnits(world)) {
    manpower.set(unit.nationId, (manpower.get(unit.nationId) ?? 0) + Math.max(0, unit.manpower));
    if (unit.domain === "land") strengths.set(unit.nationId,
      (strengths.get(unit.nationId) ?? 0) + getUnitCombatStrength(unit));
  }
  const active = new Set(world.nations.filter(isNationActive).map((nation) => nation.id));
  const next = new Map<NationId, WarCampaign>();
  for (const nation of world.nations.filter(isNationActive)) {
    const wars = world.wars.filter((war) =>
      (war.nationAId === nation.id || war.nationBId === nation.id) &&
      active.has(war.nationAId) && active.has(war.nationBId));
    if (!wars.length) continue;
    const previous = state.byNationId.get(nation.id);
    const objectives = buildCampaignObjectives(world, nation.id, wars, strengths.get(nation.id) ?? 0, previous,
      (manpower.get(nation.id) ?? 0) + unavailableManpower(state.battleCosts?.get(nation.id)));
    const constraints = assessCampaignConstraints(world, nation, wars, objectives, strengths);
    const observation = observeCampaignCost(world, constraints.casualtyFraction, previous);
    const alternatives = evaluateCampaignAlternatives(
      forecastCampaignOpportunities(world, nation, wars, objectives, strengths, observation),
      constraints.aggression, previous);
    const decision = evaluateCampaignPolicy(constraints, alternatives);
    const topologyChanged = !previous || previous.objectives.map((goal) => goal.warKey).sort().join("|") !==
      objectives.map((goal) => goal.warKey).sort().join("|");
    const emergency = constraints.capitalCritical || constraints.foodSeconds < 45;
    const current = alternatives.find((option) => option.mode === previous?.mode && option.opponentId === previous.primaryOpponentId);
    const clearImprovement = !!current && alternatives[0].score - current.score >
      (alternatives[0].uncertainty + current.uncertainty) * 0.25;
    const reassess = clearImprovement || requiresCampaignReview(constraints, previous?.constraints,
      world.time.fastTick - (previous?.adoptedAtTick ?? world.time.fastTick), topologyChanged);
    const primary = reassess
      ? constraints.capitalCritical ? selectPrimaryOpponent(world, nation.id, objectives, previous?.primaryOpponentId, strengths)
        : alternatives[0]?.opponentId ?? null
      : previous!.primaryOpponentId;
    const mode = reassess ? decision.mode : previous!.mode;
    const changed = !previous || previous.mode !== mode || previous.primaryOpponentId !== primary || topologyChanged ||
      reassess && emergency && previous.reason !== decision.reason;
    const campaign: WarCampaign = {
      nationId: nation.id, objectives, constraints, mode, primaryOpponentId: primary,
      alternatives, observation,
      adoptedAtTick: changed ? world.time.fastTick : previous!.adoptedAtTick,
      evaluatedAtTick: world.time.fastTick, revision: (previous?.revision ?? 0) + Number(changed),
      reason: changed ? topologyChanged ? "war-membership-changed" : previous?.primaryOpponentId !== primary
        ? "priority-opponent-changed" : decision.reason : previous!.reason,
    };
    if (changed) {
      state.version += 1;
      state.events.push({ nationId: nation.id, tick: world.time.fastTick, mode,
        reason: campaign.reason, revision: campaign.revision });
    }
    next.set(nation.id, campaign);
  }
  if (state.byNationId.size !== next.size) state.version += 1;
  state.byNationId = next;
  for (const id of state.battleCosts?.keys() ?? []) if (!next.has(id)) state.battleCosts!.delete(id);
  if (state.events.length > 200) state.events.splice(0, state.events.length - 200);
}

function selectPrimaryOpponent(
  world: WorldState, nationId: NationId, goals: CampaignObjective[],
  previous: NationId | null | undefined, strengths: Map<NationId, number>,
): NationId | null {
  const capital = getCapitalDefenseAssessment(world, nationId);
  const threatened = capital?.primaryFrontId && world.landFronts.operationalSectorsById.get(capital.primaryFrontId);
  const urgentOpponent = threatened && getOpposingFrontSide(threatened, nationId)?.nationId;
  if (capital?.threatLevel === "critical" && urgentOpponent && goals.some((goal) => goal.opponentId === urgentOpponent)) return urgentOpponent;
  const candidates = goals.filter((goal) => !goal.achieved);
  const ranked = (candidates.length ? candidates : goals).map((goal) => goal.opponentId)
    .sort((a, b) => (strengths.get(a) ?? 0) - (strengths.get(b) ?? 0) || a.localeCompare(b));
  const best = ranked[0];
  if (previous && ranked.includes(previous) &&
    (strengths.get(previous) ?? 0) <= (strengths.get(best) ?? 0) * 1.25) return previous;
  return best ?? null;
}

function assessCampaignConstraints(
  world: WorldState, nation: NationRuntime, wars: WarState[],
  objectives: CampaignObjective[], strengths: Map<NationId, number>,
): CampaignConstraints {
    const enemyStrength = [...new Set(objectives.map((goal) => goal.opponentId))]
      .reduce((sum, id) => sum + (strengths.get(id) ?? 0), 0);
    const character = getNationCharacter(world, nation.id);
    const battleCost = world.warCampaigns?.battleCosts?.get(nation.id);
    return {
      strengthRatio: (strengths.get(nation.id) ?? 0) / Math.max(1, enemyStrength),
      casualtyFraction: (Math.max(battleCost?.directManpowerDamage ?? 0,
        wars.reduce((sum, war) => sum + getWarCasualties(war, nation.id), 0)) + (battleCost?.removedManpower ?? 0)) /
        Math.max(1, ...objectives.map((goal) => goal.openingManpower ?? goal.openingStrength)),
      costTolerance: 0.5 + character.aggression,
      foodSeconds: nation.food ? foodReserveSeconds(nation.food) : Infinity,
      replacementConstrained: nation.resources.weapons <= 0 && nation.resources.manpower <= 0,
      capitalCritical: getCapitalDefenseAssessment(world, nation.id)?.threatLevel === "critical",
      objectivesSecured: objectives.some((goal) => goal.kind === "limited-occupation") &&
        objectives.every((goal) => goal.achieved),
      aggression: character.aggression,
    };
}
