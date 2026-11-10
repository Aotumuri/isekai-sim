import { STRATEGIC_RESOURCES } from "../data/strategic-resources";
import { changeResource } from "./international-trade";
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
