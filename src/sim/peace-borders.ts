import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import type { WorldState } from "./world-state";
import type { TerritoryTransfer } from "./territory-transfer";
import { getMesoById, getNeighborsById, getOwnerByMesoId } from "./world-cache";

export function connectedRegionGroups(ids: Set<MesoRegionId>, neighbors: Map<MesoRegionId, MesoRegionId[]>): MesoRegionId[][] {
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
    const groups = connectedRegionGroups(final, neighbors);
    const groupById = new Map(groups.flatMap((group, index) => group.map((id) => [id, index] as const)));
    // Existing islands and enclaves are permitted, but no original land component may be cut apart.
    for (const group of connectedRegionGroups(original, neighbors)) {
      const remainingGroups = new Set(group.filter((id) => final.has(id)).map((id) => groupById.get(id)));
      if (remainingGroups.size > 1) return "この合意では残る領土が分断されます。別の境界線を選んでください。";
    }
    for (const group of groups) {
      if (group.some((id) => original.has(id))) continue;
      // A complete island can change hands overseas. A resource pocket or isolated coastal
      // district on someone else's landmass cannot: its land boundary would touch other land.
      if (group.some((id) => (neighbors.get(id) ?? []).some((next) => !final.has(next)))) {
        return "譲渡する地区は受け取る国の領土に接するか、島全体を構成する必要があります。飛び地は認められません。";
      }
    }
  }
  return null;
}

/** Grow concessions from valid borders rather than cherry-picking interior resources. */
export function selectPeaceDistricts(world: WorldState, from: NationId, to: NationId, candidates: MesoRegionId[], cap: number): MesoRegionId[] {
  const selected: MesoRegionId[] = [], pending = [...new Set(candidates)];
  const selectedSet = new Set<MesoRegionId>();
  while (selected.length < cap) {
    const ranked = pending.map((id) => ({ id, improvement: borderImprovement(world, from, to, [id], selectedSet) }))
      .sort((a, b) => b.improvement - a.improvement).map(({ id }) => id);
    const next = ranked.find((id) => !getPeaceBorderIssue(world, [{ from, to, regionIds: [...selected, id] }]));
    const index = next === undefined ? -1 : pending.indexOf(next);
    if (index < 0) {
      // Multi-district islands must be considered together; no individual district is valid.
      const regions = getMesoById(world);
      const neighbors = new Map(pending.map((id) => [id, (regions.get(id)?.neighbors ?? []).map((next) => next.id)]));
      const island = connectedRegionGroups(new Set(pending), neighbors).find((group) => group.length + selected.length <= cap &&
        !getPeaceBorderIssue(world, [{ from, to, regionIds: [...selected, ...group] }]));
      if (!island) break;
      selected.push(...island);
      for (const id of island) { selectedSet.add(id); pending.splice(pending.indexOf(id), 1); }
      continue;
    }
    const [id] = pending.splice(index, 1);
    selectedSet.add(id);
    selected.push(id);
  }
  return selected;
}

function borderImprovement(world: WorldState, from: NationId, to: NationId, ids: MesoRegionId[], selected: Set<MesoRegionId>): number {
  const owners = getOwnerByMesoId(world), neighbors = getNeighborsById(world), parcel = new Set(ids);
  let improvement = 0;
  for (const id of ids) for (const neighbor of neighbors.get(id) ?? []) {
    if (parcel.has(neighbor)) continue;
    const owner = selected.has(neighbor) ? to : owners.get(neighbor);
    improvement += Number(owner === to) - Number(owner === from);
  }
  return improvement;
}

/** Identify transfers that preserve existing provincial boundaries. */
export function getWholeProvinces(world: WorldState, owner: NationId, regionIds: readonly MesoRegionId[]) {
  const requested = new Set(regionIds);
  const provinces = world.macroRegions.filter((macro) =>
    macro.nationId === owner && macro.mesoRegionIds.length > 0 && macro.mesoRegionIds.every((id) => requested.has(id)));
  return provinces.reduce((sum, macro) => sum + macro.mesoRegionIds.length, 0) === regionIds.length ? provinces : null;
}

export function selectPeaceProvinces(
  world: WorldState,
  from: NationId,
  to: NationId,
  candidates: readonly MesoRegionId[],
  provinceLimit = Infinity,
  districtLimit = Infinity,
): MesoRegionId[] {
  const priority = new Set(candidates);
  if (!priority.size) return [];
  const capital = world.nations.find((nation) => nation.id === from)?.capitalMesoId;
  const provinces = world.macroRegions.filter((macro) => macro.nationId === from);
  const pending = provinces.filter(({ mesoRegionIds }) =>
    !mesoRegionIds.includes(capital!) && mesoRegionIds.some((id) => priority.has(id)) &&
    mesoRegionIds.every((id) => {
      const occupier = world.occupation.mesoById.get(id);
      return !occupier || occupier === to || occupier === from;
    }))
    .map(({ mesoRegionIds }) => ({ ids: mesoRegionIds,
      score: mesoRegionIds.filter((id) => priority.has(id)).length / mesoRegionIds.length }));
  const selected: MesoRegionId[] = [];
  for (let count = 0; count < Math.min(provinceLimit, provinces.length - 1); count++) {
    const selectedSet = new Set(selected);
    const ranked = pending.filter(({ ids }) => ids.length + selected.length <= districtLimit)
      .map((entry) => ({ entry, improvement: borderImprovement(world, from, to, entry.ids, selectedSet) }))
      .sort((a, b) => b.improvement - a.improvement || b.entry.score - a.entry.score);
    const next = ranked.find(({ entry }) => !getPeaceBorderIssue(world, [{ from, to, regionIds: [...selected, ...entry.ids] }]));
    if (!next) break;
    selected.push(...next.entry.ids);
    pending.splice(pending.indexOf(next.entry), 1);
  }
  return selected;
}
