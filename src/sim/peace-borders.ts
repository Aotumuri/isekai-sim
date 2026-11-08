import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import type { WorldState } from "./world-state";
import type { TerritoryTransfer } from "./territory-transfer";
import { getOwnerByMesoId } from "./world-cache";

function components(ids: Set<MesoRegionId>, neighbors: Map<MesoRegionId, MesoRegionId[]>): MesoRegionId[][] {
  const unseen = new Set(ids), result: MesoRegionId[][] = [];
  for (const seed of unseen) {
    unseen.delete(seed);
    const group = [seed];
    for (let i = 0; i < group.length; i++) for (const next of neighbors.get(group[i]) ?? []) {
      if (unseen.delete(next)) group.push(next);
    }
    result.push(group);
  }
  return result;
}

/** Evaluate the final borders of both sides together, including reciprocal exchanges. */
export function getPeaceBorderIssue(world: WorldState, legs: TerritoryTransfer[]): string | null {
  if (!legs.length) return null;
  const before = getOwnerByMesoId(world), after = new Map(before);
  const land = new Set(world.mesoRegions.filter((region) => region.type !== "sea").map((region) => region.id));
  const neighbors = new Map(world.mesoRegions.filter((region) => land.has(region.id))
    .map((region) => [region.id, region.neighbors.filter((next) => land.has(next.id)).map((next) => next.id)]));
  const affected = new Set<NationId>();
  for (const leg of legs) {
    affected.add(leg.from); affected.add(leg.to);
    for (const id of leg.regionIds) after.set(id, leg.to);
  }
  for (const nation of affected) {
    const original = new Set([...land].filter((id) => before.get(id) === nation));
    const final = new Set([...land].filter((id) => after.get(id) === nation));
    const groups = components(final, neighbors);
    const groupById = new Map(groups.flatMap((group, index) => group.map((id) => [id, index] as const)));
    // Existing islands and enclaves are permitted, but no original land component may be cut apart.
    for (const group of components(original, neighbors)) {
      const remainingGroups = new Set(group.filter((id) => final.has(id)).map((id) => groupById.get(id)));
      if (remainingGroups.size > 1) return "This settlement would split a country's remaining territory. Choose a different border.";
    }
    for (const group of groups) {
      if (group.some((id) => original.has(id))) continue;
      // A complete island can change hands overseas. A resource pocket or isolated coastal
      // district on someone else's landmass cannot: its land boundary would touch other land.
      if (group.some((id) => (neighbors.get(id) ?? []).some((next) => !final.has(next)))) {
        return "Ceded districts must connect to the receiving country's territory, or form a complete island. Isolated enclaves are not allowed.";
      }
    }
  }
  return null;
}

/** Grow concessions from valid borders rather than cherry-picking interior resources. */
export function selectPeaceDistricts(world: WorldState, from: NationId, to: NationId, candidates: MesoRegionId[], cap: number): MesoRegionId[] {
  const selected: MesoRegionId[] = [], pending = [...new Set(candidates)];
  while (selected.length < cap) {
    const index = pending.findIndex((id) => !getPeaceBorderIssue(world, [{ from, to, regionIds: [...selected, id] }]));
    if (index < 0) {
      // Multi-district islands must be considered together; no individual district is valid.
      const regions = new Map(world.mesoRegions.map((region) => [region.id, region]));
      const neighbors = new Map(pending.map((id) => [id, (regions.get(id)?.neighbors ?? []).map((next) => next.id)]));
      const island = components(new Set(pending), neighbors).find((group) => group.length + selected.length <= cap &&
        !getPeaceBorderIssue(world, [{ from, to, regionIds: [...selected, ...group] }]));
      if (!island) break;
      selected.push(...island);
      for (const id of island) pending.splice(pending.indexOf(id), 1);
      continue;
    }
    selected.push(pending.splice(index, 1)[0]);
  }
  return selected;
}
