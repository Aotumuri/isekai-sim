import { clamp } from "../utils/math";
import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import { getRelation } from "./diplomacy";
import { prepareIdentityEffects } from "./identity-grievances";
import { isNationActive } from "./nation-active";
import type { NationRuntime } from "./nation-runtime";
import { connectedRegionGroups, createPeaceBorderContext, getPeaceBorderIssue } from "./peace-borders";
import { getManualGovernmentId } from "./player-nation";
import { REDISTRIBUTION_REVIEW_INTERVAL, type RecentAcquisition } from "./recent-acquisitions";
import { assessRedistribution, MIN_DELEGATION_ADVANTAGE, type Administration } from "./redistribution-evaluation";
import { getWarDeclarationMode, hasPoliticalTurbulence, recordSimulationEvent } from "./simulation-settings";
import { getWarTerritorialDemand } from "./territorial-claim-objective";
import { transferTerritories, type TerritoryTransfer } from "./territory-transfer";
import { getUnitCombatStrength } from "./unit-strength";
import { buildWarAdjacency } from "./war-state";
import { getMesoById, getOwnerByMesoId } from "./world-cache";
import type { WorldState } from "./world-state";

const FINALIST_LIMIT = 8;
type Province = WorldState["macroRegions"][number];
type Borders = ReturnType<typeof createPeaceBorderContext>;
type Outcome = "retained" | "rejected" | "consensual" | "imposed";

function getAdministration(world: WorldState, nation: NationRuntime, provinces: Province[], strength: number): Administration {
  const ids = provinces.flatMap(({ mesoRegionIds }) => mesoRegionIds);
  return { nation, strength, districts: ids.length,
    population: ids.reduce((sum, id) => sum + (world.regionalPopulations?.get(id)?.size ?? 1), 0),
    effects: hasPoliticalTurbulence(world) && nation.identityGovernment ? prepareIdentityEffects(world, nation) : undefined };
}

function candidateParcels(ids: MesoRegionId[], provinces: Province[], borders: Borders) {
  const eligible = new Set(ids);
  const parcels = new Map<string, MesoRegionId[]>();
  const addGroups = (source: Set<MesoRegionId>) => {
    for (const component of connectedRegionGroups(source, borders.neighbors)) {
      component.sort();
      parcels.set(component.join(","), component);
    }
  };
  addGroups(eligible);
  for (const province of provinces) {
    const local = province.mesoRegionIds.filter((id) => eligible.has(id));
    if (local.length) addGroups(new Set(local));
  }
  return [...parcels.values()];
}

function keepsProvincesConnected(ids: MesoRegionId[], provinces: Province[], borders: Borders): boolean {
  const parcel = new Set(ids);
  for (const province of provinces) {
    const moved = province.mesoRegionIds.filter((id) => parcel.has(id));
    if (!moved.length || moved.length === province.mesoRegionIds.length) continue;
    const remaining = province.mesoRegionIds.filter((id) => !parcel.has(id));
    if (connectedRegionGroups(new Set(moved), borders.neighbors).length > 1 ||
      connectedRegionGroups(new Set(remaining), borders.neighbors).length > 1) return false;
  }
  return true;
}

function recordDecision(world: WorldState, overlord: NationId, ids: MesoRegionId[], outcome: Outcome, reason: string, subject?: NationId) {
  recordSimulationEvent(world, { category: "politics", nationIds: subject ? [overlord, subject] : [overlord],
    message: `Subject territorial redistribution (${outcome}): ${overlord}${subject ? ` / ${subject}` : ""}, districts ${ids.join(", ")}. ${reason}` });
}

function commitRedistribution(world: WorldState, leg: TerritoryTransfer, consent: boolean,
  willingness: number, reason: string, totalDistricts: number): boolean {
  const { from, to, regionIds } = leg;
  const endedAgreements = regionIds.filter((id) => world.regionalNegotiations?.get(id)?.status === "agreed").length;
  if (!transferTerritories(world, [leg], "redistribution")) return false;
  const relation = getRelation(world, from, to);
  const trustChange = consent ? 2 + Math.min(4, Math.round(willingness * 8)) : -Math.ceil(-willingness * 20);
  const beforeTrust = relation.trust;
  relation.trust = clamp(beforeTrust + trustChange, 0, 100);
  const actualTrustChange = Number((relation.trust - beforeTrust).toFixed(2));
  relation.opinion = clamp(relation.opinion + trustChange, -100, 100);
  if (!consent) relation.tension = Math.min(100, relation.tension - trustChange);
  world.instrumentation?.incrementCounter("redistribution.transfers");
  const remainder = totalDistricts - regionIds.length;
  recordDecision(world, from, regionIds, consent ? "consensual" : "imposed",
    `The overlord prioritized ${reason}. Bilateral trust changed by ${actualTrustChange > 0 ? "+" : ""}${actualTrustChange}. ` +
    `${remainder ? `The overlord retained ${remainder} other districts. ` : ""}` +
    `${endedAgreements ? `${endedAgreements} local guarantees require renegotiation under the new government.` : ""}`, to);
  return true;
}

