import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import type { DiplomaticRelation } from "./diplomacy";
import type { ElectoralClaimPressure } from "./politics";
import { getTerritorialClaim, getTerritorialClaims } from "./territorial-claims";
import type { WarState } from "./war-state";
import { getOwnerByMesoId } from "./world-cache";
import type { WorldState } from "./world-state";

export interface TerritorialClaimObjective {
  interestId: string;
  claimantId: NationId;
  counterpartId: NationId;
  requestedRegionIds: MesoRegionId[];
  claims: { regionId: MesoRegionId; strength: number; heldTicks: number }[];
  openedAtTick: number;
  firstDeferredAtTick?: number;
}

export interface TerritorialClaimDeferral {
  interestId: string;
  regionIds: MesoRegionId[];
  firstAtTick: number;
  lastAtTick: number;
  score: number;
  minimumScore: number;
  electoralPressure?: ElectoralClaimPressure;
}

export interface TerritorialClaimOutcome {
  objective: TerritorialClaimObjective;
  endedAtTick: number;
  route: "diplomacy" | "peace" | "surrender";
  reason: string;
  retainedRegionIds: MesoRegionId[];
  outcome: "secured" | "partially-secured" | "unmet";
}

const HISTORY_LIMIT = 100;
const interestId = (claimant: NationId, counterpart: NationId, regions: readonly MesoRegionId[]) =>
  JSON.stringify([claimant, counterpart, [...regions].sort()]);

export function deferTerritorialClaim(
  world: WorldState, relation: DiplomaticRelation, claimantId: NationId, counterpartId: NationId,
  regions: MesoRegionId[], score: number, minimumScore: number, electoralPressure?: ElectoralClaimPressure,
): void {
  const id = interestId(claimantId, counterpartId, regions);
  const deferrals = relation.deferredClaims ??= new Map();
  const previous = deferrals.get(claimantId);
  const tick = world.time.fastTick;
  deferrals.set(claimantId, { interestId: id, regionIds: [...regions],
    firstAtTick: previous?.interestId === id ? previous.firstAtTick : tick,
    lastAtTick: tick, score, minimumScore, ...(electoralPressure ? { electoralPressure } : {}) });
}

export function adoptTerritorialClaim(
  world: WorldState, relation: DiplomaticRelation, claimantId: NationId, counterpartId: NationId, regions: MesoRegionId[],
): TerritorialClaimObjective {
  const id = interestId(claimantId, counterpartId, regions);
  const deferred = relation.deferredClaims?.get(claimantId);
  relation.deferredClaims?.delete(claimantId);
  const history = getTerritorialClaims(world).history;
  return {
    interestId: id, claimantId, counterpartId, requestedRegionIds: [...regions], openedAtTick: world.time.fastTick,
    firstDeferredAtTick: deferred?.interestId === id ? deferred.firstAtTick : undefined,
    claims: regions.map((regionId) => ({ regionId, strength: getTerritorialClaim(world, claimantId, regionId),
      heldTicks: history.get(regionId)?.get(claimantId)?.heldTicks ?? 0 })).filter((claim) => claim.strength >= 20),
  };
}

export function getWarTerritorialDemand(war: WarState): readonly MesoRegionId[] | undefined {
  return war.claimObjective?.requestedRegionIds ?? war.ultimatumRegionIds;
}

export function recordTerritorialClaimOutcome(
  world: WorldState, objective: TerritorialClaimObjective | undefined, route: TerritorialClaimOutcome["route"], reason: string,
): void {
  if (!objective || !world.diplomacy) return;
  const owners = getOwnerByMesoId(world);
  const retainedRegionIds = objective.requestedRegionIds.filter((region) => owners.get(region) === objective.claimantId);
  const outcome = retainedRegionIds.length === objective.requestedRegionIds.length ? "secured"
    : retainedRegionIds.length ? "partially-secured" : "unmet";
  const history = world.diplomacy.claimOutcomeHistory ??= [];
  history.push({ objective, endedAtTick: world.time.fastTick, outcome, retainedRegionIds, route, reason });
  if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
}
