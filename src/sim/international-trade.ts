import { exchangePortPopulation } from "./population-migration";
import { areFactionPartners } from "./factions";
import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import { getDiplomacyState, getRelation, hasTreaty } from "./diplomacy";
import { isOperationalCombatShip } from "./maritime-escort";
import { buildNavalPositioningRoute } from "./naval-pathfinding";
import { isNationActive } from "./nation-active";
import type { NationRuntime } from "./nation-runtime";
import { getWarDeclarationMode, recordSimulationEvent } from "./simulation-settings";
import { isNationRegionSupplied } from "./supply-assessment";
import { getMesoById, getNeighborsById, getOwnerByMesoId, getPortTargetsByNation } from "./world-cache";
import { buildWarAdjacency, isAtWar } from "./war-state";
import { getUnitCombatStrength } from "./unit-strength";
import type { WorldState } from "./world-state";

export const TRADE_RESOURCES = ["steel", "fuel", "weapons"] as const;
export type TradeResource = typeof TRADE_RESOURCES[number];
export interface TradeRoute { regionIds: MesoRegionId[]; maritime: boolean }
export interface TradeDeal {
  id: string; sellerId: NationId; buyerId: NationId;
  offeredResource: TradeResource; requestedResource: TradeResource;
  offeredAmount: number; requestedAmount: number; route: TradeRoute;
  rerouted?: boolean;
  arrivesAtSlowTick: number; status: "in-transit" | "delivered" | "returned";
}
export interface InternationalTradeState {
  deals: TradeDeal[]; nextDealNumber: number; lastSlowTick: number; lastAISlowTick: number;
  delivered: number; returned: number; fuelSpent: number;
}
export function getInternationalTradeState(world: WorldState): InternationalTradeState {
  return world.internationalTrade ??= { deals: [], nextDealNumber: 0, lastSlowTick: -1,
    lastAISlowTick: -20, delivered: 0, returned: 0, fuelSpent: 0 };
}
export function changeResource(nation: NationRuntime, resource: TradeResource, amount: number): void {
  nation.resources[resource] += amount;
  nation.resourceFlow.delta[resource] += amount;
  if (amount >= 0) nation.resourceFlow.income[resource] += amount;
  else nation.resourceFlow.usage[resource] -= amount;
}
export function resourceReserve(nation: NationRuntime, resource: TradeResource): number {
  return resource === "fuel" ? Math.max(20, nation.resourceFlow.usage.fuel * 5) : resource === "weapons" ? 25 : 20;
}

/** Civilian trade charters have their own fuel cost; they do not steal military transports. */
export function findTradeRoute(world: WorldState, a: NationId, b: NationId): TradeRoute | null {
  const first = world.nations.find((nation) => nation.id === a && isNationActive(nation));
  const second = world.nations.find((nation) => nation.id === b && isNationActive(nation));
  if (!first || !second || a === b || isAtWar(a, b, buildWarAdjacency(world.wars))) return null;
  if (!isNationRegionSupplied(world, a, first.capitalMesoId) || !isNationRegionSupplied(world, b, second.capitalMesoId)) return null;
  const regions = getMesoById(world), neighbors = getNeighborsById(world), owners = getOwnerByMesoId(world);
  const owner = (id: MesoRegionId) => world.occupation.mesoById.get(id) ?? owners.get(id);
  const queue = [first.capitalMesoId], previous = new Map<MesoRegionId, MesoRegionId | null>([[first.capitalMesoId, null]]);
  for (let index = 0; index < queue.length && !previous.has(second.capitalMesoId); index += 1) {
    for (const next of neighbors.get(queue[index]!) ?? []) {
      if (previous.has(next) || regions.get(next)?.type === "sea" || (owner(next) !== a && owner(next) !== b)) continue;
      previous.set(next, queue[index]!); queue.push(next);
    }
  }
  if (previous.has(second.capitalMesoId)) {
    const path: MesoRegionId[] = [];
    for (let id: MesoRegionId | null = second.capitalMesoId; id; id = previous.get(id) ?? null) path.push(id);
    return { regionIds: path.reverse(), maritime: false };
  }
  const ports = getPortTargetsByNation(world);
  let best: MesoRegionId[] | null = null;
  for (const source of ports.get(a) ?? []) {
    if (!isNationRegionSupplied(world, a, source)) continue;
    for (const destination of ports.get(b) ?? []) {
      if (!isNationRegionSupplied(world, b, destination)) continue;
      const path = buildNavalPositioningRoute(world, source, [destination]);
      if (path.length < 3 || path.slice(1, -1).some((id) => regions.get(id)?.type !== "sea")) continue;
      const route = { regionIds: path, maritime: true };
      if (isTradeRouteOpen(world, a, b, route) && (!best || path.length < best.length)) best = path;
    }
  }
  return best ? { regionIds: best, maritime: true } : null;
}

