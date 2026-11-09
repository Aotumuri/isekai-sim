import type { NationId } from "../worldgen/nation";
import { getRelation } from "./diplomacy";
import { isNationActive } from "./nation-active";
import { getWarDeclarationMode, recordSimulationEvent } from "./simulation-settings";
import type { WorldState } from "./world-state";

export function hasTradeEmbargo(world: WorldState, issuer: NationId, target: NationId): boolean {
  return world.tradeEmbargoes?.get(issuer)?.has(target) ?? false;
}

export function isTradeEmbargoed(world: WorldState, a: NationId, b: NationId): boolean {
  return hasTradeEmbargo(world, a, b) || hasTradeEmbargo(world, b, a);
}

export function setTradeEmbargo(world: WorldState, issuer: NationId, target: NationId, enabled: boolean): boolean {
  if (issuer === target || getWarDeclarationMode(world) !== "diplomacy" || !world.settings?.tradeEnabled ||
    ![issuer, target].every((id) => world.nations.some((nation) => nation.id === id && isNationActive(nation))) ||
    hasTradeEmbargo(world, issuer, target) === enabled) return false;
  const embargoes = world.tradeEmbargoes ??= new Map();
  if (enabled) {
    const targets = embargoes.get(issuer) ?? new Set<NationId>();
    targets.add(target);
    embargoes.set(issuer, targets);
    const relation = getRelation(world, issuer, target);
    relation.opinion = Math.max(-100, relation.opinion - 8);
    relation.tension = Math.min(100, relation.tension + 5);
  } else {
    const targets = embargoes.get(issuer)!;
    targets.delete(target);
    if (!targets.size) embargoes.delete(issuer);
  }
  recordSimulationEvent(world, { category: "trade", nationIds: [issuer, target],
    message: enabled ? `${issuer} embargoed trade with ${target}.` : `${issuer} lifted its embargo on ${target}.` });
  return true;
}
