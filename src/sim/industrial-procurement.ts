import type { NationId } from "../worldgen/nation";
import { getDiplomacyState, relationKey } from "./diplomacy";
import { areFactionPartners } from "./factions";
import { purchaseIndustrialResource, resourceReserve, TRADE_RESOURCE_VALUES, type InternationalTradeState } from "./international-trade";
import { militaryFundingCost } from "./military-funding";
import { isNationActive } from "./nation-active";
import type { NationRuntime } from "./nation-runtime";
import { getManualGovernmentId } from "./player-nation";
import { assessIndustrialReserve, INDUSTRIAL_RESOURCES, type IndustrialResource } from "./resource-planning";
import { daysToSlowTicks } from "./time";
import { isTradeEmbargoed } from "./trade-embargo";
import { buildWarAdjacency } from "./war-state";
import { getAdjacentNationPairs, getPortTargetsByNation } from "./world-cache";
import type { WorldState } from "./world-state";

const REVIEW_INTERVAL = daysToSlowTicks(50);
const FAILED_ROUTE_RETRY = daysToSlowTicks(150);
const SUPPLIERS_PER_RESOURCE = 3;
const ROUTE_ATTEMPTS_PER_BUYER = 6;

interface Offer {
  seller: NationRuntime;
  floor: number;
  fuelFloor: number;
  markup: number;
  score: number;
}

interface Need {
  resource: IndustrialResource;
  quantity: number;
  priority: number;
  offers: Offer[];
}

interface ProcurementPlan {
  nation: NationRuntime;
  cashReserve: number;
  needs: Need[];
  exportFloors: Map<IndustrialResource, number>;
}

type ProcurementStats = NonNullable<InternationalTradeState["procurement"]>;

function reserveCash(nation: NationRuntime, atWar: boolean): number {
  const treasury = nation.treasury!;
  const thrift = nation.character?.thrift ?? 0.5;
  const food = nation.food;
  const foodShortfall = food ? Math.max(0, food.demand * 5 - food.stock, food.demand - food.harvest - (food.levy ?? 0)) : 0;
  return 10 + treasury.lastRevenue * thrift + (atWar ? militaryFundingCost(treasury) : 0) +
    foodShortfall * TRADE_RESOURCE_VALUES.food;
}

function planPurchases(nation: NationRuntime, atWar: boolean, incoming: Set<IndustrialResource> | undefined): ProcurementPlan {
  const cashReserve = reserveCash(nation, atWar);
  const needs: Need[] = [];
  const exportFloors = new Map<IndustrialResource, number>();
  for (const resource of INDUSTRIAL_RESOURCES) {
    if (nation.resources[resource] === undefined) continue;
    const { shortage, target, exportFloor } = assessIndustrialReserve(nation, resource, atWar);
    exportFloors.set(resource, Math.max(exportFloor, resourceReserve(nation, resource)));
    if (nation.treasury!.balance - cashReserve < TRADE_RESOURCE_VALUES[resource] || incoming?.has(resource) ||
      shortage < 1 || shortage < target * 0.15) continue;
    const industry = nation.resourceFlow.industry;
    const operational = resource === "fuel" && (industry?.fuelDemand ?? 0) > (industry?.output.fuel ?? 0);
    const military = resource === "weapons" && atWar;
    const prototype = (industry?.researchDemand?.[resource] ?? 0) > 0;
    const importance = operational ? (atWar ? 5 : 3) : military ? 4 :
      prototype ? 1 + (nation.character?.innovation ?? 0.5) : 1;
    needs.push({ resource, quantity: shortage, priority: importance * shortage / target, offers: [] });
  }
  needs.sort((a, b) => b.priority - a.priority);
  return { nation, cashReserve, needs, exportFloors };
}

function considerSupplier(buyer: ProcurementPlan, seller: ProcurementPlan, landNeighbor: boolean, trust: number): void {
  const fuelFloor = seller.exportFloors.get("fuel")!;
  if (!landNeighbor && seller.nation.resources.fuel < fuelFloor + 2) return;
  const markup = 1.05 + (1 - (seller.nation.character?.cooperation ?? 0.5)) * 0.1;
  for (const need of buyer.needs) {
    const { resource } = need;
    const floor = seller.exportFloors.get(resource);
    if (floor === undefined) continue;
    const surplus = (seller.nation.resources[resource] ?? 0) - floor;
    if (surplus < 1) continue;
    const score = Math.min(1, surplus / need.quantity) + (landNeighbor ? 1 : 0) + trust / 200 - (markup - 1);
    const offers = need.offers;
    const index = offers.findIndex((offer) => score > offer.score);
    if (index < 0 && offers.length === SUPPLIERS_PER_RESOURCE) continue;
    offers.splice(index < 0 ? offers.length : index, 0, { seller: seller.nation, floor, fuelFloor, markup, score });
    if (offers.length > SUPPLIERS_PER_RESOURCE) offers.pop();
  }
}