function borderingSubjects(world: WorldState, parcel: MesoRegionId[], subjects: ReadonlyMap<NationId, NationRuntime>,
  requireControl = true): Set<NationId> {
  const neighbors = new Set<NationId>();
  const owners = getOwnerByMesoId(world), regions = getMesoById(world);
  for (const id of parcel) for (const next of regions.get(id)?.neighbors ?? []) {
    const owner = owners.get(next.id), neighbor = regions.get(next.id);
    if (owner && subjects.has(owner) && neighbor && neighbor.type !== "sea" &&
      (!requireControl || !world.occupation.mesoById.has(next.id))) neighbors.add(owner);
  }
  return neighbors;
}

/** Executes one bounded decision over the acquisition. All tests and the commit use current ownership. */
function reviewAcquisition(world: WorldState, overlord: NationRuntime, ids: MesoRegionId[], subjects: NationRuntime[]): void {
  const metrics = world.instrumentation;
  metrics?.incrementCounter("redistribution.reviews");
  const byId = new Map(subjects.map((nation) => [nation.id, nation]));
  if (!borderingSubjects(world, ids, byId).size) {
    metrics?.incrementCounter("redistribution.noEligibleSubject");
    recordDecision(world, overlord.id, ids, "retained", "No eligible subject had a land border.");
    return;
  }
  const borders = createPeaceBorderContext(world);
  const provinces = new Map<NationId, Province[]>();
  provinces.set(overlord.id, []);
  for (const subject of subjects) provinces.set(subject.id, []);
  for (const province of world.macroRegions) provinces.get(province.nationId)?.push(province);
  const strength = new Map<NationId, number>();
  for (const unit of world.units) {
    if (unit.domain !== "land" || !provinces.has(unit.nationId) || unit.manpower <= 0 || unit.org <= 0) continue;
    strength.set(unit.nationId, (strength.get(unit.nationId) ?? 0) + getUnitCombatStrength(unit));
  }
  const sourceProvinces = provinces.get(overlord.id)!;
  const direct = getAdministration(world, overlord, sourceProvinces, strength.get(overlord.id) ?? 0);
  const local = new Map<NationId, Administration>();
  const ranked = candidateParcels(ids, sourceProvinces, borders).flatMap((parcel) =>
    [...borderingSubjects(world, parcel, byId)].map((subjectId) => {
      let administration = local.get(subjectId);
      if (!administration) {
        administration = getAdministration(world, byId.get(subjectId)!, provinces.get(subjectId)!, strength.get(subjectId) ?? 0);
        local.set(subjectId, administration);
      }
      const assessment = assessRedistribution(world, borders, parcel, direct, administration);
      return { ...assessment, parcel, subjectId };
    })).sort((a, b) => b.score - a.score || b.parcel.length - a.parcel.length ||
      a.subjectId.localeCompare(b.subjectId) || a.parcel[0].localeCompare(b.parcel[0]));
  metrics?.incrementCounter("redistribution.candidates", ranked.length);

  let retained = ranked[0]?.retentionReason ?? "No coherent parcel was available.";
  let refused: NationId | undefined;
  for (const choice of ranked.slice(0, FINALIST_LIMIT)) {
    if (choice.score <= MIN_DELEGATION_ADVANTAGE) break;
    if (choice.capacityExceeded || !keepsProvincesConnected(choice.parcel, sourceProvinces, borders)) {
      if (!refused) retained = choice.capacityExceeded ? "The subject could not administer the additional population and districts." :
        "The cession would fragment a province.";
      continue;
    }
    const leg = { from: overlord.id, to: choice.subjectId, regionIds: choice.parcel };
    if (getPeaceBorderIssue(world, [leg], borders)) {
      if (!refused) retained = "The cession would split an existing land component.";
      continue;
    }
    metrics?.incrementCounter("redistribution.validCandidates");
    const consent = choice.willing >= 0;
    const imposed = !consent && choice.canImpose && choice.score >= 0.30;
    metrics?.incrementCounter("redistribution.proposals");
    if (!consent && !imposed) {
      metrics?.incrementCounter("redistribution.refusals");
      refused ??= choice.subjectId;
      retained = "The subject judged the administrative and security burden greater than the benefits.";
      continue;
    }
    if (commitRedistribution(world, leg, consent, choice.willing, choice.delegationReason, ids.length)) return;
    metrics?.incrementCounter("redistribution.failedTransfers");
    retained = "The ownership transaction failed final validation.";
  }
  metrics?.incrementCounter("redistribution.retained");
  recordDecision(world, overlord.id, ids, refused ? "rejected" : "retained", retained, refused);
}

