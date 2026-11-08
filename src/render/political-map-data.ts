import { relationKey } from "../sim/diplomacy";
import { areFactionPartners, getNationFaction } from "../sim/factions";
import { identityHash } from "../sim/nation-identity";
import { findWar } from "../sim/war-state";
import { getMesoById, getOwnerByMesoId } from "../sim/world-cache";
import type { WorldState } from "../sim/world-state";
import type { NationId } from "../worldgen/nation";
import type { MesoRegionId } from "../worldgen/meso-region";
import { getNationColor } from "./nation-color";
export type DiplomaticStatus = "selected" | "friendly" | "neutral" | "hostile" | "war";
export const DIPLOMATIC_COLORS: Record<DiplomaticStatus, number> = {
  selected: 0x72b9ed, friendly: 0x55ba79, neutral: 0xe9cb68, hostile: 0xed984a, war: 0xe75b62,
};
export function getDiplomaticStatus(world: WorldState, focus: NationId, other: NationId): DiplomaticStatus {
  if (focus === other) return "selected";
  if (findWar(world.wars, focus, other)) return "war";
  const relation = world.diplomacy?.relations.get(relationKey(focus, other));
  if (areFactionPartners(world, focus, other) || relation?.treaties.some((treaty) =>
    treaty.type === "alliance" && treaty.expiresAtSlowTick > world.time.slowTick)) return "friendly";
  if (relation && (relation.opinion <= -20 || relation.tension >= 60 || relation.crisis)) return "hostile";
  return relation && relation.opinion >= 25 ? "friendly" : "neutral";
}
const FACTION_PALETTE = [0x6ba7df, 0xe5a364, 0xb295d9, 0x72c3aa, 0xe28fba, 0xc4cb72, 0x79c7d6, 0xd77c70];
export function getFactionColor(id: string): number { return FACTION_PALETTE[identityHash(id) % FACTION_PALETTE.length]!; }
export function getPoliticalFill(world: WorldState, nationId: NationId): number {
  const view = world.mapView;
  if (view?.mode === "diplomacy" && view.diplomaticFocusId) return DIPLOMATIC_COLORS[getDiplomaticStatus(world, view.diplomaticFocusId, nationId)];
  if (view?.mode === "factions") {
    const faction = getNationFaction(world, nationId);
    return faction ? getFactionColor(faction.id) : 0x7b8899;
  }
  return getNationColor(nationId);
}
export function classifyPoliticalBoundary(ownerA?: string, provinceA?: string, ownerB?: string, provinceB?: string): "national" | "province" | "none" {
  if (ownerA !== ownerB && (ownerA || ownerB)) return "national";
  if (ownerA && ownerB && provinceA !== provinceB) return "province";
  return "none";
}
export interface NationLabelAnchor { nationId: NationId; regionId: MesoRegionId; x: number; y: number; regionCount: number; primary: boolean }
export function getNationLabelAnchors(world: WorldState): NationLabelAnchor[] {
  const owners = getOwnerByMesoId(world), regions = getMesoById(world);
  const byNation = new Map<NationId, Set<MesoRegionId>>();
  for (const [id, owner] of owners) if (regions.get(id)?.type !== "sea") {
    const set = byNation.get(owner) ?? new Set(); set.add(id); byNation.set(owner, set);
  }
  const result: NationLabelAnchor[] = [];
  for (const [nationId, owned] of byNation) {
    const seen = new Set<MesoRegionId>(), components: MesoRegionId[][] = [];
    for (const id of owned) {
      if (seen.has(id)) continue;
      const component = [id]; seen.add(id);
      for (let index = 0; index < component.length; index += 1) for (const neighbor of regions.get(component[index]!)?.neighbors ?? []) {
        if (owned.has(neighbor.id) && !seen.has(neighbor.id)) { seen.add(neighbor.id); component.push(neighbor.id); }
      }
      components.push(component);
    }
    components.sort((a, b) => b.length - a.length || a[0]!.localeCompare(b[0]!));
    for (const [index, component] of components.entries()) {
      if (index > 0 && component.length < 4) continue;
      const center = component.reduce((sum, id) => ({ x: sum.x + regions.get(id)!.center.x / component.length, y: sum.y + regions.get(id)!.center.y / component.length }), { x: 0, y: 0 });
      const anchor = component.map((id) => regions.get(id)!).sort((a, b) =>
        Math.hypot(a.center.x - center.x, a.center.y - center.y) - Math.hypot(b.center.x - center.x, b.center.y - center.y) || a.id.localeCompare(b.id))[0]!;
      result.push({ nationId, regionId: anchor.id, ...anchor.center, regionCount: component.length, primary: index === 0 });
    }
  }
  return result;
}
