import { getHomelandClaimBonus } from "./population-politics";
import { getNationalistClaimBonus } from "./nationalist-movements";
import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import type { WorldState } from "./world-state";
import { getOwnerByMesoId, getMesoById } from "./world-cache";
import { getRelation } from "./diplomacy";
import { getNationCharacter } from "./nation-character";
import { recordSimulationEvent } from "./simulation-settings";

export interface TerritorialMemory { heldTicks: number; attachment: number }
export interface TerritorialClaimsState {
  history: Map<MesoRegionId, Map<NationId, TerritorialMemory>>;
  owners: Map<MesoRegionId, NationId>;
  controllers: Map<MesoRegionId, NationId>;
  lastSlowTick: number;
  version: number;
}
export function getTerritorialClaims(world: WorldState): TerritorialClaimsState {
  if (world.territorialClaims) return world.territorialClaims;
  const owners = new Map(getOwnerByMesoId(world));
  const history = new Map<MesoRegionId, Map<NationId, TerritorialMemory>>();
  for (const [id, owner] of owners) history.set(id, new Map([[owner, { heldTicks: 0, attachment: 20 }]]));
  return world.territorialClaims = { history, owners, controllers: new Map(owners), lastSlowTick: world.time.slowTick, version: 0 };
}

/** Claims express political preferences; they never automatically change ownership. */
export function getTerritorialClaim(world: WorldState, nationId: NationId, regionId: MesoRegionId): number {
  const memory = getTerritorialClaims(world).history.get(regionId)?.get(nationId);
  const region = getMesoById(world).get(regionId);
  if (!region || region.type === "sea") return 0;
  const owners = getOwnerByMesoId(world);
  const nearby = owners.get(regionId) === nationId || region.neighbors.some((item) => owners.get(item.id) === nationId);
  const nationalistBonus = getNationalistClaimBonus(world, nationId, regionId);
  if (!memory && !nearby && !nationalistBonus) return 0;
  const character = getNationCharacter(world, nationId);
  return Math.min(100, nationalistBonus + (memory?.attachment ?? 0) + (region.resource ? 18 + character.thrift * 10 : 0) +
    (nearby ? 8 + character.aggression * 8 + getHomelandClaimBonus(world, nationId, regionId) : 0));
}
export function getForeignClaims(world: WorldState, nationId: NationId, ownerId?: NationId): { regionId: MesoRegionId; strength: number; heldTicks: number }[] {
  const state = getTerritorialClaims(world), result: { regionId: MesoRegionId; strength: number; heldTicks: number }[] = [];
  for (const [id, owner] of getOwnerByMesoId(world)) {
    if (owner === nationId || (ownerId && owner !== ownerId)) continue;
    const strength = getTerritorialClaim(world, nationId, id);
    if (strength >= 20) result.push({ regionId: id, strength, heldTicks: state.history.get(id)?.get(nationId)?.heldTicks ?? 0 });
  }
  return result.sort((a, b) => b.strength - a.strength || a.regionId.localeCompare(b.regionId));
}

/** A revolutionary government shares the parent's historical claims and keeps tenure in its own territory. */
export function inheritTerritorialClaims(
  world: WorldState,
  parentId: NationId,
  rebelId: NationId,
  rebelRegionIds: ReadonlySet<MesoRegionId>,
): void {
  const state = getTerritorialClaims(world);
  for (const [id, memories] of state.history) {
    const memory = memories.get(parentId);
    if (!memory || memories.has(rebelId)) continue;
    if (state.owners.get(id) === parentId && !rebelRegionIds.has(id)) continue;
    memories.set(rebelId, { ...memory });
  }
  state.version += 1;
}

/** Snapshot before a transfer; consenting nations do not resent their own agreed cessions. */
export function updateTerritorialClaims(world: WorldState, consenting: ReadonlySet<NationId> = new Set()): void {
  const state = getTerritorialClaims(world), owners = getOwnerByMesoId(world);
  const elapsed = Math.max(0, world.time.slowTick - state.lastSlowTick);
  const damage = new Map<string, { loser: NationId; taker: NationId; severity: number; count: number }>();
  const resent = (loser: NationId, taker: NationId, id: MesoRegionId, multiplier: number) => {
    if (loser === taker || consenting.has(loser)) return;
    const key = `${loser}:${taker}`, old = damage.get(key);
    const severity = (4 + getTerritorialClaim(world, loser, id) * 0.14) * multiplier;
    damage.set(key, { loser, taker, severity: (old?.severity ?? 0) + severity, count: (old?.count ?? 0) + 1 });
  };
  for (const [id, owner] of owners) {
    const oldOwner = state.owners.get(id);
    const memories = state.history.get(id) ?? new Map<NationId, TerritorialMemory>();
    // Elapsed tenure belongs to the previous owner, not the new recipient.
    if (oldOwner) {
      const memory = memories.get(oldOwner) ?? { heldTicks: 0, attachment: 20 };
      memory.heldTicks += elapsed; memory.attachment = Math.min(90, 20 + memory.heldTicks * 0.08);
      memories.set(oldOwner, memory);
    }
    if (!memories.has(owner)) memories.set(owner, { heldTicks: 0, attachment: 20 });
    state.history.set(id, memories);
    if (oldOwner && oldOwner !== owner) {
      resent(oldOwner, owner, id, 1);
      for (const [claimant, memory] of memories) if (claimant !== oldOwner && claimant !== owner && memory.attachment >= 40) resent(claimant, owner, id, 0.25);
    }
    const controller = world.occupation.mesoById.get(id) ?? owner;
    if (controller !== owner && controller !== state.controllers.get(id)) resent(owner, controller, id, 0.5);
    state.controllers.set(id, controller);
  }
  for (const item of damage.values()) {
    const relation = getRelation(world, item.loser, item.taker), penalty = Math.min(45, item.severity);
    relation.opinion = Math.max(-100, relation.opinion - penalty);
    relation.grievance = Math.min(100, relation.grievance + penalty);
    relation.tension = Math.min(100, relation.tension + penalty * 0.6);
    recordSimulationEvent(world, { category: "diplomacy", nationIds: [item.loser, item.taker],
      message: `${item.loser} resented territorial losses to ${item.taker} (${item.count} regions).` });
  }
  state.owners = new Map(owners); state.lastSlowTick = world.time.slowTick;
  if (elapsed || damage.size) state.version += 1;
}