export function updateSubjectRedistribution(world: WorldState): void {
  const pending = world.recentAcquisitions, now = world.time.slowTick;
  if (!pending?.size || now % REDISTRIBUTION_REVIEW_INTERVAL !== 0) return;
  if (getWarDeclarationMode(world) !== "diplomacy") { pending.clear(); return; }
  const started = world.instrumentation ? performance.now() : 0;
  const wars = buildWarAdjacency(world.wars), manual = getManualGovernmentId(world);
  const nations = new Map(world.nations.filter(isNationActive).map((nation) => [nation.id, nation]));
  const subjects = new Map<NationId, NationRuntime[]>();
  for (const nation of nations.values()) {
    const owner = nation.subjectGovernment?.overlordId;
    if (!owner || nation.id === manual) continue;
    const group = subjects.get(owner);
    if (group) group.push(nation);
    else subjects.set(owner, [nation]);
  }
  const contested = new Set<MesoRegionId>();
  const reserve = (ids?: readonly MesoRegionId[]) => {
    for (const id of ids ?? []) if (pending.has(id)) contested.add(id);
  };
  for (const relation of world.diplomacy?.relations.values() ?? []) {
    if (relation.crisis?.regionIds?.length) reserve(relation.crisis.regionIds);
  }
  for (const war of world.wars) reserve(getWarTerritorialDemand(war));
  for (const offer of world.territorialDeals?.offers ?? []) {
    if (offer.status !== "pending" || offer.expiresAtSlowTick <= now) continue;
    reserve(offer.offered);
    reserve(offer.requested);
  }
  const owners = getOwnerByMesoId(world), regions = getMesoById(world);
  const batches = new Map<RecentAcquisition, MesoRegionId[]>();
  for (const [id, acquisition] of pending) {
    const owner = nations.get(acquisition.owner), region = regions.get(id);
    if (now >= acquisition.expiresAt || !owner || owners.get(id) !== owner.id || owner.id === manual ||
      owner.subjectGovernment || owner.capitalMesoId === id || !region || region.type === "sea") {
      world.instrumentation?.incrementCounter("redistribution.invalidated");
      pending.delete(id);
      continue;
    }
    if (now < acquisition.reviewAt || wars.has(owner.id) || world.occupation.mesoById.has(id) || contested.has(id)) continue;
    const ids = batches.get(acquisition);
    if (ids) ids.push(id);
    else batches.set(acquisition, [id]);
  }
  for (const [acquisition, ids] of batches) {
    const owner = nations.get(acquisition.owner)!;
    const stillSubjects = (subjects.get(owner.id) ?? []).filter((nation) =>
      acquisition.subjectIds.has(nation.id) && nation.subjectGovernment!.establishedAtFastTick <= acquisition.acquiredOn);
    const atPeace = stillSubjects.filter(({ id }) => !wars.has(id));
    if (atPeace.length < stillSubjects.length) {
      const bordering = borderingSubjects(world, ids, new Map(stillSubjects.map((nation) => [nation.id, nation])), false);
      if (bordering.size && [...bordering].every((id) => wars.has(id))) continue;
    }
    for (const id of ids) pending.delete(id);
    reviewAcquisition(world, owner, ids.sort(), atPeace);
  }
  world.instrumentation?.recordDuration("politics.subjectRedistribution", performance.now() - started);
}