function findSuppliers(world: WorldState, plans: Map<NationId, ProcurementPlan>, excluded: ReadonlySet<string>): void {
  const adjacency = new Set(getAdjacentNationPairs(world).map(([a, b]) => relationKey(a, b)));
  const ports = getPortTargetsByNation(world);
  const wars = buildWarAdjacency(world.wars);
  for (const [key, relation] of getDiplomacyState(world).relations) {
    const a = plans.get(relation.nationAId), b = plans.get(relation.nationBId);
    if (!a || !b || (!a.needs.length && !b.needs.length) || excluded.has(key) || relation.crisis ||
      wars.get(a.nation.id)?.has(b.nation.id)) continue;
    const landNeighbor = adjacency.has(key);
    if (!landNeighbor && (!ports.get(a.nation.id)?.length || !ports.get(b.nation.id)?.length)) continue;
    const agreement = relation.treaties.some(({ type, expiresAtSlowTick }) =>
      (type === "trade" || type === "alliance") && expiresAtSlowTick > world.time.slowTick);
    if ((!agreement && !areFactionPartners(world, a.nation.id, b.nation.id)) ||
      isTradeEmbargoed(world, a.nation.id, b.nation.id)) continue;
    if (a.needs.length) considerSupplier(a, b, landNeighbor, relation.trust);
    if (b.needs.length) considerSupplier(b, a, landNeighbor, relation.trust);
  }
}

export function updateIndustrialProcurement(world: WorldState, state: InternationalTradeState): void {
  const stats = state.procurement ??= { lastReview: -REVIEW_INTERVAL, attempted: 0,
    dispatched: 0, delivered: 0, returned: 0, paid: 0, quantities: {}, retryAfter: new Map() };
  if (world.time.slowTick - stats.lastReview < REVIEW_INTERVAL) return;
  stats.lastReview = world.time.slowTick;
  const startedAt = world.instrumentation ? performance.now() : 0;
  runProcurementReview(world, state, stats);
  world.instrumentation?.recordDuration("trade.procurement", performance.now() - startedAt);
}

function runProcurementReview(world: WorldState, state: InternationalTradeState, stats: ProcurementStats): void {
  for (const [pair, retryAt] of stats.retryAfter) {
    if (retryAt <= world.time.slowTick) stats.retryAfter.delete(pair);
  }
  const arrivals = new Map<NationId, Set<IndustrialResource>>();
  const busyPairs = new Set<string>();
  for (const deal of state.deals) {
    if (deal.status !== "in-transit") continue;
    busyPairs.add(relationKey(deal.sellerId, deal.buyerId));
    for (const [recipient, resource] of [
      [deal.buyerId, deal.offeredResource],
      [deal.sellerId, deal.requestedResource],
    ] as const) {
      if (!(INDUSTRIAL_RESOURCES as readonly string[]).includes(resource)) continue;
      const stock = arrivals.get(recipient) ?? new Set<IndustrialResource>();
      stock.add(resource as IndustrialResource);
      arrivals.set(recipient, stock);
    }
  }
  if (busyPairs.size >= 32) return;
  const wars = buildWarAdjacency(world.wars), manual = getManualGovernmentId(world);
  const plans = new Map<NationId, ProcurementPlan>();
  for (const nation of world.nations) if (nation.id !== manual && nation.treasury && isNationActive(nation)) {
    plans.set(nation.id, planPurchases(nation, wars.has(nation.id), arrivals.get(nation.id)));
  }
  const buyers = [...plans.values()].filter((plan) => plan.needs.length);
  if (!buyers.length) return;
  const excluded = new Set(busyPairs);
  for (const pair of stats.retryAfter.keys()) excluded.add(pair);
  findSuppliers(world, plans, excluded);
  buyers.sort((a, b) => b.needs[0]!.priority - a.needs[0]!.priority);
  for (const { nation, needs, cashReserve } of buyers) {
    let attempts = 0;
    purchase: for (const { resource, quantity, offers } of needs) {
      for (const { seller, floor, fuelFloor, markup } of offers) {
        const pair = relationKey(seller.id, nation.id);
        if (excluded.has(pair) || (seller.resources[resource] ?? 0) - floor < 1) continue;
        if (attempts++ >= ROUTE_ATTEMPTS_PER_BUYER) break purchase;
        stats.attempted++;
        const dispatched = purchaseIndustrialResource(world, seller, nation, resource, quantity,
          { exportFloor: floor, sellerFuelReserve: fuelFloor, cashReserve, markup });
        if (dispatched === true) {
          stats.dispatched++;
          busyPairs.add(pair);
          excluded.add(pair);
          break purchase;
        }
        if (dispatched === "no-route") {
          stats.retryAfter.set(pair, world.time.slowTick + FAILED_ROUTE_RETRY);
          excluded.add(pair);
        }
      }
    }
    if (busyPairs.size >= 32) break;
  }
}
