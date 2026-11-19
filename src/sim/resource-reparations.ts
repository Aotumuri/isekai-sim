import { STRATEGIC_RESOURCES } from "../data/strategic-resources";
import { getRelation } from "./diplomacy";
import { changeResource, resourceReserve } from "./international-trade";
import type { NationRuntime } from "./nation-runtime";
import { isNationActive } from "./nation-active";
import { recordSimulationEvent } from "./simulation-settings";
import { recordTreatyIncident } from "./treaty-credibility";
import { findWar } from "./war-state";
import type { WorldState } from "./world-state";
import type { NationId } from "../worldgen/nation";

export const REPARATION_RESOURCES = ["steel", "fuel", ...STRATEGIC_RESOURCES] as const;
export const REPARATION_INTERVAL = 30;
const MAX_INSTALLMENT = 10;
export interface ResourceReparation {
  resource: typeof REPARATION_RESOURCES[number];
  amount: number;
}
export interface ResourceReparationTreaty extends ResourceReparation {
  payerId: NationId;
  recipientId: NationId;
  nextPaymentAt: number;
  expiresAt: number;
  lastPayment?: { paid: number };
}

export function isValidResourceReparation(term: ResourceReparation): boolean {
  return !!term && REPARATION_RESOURCES.includes(term.resource) &&
    Number.isInteger(term.amount) && term.amount >= 1 && term.amount <= MAX_INSTALLMENT;
}

function paymentCapacity(world: WorldState, payer: NationRuntime, resource: ResourceReparation["resource"], deliveries: number): number {
  const stock = payer.resources[resource] ?? 0;
  const surplus = payer.resourceFlow.productionSurplus?.[resource] ?? 0;
  const horizon = world.time.slowTick + deliveries * REPARATION_INTERVAL;
  const committed = (world.resourceReparations ?? []).reduce((total, treaty) => {
    if (treaty.payerId !== payer.id || treaty.resource !== resource || treaty.nextPaymentAt > horizon ||
      !activeRecipient(world, treaty, world.time.slowTick)) return total;
    const last = Math.min(horizon, treaty.expiresAt - 1);
    return total + treaty.amount * Math.max(0, 1 + Math.floor((last - treaty.nextPaymentAt) / REPARATION_INTERVAL));
  }, 0);
  return Math.max(0, stock + surplus * deliveries * REPARATION_INTERVAL - committed);
}

function deliveryCount(truceSeconds: number): number {
  // A delivery scheduled exactly at expiry is canceled.
  return Math.max(0, Math.ceil(truceSeconds / REPARATION_INTERVAL) - 1);
}

/** Share of the payer's estimated capacity committed through the last scheduled payment. */
export function resourceReparationBurden(world: WorldState, payer: NationRuntime, term: ResourceReparation, truceSeconds: number): number {
  const deliveries = deliveryCount(truceSeconds);
  return Math.min(1, term.amount * deliveries / Math.max(1, paymentCapacity(world, payer, term.resource, deliveries)));
}

export function chooseResourceReparation(world: WorldState, creditor: NationRuntime, payer: NationRuntime,
  truceSeconds: number): ResourceReparation | undefined {
  const deliveries = deliveryCount(truceSeconds);
  if (!deliveries) return;
  let choice: ResourceReparation | undefined;
  let usefulness = 0;
  for (const resource of REPARATION_RESOURCES) {
    if (creditor.resources[resource] === undefined || payer.resources[resource] === undefined) continue;
    const reserve = resourceReserve(creditor, resource);
    const projectedStock = creditor.resources[resource]! + (creditor.resourceFlow.productionSurplus?.[resource] ?? 0) * REPARATION_INTERVAL;
    const shortage = reserve - projectedStock;
    if (shortage < 1) continue;
    // Leave at least half of projected capacity available to the defeated economy.
    const amount = Math.floor(Math.min(MAX_INSTALLMENT, shortage, paymentCapacity(world, payer, resource, 1),
      paymentCapacity(world, payer, resource, deliveries) / (2 * deliveries)));
    const value = amount / reserve;
    if (value <= usefulness) continue;
    choice = { resource, amount };
    usefulness = value;
  }
  return choice;
}

function activeRecipient(world: WorldState, treaty: ResourceReparationTreaty, now: number): NationRuntime | undefined {
  if (now >= treaty.expiresAt || findWar(world.wars, treaty.payerId, treaty.recipientId)) return;
  return world.nations.find((nation) => nation.id === treaty.recipientId && isNationActive(nation));
}

interface PaymentBatch {
  payer: NationRuntime;
  resource: ResourceReparation["resource"];
  stock: number;
  due: { treaty: ResourceReparationTreaty; recipient: NationRuntime }[];
}

function settlePayments(world: WorldState, { payer, resource, stock, due }: PaymentBatch, now: number): void {
  const promised = due.reduce((total, { treaty }) => total + treaty.amount, 0);
  const budget = Math.min(promised, stock);
  if (budget > 0) changeResource(payer, resource, -budget);
  let remaining = budget;
  for (const [index, { treaty, recipient }] of due.entries()) {
    const paid = index === due.length - 1 ? Math.min(treaty.amount, remaining) : Math.min(remaining, treaty.amount * (budget / promised));
    remaining -= paid;
    if (paid > 0) changeResource(recipient, resource, paid);
    treaty.nextPaymentAt = now + REPARATION_INTERVAL;
    treaty.lastPayment = { paid };
    const missed = 1 - paid / treaty.amount;
    if (missed > 1e-8) {
      const relation = getRelation(world, payer.id, recipient.id);
      relation.trust = Math.max(0, relation.trust - 3 * missed);
      relation.grievance = Math.min(100, relation.grievance + 2 * missed);
      recordTreatyIncident(payer, now, 1.5 * missed);
    }
    recordSimulationEvent(world, { category: "diplomacy", nationIds: [payer.id, recipient.id],
      message: `${payer.id} delivered ${paid.toFixed(1)} / ${treaty.amount} ${resource} in reparations to ${recipient.id}.${missed > 1e-8 ? " The shortfall damaged trust." : ""}` });
  }
}

export function updateResourceReparations(world: WorldState): void {
  const treaties = world.resourceReparations;
  if (!treaties?.length) return;
  const now = world.time.slowTick;
  const batches = new Map<string, PaymentBatch>();
  world.resourceReparations = treaties.filter((treaty) => {
    const recipient = activeRecipient(world, treaty, now);
    const payer = recipient && world.nations.find((nation) => nation.id === treaty.payerId && isNationActive(nation));
    if (!payer || !recipient) return false;
    if (now < treaty.nextPaymentAt) return true;
    const key = `${payer.id}:${treaty.resource}`;
    let batch = batches.get(key);
    if (!batch) {
      batch = { payer, resource: treaty.resource, stock: Math.max(0, payer.resources[treaty.resource] ?? 0), due: [] };
      batches.set(key, batch);
    }
    batch.due.push({ treaty, recipient });
    return true;
  });
  for (const batch of batches.values()) settlePayments(world, batch, now);
}
