import { STRATEGIC_RESOURCES } from "../data/strategic-resources";
import { changeResource } from "./international-trade";
import type { NationRuntime } from "./nation-runtime";
import { isNationActive } from "./nation-active";
import { recordSimulationEvent } from "./simulation-settings";
import { findWar } from "./war-state";
import type { WorldState } from "./world-state";
import type { NationId } from "../worldgen/nation";

export const REPARATION_RESOURCES = ["steel", "fuel", ...STRATEGIC_RESOURCES] as const;
export const REPARATION_INTERVAL = 30;
export interface ResourceReparation {
  resource: typeof REPARATION_RESOURCES[number];
  amount: number;
}
export interface ResourceReparationTreaty extends ResourceReparation {
  payerId: NationId;
  recipientId: NationId;
  nextPaymentAt: number;
  expiresAt: number;
}

export function isValidResourceReparation(term: ResourceReparation): boolean {
  return !!term && REPARATION_RESOURCES.includes(term.resource) &&
    Number.isInteger(term.amount) && term.amount >= 1 && term.amount <= 10;
}

/** Share of the payer's estimated capacity committed through the last scheduled payment. */
export function resourceReparationBurden(payer: NationRuntime, term: ResourceReparation, truceSeconds: number): number {
  // The treaty expires before a delivery that falls exactly on its expiry tick.
  const deliveries = Math.max(0, Math.ceil(truceSeconds / REPARATION_INTERVAL) - 1);
  if (deliveries === 0) return 0;
  const stock = payer.resources[term.resource] ?? 0;
  const surplus = payer.resourceFlow.productionSurplus?.[term.resource] ?? 0;
  const capacity = stock + surplus * deliveries * REPARATION_INTERVAL;
  return Math.min(1, term.amount * deliveries / Math.max(1, capacity));
}

export function updateResourceReparations(world: WorldState): void {
  const treaties = world.resourceReparations;
  if (!treaties?.length) return;
  const now = world.time.slowTick;
  world.resourceReparations = treaties.filter((treaty) => {
    if (now >= treaty.expiresAt || findWar(world.wars, treaty.payerId, treaty.recipientId)) return false;
    const payer = world.nations.find(({ id }) => id === treaty.payerId);
    const recipient = world.nations.find(({ id }) => id === treaty.recipientId);
    if (!payer || !recipient || !isNationActive(payer) || !isNationActive(recipient)) return false;
    if (now < treaty.nextPaymentAt) return true;
    treaty.nextPaymentAt = now + REPARATION_INTERVAL;
    const paid = Math.min(treaty.amount, payer.resources[treaty.resource] ?? 0);
    if (paid > 0) {
      changeResource(payer, treaty.resource, -paid);
      changeResource(recipient, treaty.resource, paid);
    }
    recordSimulationEvent(world, { category: "diplomacy", nationIds: [payer.id, recipient.id],
      message: `${payer.id} delivered ${paid.toFixed(1)} / ${treaty.amount} ${treaty.resource} in reparations to ${recipient.id}.` });
    return true;
  });
}