export function isTradeRouteOpen(world: WorldState, a: NationId, b: NationId, route: TradeRoute): boolean {
  const wars = buildWarAdjacency(world.wars), regions = getMesoById(world), owners = getOwnerByMesoId(world);
  if (isAtWar(a, b, wars) || route.regionIds.length < 2) return false;
  const owner = (id: MesoRegionId) => world.occupation.mesoById.get(id) ?? owners.get(id);
  if (owner(route.regionIds[0]!) !== a || owner(route.regionIds.at(-1)!) !== b) return false;
  if (!isNationRegionSupplied(world, a, route.regionIds[0]!) || !isNationRegionSupplied(world, b, route.regionIds.at(-1)!)) return false;
  if (route.maritime && (regions.get(route.regionIds[0]!)?.building !== "port" || regions.get(route.regionIds.at(-1)!)?.building !== "port")) return false;
  for (let index = 0; index < route.regionIds.length; index += 1) {
    const id = route.regionIds[index]!;
    if (!regions.has(id) || (index > 0 && !(getNeighborsById(world).get(route.regionIds[index - 1]!) ?? []).includes(id))) return false;
    if (!route.maritime && regions.get(id)?.type === "sea") return false;
    if (route.maritime && index > 0 && index < route.regionIds.length - 1 && regions.get(id)?.type !== "sea") return false;
    if (regions.get(id)?.type !== "sea") {
      if (owner(id) !== a && owner(id) !== b) return false;
      continue;
    }
    const local = world.units.filter((unit) => unit.regionId === id && isOperationalCombatShip(unit) && unit.combatPower > 0);
    const hostile = local.filter((unit) => isAtWar(a, unit.nationId, wars) || isAtWar(b, unit.nationId, wars))
      .reduce((sum, unit) => sum + getUnitCombatStrength(unit), 0);
    const escort = local.filter((unit) => unit.nationId === a || unit.nationId === b)
      .reduce((sum, unit) => sum + getUnitCombatStrength(unit), 0);
    if (hostile > escort) return false;
  }
  return true;
}

