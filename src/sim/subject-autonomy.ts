import { getRelation } from "./diplomacy";
import { changeResource, findTradeRoute, resourceReserve } from "./international-trade";
import type { NationId } from "../worldgen/nation";
import type { NationRuntime } from "./nation-runtime";
import { getWarDeclarationMode, hasPoliticalTurbulence, recordSimulationEvent } from "./simulation-settings";
import { isNationActive } from "./nation-active";
import { reviewSubjectNegotiation } from "./subject-negotiations";
import { getUnitCombatStrength } from "./unit-strength";
import { buildWarAdjacency } from "./war-state";
import { getMesoById, getOwnerByMesoId } from "./world-cache";
import type { WorldState } from "./world-state";

const AUTONOMY_INTERVAL = 10;
const SUBJECT_INDUSTRIAL_RESERVE = 12;
const AID_PER_RESOURCE = 3;
const AID_RESOURCES = ["steel", "fuel"] as const;

function supportSubjectIndustry(world: WorldState, overlord: NationRuntime, subject: NationRuntime,
  government: NonNullable<NationRuntime["subjectGovernment"]>) {
  const deliveryLimit = government.selfGovernment?.extraIndustrialAid ? 5 : AID_PER_RESOURCE;
  const requests = AID_RESOURCES.map((resource) => {
    const surplus = subject.resourceFlow.productionSurplus?.[resource] ?? 0;
    const stock = subject.resources[resource] + surplus * AUTONOMY_INTERVAL;
    const deficit = Math.max(0, SUBJECT_INDUSTRIAL_RESERVE - stock);
    const requested = Math.min(deliveryLimit, deficit);
    const exportable = Math.max(0, overlord.resources[resource] - resourceReserve(overlord, resource));
    return { resource, requested, upgradable: Math.min(deficit, exportable) > AID_PER_RESOURCE, available: Math.min(requested, exportable) };
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
    if (resource === "fuel" && requested > 0) {
      world.instrumentation?.observeFuelFlow?.({ category: "subjectSupport", nationId: subject.id,
        stock: subject.resources.fuel, requested, consumed: 0, transferred: delivered });
    }
    if (delivered > 0) {
      changeResource(overlord, resource, -delivered);
      changeResource(subject, resource, delivered);
    }
    unmet += (requested - delivered) / deliveryLimit;
  }
  return { shortage: unmet, canIncreaseAid: !routeBlocked && requests.some(({ upgradable }) => upgradable) };
}

export function updateSubjectAutonomy(world: WorldState): void {
  if (getWarDeclarationMode(world) !== "diplomacy" || world.time.slowTick % AUTONOMY_INTERVAL !== 0 ||
    !world.nations.some((nation) => nation.subjectGovernment)) return;
  const startedAt = world.instrumentation ? performance.now() : 0;
  const owners = getOwnerByMesoId(world), regions = getMesoById(world);
  const nations = new Map(world.nations.map((nation) => [nation.id, nation]));
  const occupied = new Set<NationRuntime>();
  const districtCounts = new Map<NationRuntime, number>();
  for (const [id, owner] of owners) {
    const nation = nations.get(owner), region = regions.get(id);
    if (!nation || !region || region.type === "sea") continue;
    const occupier = world.occupation.mesoById.get(id);
    if (occupier && occupier !== owner) occupied.add(nation);
    districtCounts.set(nation, (districtCounts.get(nation) ?? 0) + 1);
  }
  const wars = buildWarAdjacency(world.wars);
  // Recognized demands inside a subject give its cabinet an outside option in bilateral talks.
  const externalBacking = new Map<NationId, number>();
  for (const [, talks] of world.regionalNegotiations ?? []) {
    const strength = talks.foreign?.strength ?? 0;
    if (strength <= 0) continue;
    externalBacking.set(talks.owner, Math.max(externalBacking.get(talks.owner) ?? 0, strength));
  }
  const parties = new Set(world.nations.flatMap(({ id, subjectGovernment }) =>
    subjectGovernment ? [id, subjectGovernment.overlordId] : []));
  const military = new Map<NationRuntime["id"], number>();
  for (const unit of world.units) {
    if (!parties.has(unit.nationId) || unit.manpower <= 0 || unit.org <= 0) continue;
    const strength = getUnitCombatStrength(unit) * (unit.type === "TransportShip" ? 0.1 : 1);
    military.set(unit.nationId, (military.get(unit.nationId) ?? 0) + strength);
  }
  for (const subject of world.nations) {
    const government = subject.subjectGovernment;
    const overlord = government && nations.get(government.overlordId);
    const districts = districtCounts.get(subject), overlordDistricts = overlord && districtCounts.get(overlord);
    if (!government || !overlord || !isNationActive(subject) || !isNationActive(overlord) || !districts || !overlordDistricts) continue;
    const { shortage, canIncreaseAid } = supportSubjectIndustry(world, overlord, subject, government);
    const policyPressure = hasPoliticalTurbulence(world) ? (subject.identityStability?.autonomyDemand ?? 0) * 5 : 0;
    const power = Math.min(1.5, districts / overlordDistricts);
    const relation = getRelation(world, subject.id, overlord.id);
    const strain = (1 - Math.max(0, Math.min(1, overlord.warCooperation))) * 2;
    const food = world.settings?.foodEnabled === false ? undefined : subject.food;
    const levyPressure = (food?.levy ?? 0) < 0 ? (government.foodLevy ?? 0) * 4 : 0;
    const hunger = food ? (1 - food.rationCoverage) * 2 : 0;
    const autonomyRelief = hasPoliticalTurbulence(world) && subject.governance?.policy === "autonomy" ? 1.5 : 0;
    const charterRelief = government.selfGovernment ? 2.8 : 0;
    const change = levyPressure + hunger + power * 3 + policyPressure + strain + shortage - relation.trust * 0.04 - 0.5 - autonomyRelief - charterRelief;
    government.autonomy = Math.max(0, Math.min(100, (government.autonomy ?? 0) + change));
    const subjectStrength = military.get(subject.id) ?? 0;
    const sponsorStrength = military.get(overlord.id) ?? 0;
    reviewSubjectNegotiation(world, { subject, overlord, government, relation, shortage, canIncreaseAid, footprint: power,
      power: subjectStrength || sponsorStrength ? subjectStrength / Math.max(1, sponsorStrength) : power,
      subjectAtWar: wars.has(subject.id), overlordAtWar: wars.has(overlord.id),
      occupied: occupied.has(subject), levyBurden: levyPressure / 4,
      externalBacking: externalBacking.get(subject.id) ?? 0 });
  }
  world.instrumentation?.recordDuration("politics.subjectNegotiations", performance.now() - startedAt);
}
