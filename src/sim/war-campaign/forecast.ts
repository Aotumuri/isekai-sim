import type { NationId } from "../../worldgen/nation";
import type { MesoRegionId } from "../../worldgen/meso-region";
import type { NationRuntime } from "../nation-runtime";
import type { WarState } from "../war-state";
import type { WorldState } from "../world-state";
import type { CampaignObjective, WarCampaign } from "./state";
import type { CampaignOpportunity } from "./alternatives";
import { getOwnerByMesoId } from "../world-cache";
import { getUnitCombatStrength } from "../unit-strength";
import { getMoveMsPerRegion } from "../movement";
import { getNationalTerritorialValue, getTerritorialValue } from "../territorial-value";
import { assessPeaceOffer, whitePeaceTerms } from "../war-negotiations";
import { getWarDeclarationMode } from "../simulation-settings";
import { hasMinimumPeaceAge } from "../peace-maturity";
import { campaignWarKey } from "./state";
import { isPoliticalGoalSecured } from "./political-objectives";
import { WORLD_BALANCE } from "../../data/balance";

export interface CampaignObservation { tick: number; casualtyFraction: number; lossRate: number }

export function observeCampaignCost(world: WorldState, casualtyFraction: number, previous?: WarCampaign): CampaignObservation {
  const old = previous?.observation;
  const elapsed = old ? (world.time.fastTick - old.tick) / 10 : 0;
  const rate = elapsed > 0 ? Math.max(0, casualtyFraction - old!.casualtyFraction) / elapsed : 0;
  return { tick: world.time.fastTick, casualtyFraction,
    lossRate: old ? old.lossRate * 0.8 + rate * 0.2 : 0 };
}

/** Adapter collects observable state; the alternative evaluator is pure.
 * Distances ignore future battles, so arrival and outcome remain estimates. */