export const TRADE_RESOURCE_VALUES: Record<TradeResource, number> = { steel: 1, fuel: 1.4, weapons: 2.4 };
export function proposeResourceTrade(world: WorldState, sellerId: NationId, buyerId: NationId,
  offeredResource: TradeResource, offeredAmount: number, requestedResource: TradeResource, requestedAmount: number): boolean {
  if (getWarDeclarationMode(world) !== "diplomacy" || !world.settings?.tradeEnabled || sellerId === buyerId ||
    offeredResource === requestedResource || !TRADE_RESOURCES.includes(offeredResource) || !TRADE_RESOURCES.includes(requestedResource) ||
    !Number.isFinite(offeredAmount) || !Number.isFinite(requestedAmount) || offeredAmount <= 0 || requestedAmount <= 0) return false;
  if (!areFactionPartners(world, sellerId, buyerId) && !hasTreaty(world, sellerId, buyerId, "trade") && !hasTreaty(world, sellerId, buyerId, "alliance")) return false;
  const ratio = offeredAmount * TRADE_RESOURCE_VALUES[offeredResource] / (requestedAmount * TRADE_RESOURCE_VALUES[requestedResource]);
  if (ratio < 0.8 || ratio > 1.25) return false;
  const state = getInternationalTradeState(world);
  if (state.deals.filter((deal) => deal.status === "in-transit").length >= 32 || state.deals.some((deal) => deal.status === "in-transit" &&
    ((deal.sellerId === sellerId && deal.buyerId === buyerId) || (deal.sellerId === buyerId && deal.buyerId === sellerId)))) return false;
  const seller = world.nations.find((nation) => nation.id === sellerId && isNationActive(nation));
  const buyer = world.nations.find((nation) => nation.id === buyerId && isNationActive(nation));
  if (!seller || !buyer || seller.resources[offeredResource] < offeredAmount + resourceReserve(seller, offeredResource) ||
    buyer.resources[requestedResource] < requestedAmount + resourceReserve(buyer, requestedResource)) return false;
  const route = findTradeRoute(world, sellerId, buyerId);
  if (!route) return false;
  const shippingFuel = shippingFuelFor(route);
  const carrier = [seller, buyer].find((nation) => nation.resources.fuel -
    (nation.id === sellerId && offeredResource === "fuel" ? offeredAmount : nation.id === buyerId && requestedResource === "fuel" ? requestedAmount : 0) >= shippingFuel);
  if (shippingFuel > 0 && !carrier) return false;
  changeResource(seller, offeredResource, -offeredAmount); changeResource(buyer, requestedResource, -requestedAmount);
  if (shippingFuel > 0) { changeResource(carrier!, "fuel", -shippingFuel); state.fuelSpent += shippingFuel; }
  state.deals.push({ id: `trade-${state.nextDealNumber++}`, sellerId, buyerId, offeredResource, offeredAmount,
    requestedResource, requestedAmount, route, arrivesAtSlowTick: world.time.slowTick + transitTicks(route), status: "in-transit" });
  recordSimulationEvent(world, { category: "trade", nationIds: [sellerId, buyerId],
    message: `${sellerId} dispatched ${offeredAmount.toFixed(1)} ${offeredResource} for ${requestedAmount.toFixed(1)} ${requestedResource} from ${buyerId}.` });
  return true;
}

function rerouteTrade(world: WorldState, deal: TradeDeal, seller: NationRuntime, buyer: NationRuntime): boolean {
  if (deal.rerouted) return false;
  const route = findTradeRoute(world, seller.id, buyer.id);
  if (!route || !isTradeRouteOpen(world, seller.id, buyer.id, route)) return false;
  const fuel = shippingFuelFor(route);
  const carrier = [seller, buyer].find((nation) => nation.resources.fuel >= fuel);
  if (fuel > 0 && !carrier) return false;
  if (fuel > 0 && carrier) {
    changeResource(carrier, "fuel", -fuel);
    getInternationalTradeState(world).fuelSpent += fuel;
  }
  deal.route = route;
  deal.rerouted = true;
  deal.arrivesAtSlowTick = world.time.slowTick + transitTicks(route);
  recordSimulationEvent(world, { category: "trade", nationIds: [seller.id, buyer.id],
    message: `${deal.id} was diverted to an alternate route. Delivery is delayed.` });
  return true;
}

function shippingFuelFor(route: TradeRoute): number {
  return route.maritime ? Math.max(2, Math.ceil(route.regionIds.length * 0.1)) : 0;
}

function transitTicks(route: TradeRoute): number {
  return Math.max(3, Math.ceil(route.regionIds.length * 1.5));
}

