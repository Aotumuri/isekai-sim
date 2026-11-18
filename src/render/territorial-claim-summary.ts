import type { DiplomaticRelation } from "../sim/diplomacy";
import { getNationName } from "../sim/nation-identity";
import { findWar } from "../sim/war-state";
import { getOwnerByMesoId } from "../sim/world-cache";
import type { WorldState } from "../sim/world-state";
import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";

export function formatTerritorialClaimObjective(
  world: WorldState, relation: DiplomaticRelation, districtName: (id: MesoRegionId) => string,
): string[] {
  if (!world.settings?.warCampaignEnabled) return [];
  const { nationAId: a, nationBId: b } = relation;
  const war = findWar(world.wars, a, b);
  const objective = war?.claimObjective ?? relation.crisis?.claimObjective;
  const describeRegions = (ids: readonly MesoRegionId[]) =>
    ids.slice(0, 3).map(districtName).join(", ") + (ids.length > 3 ? ` and ${ids.length - 3} more` : "");

  if (objective) {
    const regions = objective.requestedRegionIds;
    const owners = getOwnerByMesoId(world);
    const held = regions.filter((id) => owners.get(id) === objective.claimantId).length;
    const occupied = regions.filter((id) => owners.get(id) !== objective.claimantId &&
      world.occupation.mesoById.get(id) === objective.claimantId).length;
    const phase = war?.claimObjective ? "War aim" : "Diplomatic demand";
    const lines = [
      `${phase} · ${getNationName(world, objective.claimantId)} seeks ${describeRegions(regions)}.`,
      `Legally held ${held} of ${regions.length} · under occupation ${occupied}.`,
    ];
    if (objective.claims.length) {
      const evidence = objective.claims.slice(0, 3).map((claim) =>
        `${districtName(claim.regionId)} ${Math.round(claim.strength)}/100`);
      lines.push(`Claim strength when issued at tick ${objective.openedAtTick} · ${evidence.join(", ")}.`);
    }
    if (objective.firstDeferredAtTick !== undefined) lines.push(`First deferred at tick ${objective.firstDeferredAtTick}.`);
    return lines;
  }

  const matchesPair = (claimant: NationId, counterpart: NationId) =>
    (claimant === a && counterpart === b) || (claimant === b && counterpart === a);
  const history = world.diplomacy?.claimOutcomeHistory ?? [];
  let last = history.length - 1;
  while (last >= 0 && !matchesPair(history[last].objective.claimantId, history[last].objective.counterpartId)) last--;
  const ended = history[last];
  const deferrals = [...(relation.deferredClaims ?? [])].sort(([, first], [, second]) => second.lastAtTick - first.lastAtTick);
  const latest = deferrals[0];
  if (latest && (!ended || latest[1].lastAtTick >= ended.endedAtTick)) {
    const [claimant, deferred] = latest;
    const lines = [
      `${getNationName(world, claimant)} deferred its demand for ${describeRegions(deferred.regionIds)} at tick ${deferred.lastAtTick}.`,
      `Escalation score ${deferred.score.toFixed(1)} · required ${deferred.minimumScore.toFixed(1)}.`,
    ];
    const pressure = deferred.electoralPressure;
    if (pressure) lines.push(`Coalition support was ${pressure.coalitionSupport}%. The upcoming election raised the required score by ${pressure.scoreIncrease.toFixed(1)}.`);
    return lines;
  }
  if (!ended) return [];
  const outcomes = { secured: "Claim secured", "partially-secured": "Claim partially secured", unmet: "Claim unmet" };
  const reasons = { diplomacy: "Diplomatic resolution", peace: "Peace agreement", surrender: "Surrender" };
  return [
    `${outcomes[ended.outcome]} · ${getNationName(world, ended.objective.claimantId)} · ${describeRegions(ended.objective.requestedRegionIds)}.`,
    `${reasons[ended.route]} at tick ${ended.endedAtTick} (${ended.reason}). Legally retained ${ended.retainedRegionIds.length} of ${ended.objective.requestedRegionIds.length} districts at settlement.`,
  ];
}
