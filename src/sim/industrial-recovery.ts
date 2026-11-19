import type { MesoRegion, MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import { seekReconstructionGrant } from "./financial-aid";
import { changeResource, resourceReserve } from "./international-trade";
import { getManualGovernmentId } from "./player-nation";
import { PUBLIC_WORKS } from "./public-works";
import { recordSimulationEvent } from "./simulation-settings";
import { isNationRegionSupplied } from "./supply-assessment";
import { spendTreasury, TAX_COLLECTION_INTERVAL } from "./treasury";
import { getMesoById, getOwnerByMesoId } from "./world-cache";
import type { WorldState } from "./world-state";

const RECOVERY_DURATION = 60;
const RESTORATION_COST = { cash: PUBLIC_WORKS.city.cash / 5, steel: PUBLIC_WORKS.city.steel / 5 };

export interface IndustrialRecovery {
  owner: NationId;
  remaining: number;
  lastTick: number;
  funded?: boolean;
}

export function recordIndustrialRecovery(world: WorldState, region: MesoRegion, owner: NationId): boolean {
  if (!region.resource && region.building !== "city" && region.building !== "capital") return false;
  (world.industrialRecovery ??= new Map()).set(region.id, { owner, remaining: RECOVERY_DURATION, lastTick: world.time.slowTick });
  return true;
}

export function industrialRecoveryFactor(world: WorldState, owner: NationId, id: MesoRegionId): number {
  const state = world.industrialRecovery?.get(id);
  return state?.owner === owner ? 1 - 0.5 * state.remaining / RECOVERY_DURATION : 1;
}

export function updateIndustrialRecovery(world: WorldState): void {
  const recovery = world.industrialRecovery;
  if (!recovery?.size) return;
  const now = world.time.slowTick;
  const reviewBudgets = now % TAX_COLLECTION_INTERVAL === 0;
  const owners = getOwnerByMesoId(world), regions = getMesoById(world);
  const priorities = new Map<NationId, { id: MesoRegionId; state: IndustrialRecovery; score: number }>();
  for (const [id, state] of recovery) {
    const region = regions.get(id);
    if (!region || owners.get(id) !== state.owner) { recovery.delete(id); continue; }
    const elapsed = Math.max(0, now - state.lastTick);
    state.lastTick = now;
    const controller = world.occupation.mesoById.get(id);
    if (controller && controller !== state.owner || !isNationRegionSupplied(world, state.owner, id)) continue;
    state.remaining = Math.max(0, state.remaining - elapsed);
    if (!state.remaining) { recovery.delete(id); continue; }
    if (!elapsed || !reviewBudgets || state.funded || state.remaining < RECOVERY_DURATION / 2) continue;
    const productiveWeight = region.building === "capital" ? 2 : region.building === "city" ? 1.5 : 1;
    const score = state.remaining * productiveWeight;
    const prior = priorities.get(state.owner);
    if (!prior || score > prior.score || score === prior.score && id < prior.id) priorities.set(state.owner, { id, state, score });
  }
  const manual = priorities.size ? getManualGovernmentId(world) : undefined;
  const rebuilding = new Set(priorities.keys());
  for (const nation of world.nations) {
    const project = priorities.get(nation.id);
    if (!project || nation.id === manual || !nation.treasury ||
      nation.resources.steel < RESTORATION_COST.steel + resourceReserve(nation, "steel")) continue;
    const cashNeeded = RESTORATION_COST.cash + resourceReserve(nation, "cash");
    if (nation.treasury.balance < cashNeeded && !seekReconstructionGrant(world, nation.id, rebuilding)) continue;
    if (!spendTreasury(nation.treasury, "construction", RESTORATION_COST.cash)) continue;
    changeResource(nation, "steel", -RESTORATION_COST.steel);
    project.state.funded = true;
    project.state.remaining /= 2;
    recordSimulationEvent(world, { category: "politics", nationIds: [nation.id],
      message: `${nation.id} funded the restart of industry in District ${project.id.replace("meso-", "")}, halving the remaining recovery time.` });
  }
}