export function updateInternationalTrade(world: WorldState): void {
  const state = world.internationalTrade;
  if (state && state.lastSlowTick !== world.time.slowTick) {
    state.lastSlowTick = world.time.slowTick;
    for (const deal of state.deals.filter((item) => item.status === "in-transit")) {
      const seller = world.nations.find((nation) => nation.id === deal.sellerId), buyer = world.nations.find((nation) => nation.id === deal.buyerId);
      const agreement = areFactionPartners(world, deal.sellerId, deal.buyerId) || hasTreaty(world, deal.sellerId, deal.buyerId, "trade") || hasTreaty(world, deal.sellerId, deal.buyerId, "alliance");
      const canTrade = world.settings?.diplomacyEnabled && world.settings.tradeEnabled && seller && buyer &&
        isNationActive(seller) && isNationActive(buyer) && agreement;
      const open = canTrade && isTradeRouteOpen(world, deal.sellerId, deal.buyerId, deal.route);
      if (canTrade && !open && rerouteTrade(world, deal, seller, buyer)) continue;
      if (!open) {
        if (seller) changeResource(seller, deal.offeredResource, deal.offeredAmount);
        if (buyer) changeResource(buyer, deal.requestedResource, deal.requestedAmount);
        deal.status = "returned"; state.returned += 1;
        recordSimulationEvent(world, { category: "trade", nationIds: [deal.sellerId, deal.buyerId], message: `${deal.id} returned: route or agreement unavailable.` });
      } else if (world.time.slowTick >= deal.arrivesAtSlowTick) {
        changeResource(buyer!, deal.offeredResource, deal.offeredAmount); changeResource(seller!, deal.requestedResource, deal.requestedAmount);
        if (deal.route.maritime) {
          const from = deal.route.regionIds[0], to = deal.route.regionIds.at(-1);
          if (from && to) exchangePortPopulation(world, from, to);
        }
        deal.status = "delivered"; state.delivered += 1; getDiplomacyState(world).tradeDeliveries += 1;
        const relation = getRelation(world, deal.sellerId, deal.buyerId);
        relation.opinion = Math.min(100, relation.opinion + 2); relation.trust = Math.min(100, relation.trust + 1);
        recordSimulationEvent(world, { category: "trade", nationIds: [deal.sellerId, deal.buyerId], message: `${deal.id} delivered to ${deal.sellerId} and ${deal.buyerId}.` });
      }
    }
    if (state.deals.length > 100) state.deals = [...state.deals.filter((deal) => deal.status !== "in-transit").slice(-68), ...state.deals.filter((deal) => deal.status === "in-transit")];
  }
  if (getWarDeclarationMode(world) !== "diplomacy" || !world.settings?.tradeEnabled) return;
  const trading = getInternationalTradeState(world);
  if (world.time.slowTick - trading.lastAISlowTick < 20) return;
  trading.lastAISlowTick = world.time.slowTick;
  for (const relation of getDiplomacyState(world).relations.values()) {
    const a = world.nations.find((nation) => nation.id === relation.nationAId), b = world.nations.find((nation) => nation.id === relation.nationBId);
    if (!a || !b || relation.crisis) continue;
    const surplus = (nation: NationRuntime, resource: TradeResource) => nation.resources[resource] / resourceReserve(nation, resource);
    const offered = TRADE_RESOURCES.find((resource) => surplus(a, resource) > 1.5 && surplus(b, resource) < surplus(a, resource) * 0.6);
    const requested = TRADE_RESOURCES.find((resource) => resource !== offered && surplus(b, resource) > 1.5 && surplus(a, resource) < surplus(b, resource) * 0.6);
    if (!offered || !requested) continue;
    const amount = Math.min(12, (a.resources[offered] - resourceReserve(a, offered)) * 0.15,
      (b.resources[requested] - resourceReserve(b, requested)) * TRADE_RESOURCE_VALUES[requested] / TRADE_RESOURCE_VALUES[offered] * 0.15);
    if (amount >= 1) proposeResourceTrade(world, a.id, b.id, offered, amount, requested, amount * TRADE_RESOURCE_VALUES[offered] / TRADE_RESOURCE_VALUES[requested]);
  }
}
