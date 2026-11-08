import type { WorldState } from "../sim/world-state";
import type { NationId } from "../worldgen/nation";
import type { MesoRegionId } from "../worldgen/meso-region";
import { getForeignClaims, getTerritorialClaim, getTerritorialClaims } from "../sim/territorial-claims";
import { getMesoById, getOwnerByMesoId } from "../sim/world-cache";

export const CLAIM_COLORS = { home: 0x72b9ed, other: 0x657383, weak: 0xf5cf72, strong: 0xc53648, demand: 0xfff4d6 };
export interface MapClaim { regionId: MesoRegionId; ownerId: NationId; strength: number; heldTicks: number; demanded: boolean }
export function getClaimColor(strength: number): number {
  const weight = Math.max(0, Math.min(1, (strength - 20) / 80));
  return [16, 8, 0].reduce((color, shift) => color | Math.round(((CLAIM_COLORS.weak >> shift) & 255) * (1 - weight) + ((CLAIM_COLORS.strong >> shift) & 255) * weight) << shift, 0);
}
export function getMapClaims(world: WorldState, nationId: NationId): MapClaim[] {
  const owners = getOwnerByMesoId(world), regions = getMesoById(world), history = getTerritorialClaims(world).history;
  const claims = new Map(getForeignClaims(world, nationId).map((claim) => [claim.regionId,
    { ...claim, ownerId: owners.get(claim.regionId)!, demanded: false }]));
  for (const relation of world.diplomacy?.relations.values() ?? []) {
    const crisis = relation.crisis;
    if (crisis?.aggressorId !== nationId || crisis.demand !== "territory") continue;
    for (const regionId of crisis.regionIds ?? []) {
      const ownerId = owners.get(regionId);
      if (!ownerId || ownerId === nationId || regions.get(regionId)?.type === "sea") continue;
      claims.set(regionId, { regionId, ownerId, strength: getTerritorialClaim(world, nationId, regionId),
        heldTicks: history.get(regionId)?.get(nationId)?.heldTicks ?? 0, demanded: true });
    }
  }
  return [...claims.values()].sort((a, b) => b.strength - a.strength || a.regionId.localeCompare(b.regionId));
}
