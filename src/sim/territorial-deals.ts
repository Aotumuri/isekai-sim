import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import type { WorldState } from "./world-state";
import { getRelation, spendInfluence } from "./diplomacy";
import { getNationCharacter } from "./nation-character";
import { getForeignClaims, getTerritorialClaim } from "./territorial-claims";
import { canTransferTerritories, transferTerritories, type TerritoryTransfer } from "./territory-transfer";
import { getMesoById, getOwnerByMesoId, getAdjacentNationPairs } from "./world-cache";
import { findWar } from "./war-state";
import { getWarDeclarationMode, recordSimulationEvent } from "./simulation-settings";

export interface TerritorialOffer {
  id: number; proposerId: NationId; targetId: NationId; offered: MesoRegionId[]; requested: MesoRegionId[];
  createdAtSlowTick: number; expiresAtSlowTick: number;
  status: "pending" | "accepted" | "rejected" | "withdrawn" | "expired" | "stale";
}
export interface TerritorialDealsState { offers: TerritorialOffer[]; nextId: number; lastAISlowTick: number }
export function getTerritorialDeals(world: WorldState): TerritorialDealsState {
  return world.territorialDeals ??= { offers: [], nextId: 0, lastAISlowTick: 0 };
}
function legs(offer: Pick<TerritorialOffer, "proposerId" | "targetId" | "offered" | "requested">): TerritoryTransfer[] {
  return [
    ...(offer.offered.length ? [{ from: offer.proposerId, to: offer.targetId, regionIds: offer.offered }] : []),
    ...(offer.requested.length ? [{ from: offer.targetId, to: offer.proposerId, regionIds: offer.requested }] : []),
  ];
}
export function territorialValue(world: WorldState, nationId: NationId, ids: MesoRegionId[]): number {
  const regions = getMesoById(world), nation = world.nations.find((item) => item.id === nationId);
  return ids.reduce((sum, id) => {
    const region = regions.get(id);
    return sum + 10 + getTerritorialClaim(world, nationId, id) * 0.45 + (region?.resource ? 20 : 0) +
      (region?.building ? 15 : 0) + (nation?.capitalMesoId === id ? 80 : 0);
  }, 0);
}
export function willAcceptTerritorialOffer(world: WorldState, offer: TerritorialOffer): boolean {
  const relation = getRelation(world, offer.proposerId, offer.targetId), character = getNationCharacter(world, offer.targetId);
  const received = territorialValue(world, offer.targetId, offer.offered), given = territorialValue(world, offer.targetId, offer.requested);
  const capital = world.nations.find((nation) => nation.id === offer.targetId)?.capitalMesoId;
  if (capital && offer.requested.includes(capital)) return false;
  const threshold = Math.max(0.85, 1.2 - character.cooperation * 0.2 - relation.opinion * 0.001);
  return relation.trust >= 25 && relation.opinion > -40 && received >= given * threshold;
}
export function proposeTerritorialExchange(world: WorldState, proposerId: NationId, targetId: NationId,
  offered: MesoRegionId[], requested: MesoRegionId[]): TerritorialOffer | null {
  if (getWarDeclarationMode(world) !== "diplomacy" || proposerId === targetId || findWar(world.wars, proposerId, targetId) ||
    getRelation(world, proposerId, targetId).crisis) return null;
  const draft = { proposerId, targetId, offered: [...offered], requested: [...requested] };
  if (!canTransferTerritories(world, legs(draft))) return null;
  const state = getTerritorialDeals(world);
  if (state.offers.filter((offer) => offer.status === "pending").length >= 20 ||
    state.offers.some((offer) => offer.status === "pending" && ((offer.proposerId === proposerId && offer.targetId === targetId) ||
      (offer.proposerId === targetId && offer.targetId === proposerId))) || !spendInfluence(world, proposerId, 8)) return null;
  const offer: TerritorialOffer = { ...draft, id: state.nextId++, createdAtSlowTick: world.time.slowTick,
    expiresAtSlowTick: world.time.slowTick + 60, status: "pending" };
  state.offers.push(offer);
  while (state.offers.length > 40) {
    const index = state.offers.findIndex((item) => item.status !== "pending");
    if (index < 0) break; state.offers.splice(index, 1);
  }
  recordSimulationEvent(world, { category: "diplomacy", nationIds: [proposerId, targetId],
    message: `${proposerId} offered ${offered.length} regions to ${targetId} in exchange for ${requested.length}.` });
  return offer;
}
export function respondToTerritorialOffer(world: WorldState, nationId: NationId, offerId: number, accept: boolean): boolean {
  if (getWarDeclarationMode(world) !== "diplomacy") return false;
  const offer = getTerritorialDeals(world).offers.find((item) => item.id === offerId && item.targetId === nationId && item.status === "pending");
  if (!offer) return false;
  if (world.time.slowTick >= offer.expiresAtSlowTick) { offer.status = "expired"; return false; }
  if (findWar(world.wars, offer.proposerId, offer.targetId) || getRelation(world, offer.proposerId, offer.targetId).crisis ||
    !canTransferTerritories(world, legs(offer))) { offer.status = "stale"; return false; }
  if (!accept) offer.status = "rejected";
  else {
    if (!transferTerritories(world, legs(offer))) return false;
    offer.status = "accepted";
    const relation = getRelation(world, offer.proposerId, offer.targetId);
    relation.opinion = Math.min(100, relation.opinion + 8); relation.trust = Math.min(100, relation.trust + 5);
    relation.grievance = Math.max(0, relation.grievance - 10); relation.tension = Math.max(0, relation.tension - 10);
  }
  recordSimulationEvent(world, { category: "diplomacy", nationIds: [offer.proposerId, offer.targetId],
    message: `${offer.targetId} ${offer.status} the territorial exchange proposed by ${offer.proposerId}.` });
  return true;
}
export function withdrawTerritorialOffer(world: WorldState, nationId: NationId, offerId: number): boolean {
  const offer = world.territorialDeals?.offers.find((item) => item.id === offerId && item.proposerId === nationId && item.status === "pending");
  if (!offer) return false; offer.status = "withdrawn"; return true;
}
export function updateTerritorialDeals(world: WorldState): void {
  if (getWarDeclarationMode(world) !== "diplomacy") {
    for (const offer of world.territorialDeals?.offers ?? []) if (offer.status === "pending") offer.status = "withdrawn";
    return;
  }
  const state = getTerritorialDeals(world), now = world.time.slowTick;
  for (const offer of state.offers) if (offer.status === "pending") {
    if (now >= offer.expiresAtSlowTick) offer.status = "expired";
    else if (findWar(world.wars, offer.proposerId, offer.targetId) || getRelation(world, offer.proposerId, offer.targetId).crisis ||
      !canTransferTerritories(world, legs(offer))) offer.status = "stale";
    else if (now - offer.createdAtSlowTick >= 10) respondToTerritorialOffer(world, offer.targetId, offer.id, willAcceptTerritorialOffer(world, offer));
  }
  if (now - state.lastAISlowTick < 60) return;
  state.lastAISlowTick = now;
  const owners = getOwnerByMesoId(world);
  for (const [a, b] of getAdjacentNationPairs(world)) {
    const wanted = getForeignClaims(world, a, b).find((claim) => claim.heldTicks > 0 && claim.strength >= 35);
    const offered = getForeignClaims(world, b, a).find((claim) => claim.heldTicks > 0 && claim.strength >= 35);
    if (!wanted || !offered || owners.get(wanted.regionId) !== b || owners.get(offered.regionId) !== a) continue;
    const draft: TerritorialOffer = { id: -1, proposerId: a, targetId: b, offered: [offered.regionId], requested: [wanted.regionId],
      createdAtSlowTick: now, expiresAtSlowTick: now + 60, status: "pending" };
    if (willAcceptTerritorialOffer(world, draft) && territorialValue(world, a, draft.requested) >= territorialValue(world, a, draft.offered) * 0.85) {
      if (proposeTerritorialExchange(world, a, b, draft.offered, draft.requested)) break;
    }
  }
}