export function forecastCampaignOpportunities(
  world: WorldState, nation: NationRuntime, wars: WarState[], goals: CampaignObjective[],
  strengths: Map<NationId, number>, observation: CampaignObservation,
): CampaignOpportunity[] {
  const own = Math.max(1, strengths.get(nation.id) ?? 0);
  const investment = Math.max(1, ...goals.map((goal) => goal.openingManpower ?? goal.openingStrength));
  const infantry = WORLD_BALANCE.unit.types.Infantry;
  const strengthPerWeapon = infantry.manpower / Math.max(1, infantry.weaponCost ?? 1);
  const totalValue = getNationalTerritorialValue(world, nation.id);
  const owners = getOwnerByMesoId(world);
  const homeland = world.mesoRegions.filter((r) => owners.get(r.id) === nation.id &&
    world.occupation.mesoById.has(r.id) && world.occupation.mesoById.get(r.id) !== nation.id).map((r) => r.id);
  const atRisk = getTerritorialValue(world, nation.id, homeland) / totalValue;
  const units = world.units.filter((u) => u.domain === "land" && u.nationId === nation.id);
  return goals.map((goal) => {
    const war = wars.find((w) => campaignWarKey(w.nationAId, w.nationBId, w.startedAtFastTick) === goal.warKey)!;
    const enemy = world.nations.find((n) => n.id === goal.opponentId)!;
    const distances = objectiveDistances(world, nation.id, goal.opponentId, goal.regionIds);
    const arriving = units.map((unit) => ({ unit, seconds: (distances.get(unit.regionId) ?? Infinity) * getMoveMsPerRegion(unit) / 1000 }))
      .filter(({ unit, seconds }) => seconds < 30 && !world.retreatPlans.retreatIdByUnitId.has(unit.id) &&
        !world.reorganization.planIdByUnitId.has(unit.id));
    let available = arriving.reduce((sum, { unit }) => sum + getUnitCombatStrength(unit), 0);
    let arrival = available > 0 ? arriving.reduce((sum, { unit, seconds }) => sum + getUnitCombatStrength(unit) * seconds, 0) / available : Infinity;
    const invasion = world.amphibiousOperations.operations.find((op) => op.nationId === nation.id &&
      op.enemyNationId === goal.opponentId && op.phase !== "cancelled" && op.phase !== "landed");
    if (!available && invasion) {
      available = invasion.assignedStrength;
      arrival = Math.max(0, invasion.launchFeasibility.estimatedCompletionTick - world.time.fastTick) / 10;
    }
    const victoryRegions = goal.political?.purpose === "decisive-victory"
      ? world.mesoRegions.filter((r) => owners.get(r.id) === goal.opponentId).map((r) => r.id) : goal.regionIds;
    const politicalValue = goal.kind === "preserve-sovereignty" ? atRisk : goal.political?.purpose === "coercive-settlement"
      ? Math.min(goal.political.weaponTarget, enemy.resources.weapons) * strengthPerWeapon / own
      : getTerritorialValue(world, nation.id, victoryRegions) / totalValue;
    const securedValue = goal.kind !== "preserve-sovereignty" && isPoliticalGoalSecured(world, nation.id, goal) ? politicalValue : 0;
    const negotiationAllowed = getWarDeclarationMode(world) === "diplomacy" && !war.isTest &&
      hasMinimumPeaceAge(world.time.fastTick, war.startedAtFastTick);
    // Only assess existing negotiations: forecasting must not manufacture an
    // opening offer or change its opening-power snapshot ahead of diplomacy.
    const negotiation = [...(world.warNegotiations?.active.values() ?? [])].find((n) =>
      [n.a, n.b].includes(nation.id) && [n.a, n.b].includes(goal.opponentId));
    const terms = whitePeaceTerms();
    if (goal.political?.purpose === "territorial-concession" && goal.achieved) terms.demandedRegionIds = [...goal.regionIds];
    if (goal.political?.purpose === "coercive-settlement" && goal.achieved) terms.demandedWeapons = Math.min(goal.political.weaponTarget, Math.floor(enemy.resources.weapons));
    const peace = negotiationAllowed && negotiation ? assessPeaceOffer(world, goal.opponentId, nation.id, terms) : undefined;
    const peaceProbability = peace ? peace.accepts ? 1 : Number.isFinite(peace.score) ?
      1 / (1 + Math.exp(-peace.score / 10)) * 0.5 : 0 : 0;
    const settlingGain = securedValue || (terms.demandedRegionIds.length || terms.demandedWeapons > 0 ? politicalValue : 0);
    return { opponentId: goal.opponentId, availableStrength: available,
      opposition: strengths.get(goal.opponentId) ?? 0, arrivalSeconds: arrival,
      objectiveValue: Math.max(0, politicalValue - securedValue), securedValue,
      homelandAtRisk: atRisk, lossFractionPerSecond: observation.lossRate,
      replacementFraction: Math.min(nation.resources.manpower, nation.resources.weapons * strengthPerWeapon) / investment,
      peaceProbability, settlementValue: settlingGain, militaryGoalHeld: goal.achieved,
      uncertainty: available > 0 ? 0.25 : 0.75,
      committedFraction: units.filter((u) => u.moveToId || world.offensiveOperations.operationIdByUnitId.has(u.id))
        .reduce((sum, u) => sum + getUnitCombatStrength(u), 0) / own };
  });
}

function objectiveDistances(world: WorldState, nation: NationId, opponent: NationId, targets: MesoRegionId[]) {
  const owners = getOwnerByMesoId(world);
  const regions = new Map(world.mesoRegions.map((r) => [r.id, r]));
  const distance = new Map(targets.map((id) => [id, 0]));
  const queue = [...targets];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    for (const next of regions.get(id)?.neighbors ?? []) {
      if (regions.get(next.id)?.type === "sea" || distance.has(next.id) ||
        owners.get(next.id) !== nation && owners.get(next.id) !== opponent) continue;
      distance.set(next.id, distance.get(id)! + 1);
      queue.push(next.id);
    }
  }
  return distance;
}
