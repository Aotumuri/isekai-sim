import { getManualGovernmentId } from "./player-nation";
import { getRelation, hasTreaty } from "./diplomacy";
import { startDiplomaticWar } from "./diplomatic-crises";
import { changeResource, findTradeRoute, resourceReserve } from "./international-trade";
import type { NationRuntime } from "./nation-runtime";
import { getNationName } from "./nation-identity";
import { getWarDeclarationMode, hasPoliticalTurbulence, recordSimulationEvent } from "./simulation-settings";
import { releaseSubjectGovernment } from "./subject-governments";
import { getMesoById, getOwnerByMesoId } from "./world-cache";
import type { WorldState } from "./world-state";

const AUTONOMY_INTERVAL = 10;
const SUBJECT_INDUSTRIAL_RESERVE = 12;
const AID_PER_RESOURCE = 3;
const AID_RESOURCES = ["steel", "fuel"] as const;

function supportSubjectIndustry(world: WorldState, overlord: NationRuntime, subject: NationRuntime,
  government: NonNullable<NationRuntime["subjectGovernment"]>): number {
  const requests = AID_RESOURCES.map((resource) => {
    const surplus = subject.resourceFlow.productionSurplus?.[resource] ?? 0;
    const stock = subject.resources[resource] + surplus * AUTONOMY_INTERVAL;
    const requested = Math.max(0, Math.min(AID_PER_RESOURCE, SUBJECT_INDUSTRIAL_RESERVE - stock));
    const exportable = Math.max(0, overlord.resources[resource] - resourceReserve(overlord, resource));
    return { resource, requested, available: Math.min(requested, exportable) };
  });
  const canSupply = requests.some(({ available }) => available > 0);
  const routeBlocked = canSupply && !findTradeRoute(world, overlord.id, subject.id);
  if (canSupply && routeBlocked !== !!government.industrialAidRouteBlocked) {
    recordSimulationEvent(world, { category: "trade", nationIds: [overlord.id, subject.id],
      message: routeBlocked
        ? `${overlord.id} could not deliver industrial support to ${subject.id}: no open route.`
        : `${overlord.id} resumed industrial support to ${subject.id} after the route reopened.` });
  }
  government.industrialAidRouteBlocked = routeBlocked;
  let unmet = 0;
  for (const { resource, requested, available } of requests) {
    const delivered = routeBlocked ? 0 : available;
    if (delivered > 0) {
      changeResource(overlord, resource, -delivered);
      changeResource(subject, resource, delivered);
    }
    unmet += (requested - delivered) / AID_PER_RESOURCE;
  }
  return unmet;
}

export function updateSubjectAutonomy(world: WorldState): void {
  if (getWarDeclarationMode(world) !== "diplomacy" || world.time.slowTick % AUTONOMY_INTERVAL !== 0 ||
    !world.nations.some((nation) => nation.subjectGovernment)) return;
  const owners = getOwnerByMesoId(world), regions = getMesoById(world);
  const nations = new Map(world.nations.map((nation) => [nation.id, nation]));
  const districtCounts = new Map<NationRuntime, number>();
  for (const [id, owner] of owners) {
    const nation = nations.get(owner), region = regions.get(id);
    if (!nation || !region || region.type === "sea") continue;
    districtCounts.set(nation, (districtCounts.get(nation) ?? 0) + 1);
  }
  for (const subject of world.nations) {
    const government = subject.subjectGovernment;
    const overlord = government && nations.get(government.overlordId);
    const districts = districtCounts.get(subject), overlordDistricts = overlord && districtCounts.get(overlord);
    if (!government || !overlord || !districts || !overlordDistricts) continue;
    const shortage = supportSubjectIndustry(world, overlord, subject, government);
    const policyPressure = hasPoliticalTurbulence(world) ? (subject.identityStability?.autonomyDemand ?? 0) * 5 : 0;
    const power = Math.min(1.5, districts / overlordDistricts);
    const relation = getRelation(world, subject.id, overlord.id);
    const strain = (1 - Math.max(0, Math.min(1, overlord.warCooperation))) * 2;
    const food = world.settings?.foodEnabled === false ? undefined : subject.food;
    const levyPressure = (food?.levy ?? 0) < 0 ? (government.foodLevy ?? 0) * 4 : 0;
    const hunger = food ? (1 - food.rationCoverage) * 2 : 0;
    const autonomyRelief = hasPoliticalTurbulence(world) && subject.governance?.policy === "autonomy" ? 1.5 : 0;
    const change = levyPressure + hunger + power * 3 + policyPressure + strain + shortage - relation.trust * 0.04 - 0.5 - autonomyRelief;
    government.autonomy = Math.max(0, Math.min(100, (government.autonomy ?? 0) + change));
    if (government.autonomy < 100 || hasTreaty(world, subject.id, overlord.id, "truce")) continue;
    if (!releaseSubjectGovernment(world, overlord.id, subject.id)) continue;
    recordSimulationEvent(world, { category: "politics", nationIds: [subject.id, overlord.id],
      message: `${getNationName(world, subject.id)} broke from ${getNationName(world, overlord.id)} and declared independence.` });
    if (power >= 0.6 && subject.id !== getManualGovernmentId(world)) startDiplomaticWar(world, subject.id, overlord.id);
  }
}
