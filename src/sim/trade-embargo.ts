import type { NationId } from "../worldgen/nation";
import { getDiplomacyState, getRelation, hasTreaty, relationKey } from "./diplomacy";
import { isNationActive } from "./nation-active";
import { hasPublicSanctions } from "./persecution-reaction";
import { getWarDeclarationMode, hasPoliticalTurbulence, recordSimulationEvent } from "./simulation-settings";
import type { WorldState } from "./world-state";

export function hasTradeEmbargo(world: WorldState, issuer: NationId, target: NationId): boolean {
  return world.tradeEmbargoes?.get(issuer)?.has(target) ?? false;
}

export function isTradeEmbargoed(world: WorldState, a: NationId, b: NationId): boolean {
  return hasTradeEmbargo(world, a, b) || hasTradeEmbargo(world, b, a) ||
    hasPublicSanctions(world, a, b) || hasPublicSanctions(world, b, a) ||
    (hasPoliticalTurbulence(world) && (world.diplomacy?.relations.get(relationKey(a, b))?.factionSanctionsUntil ?? 0) > world.time.slowTick);
}

export function updateFactionSanctions(world: WorldState): void {
  const now = world.time.slowTick;
  if (!hasPoliticalTurbulence(world) || !world.settings?.tradeEnabled || now % 20 !== 0 || !world.factions?.factions.length) return;
  const active = new Set(world.nations.filter(isNationActive).map(({ id }) => id));
  const threats = world.wars.filter((war) => !war.cause || war.cause === "diplomatic-crisis")
    .map(({ aggressorId, defenderId }) => ({ aggressorId, defenderId }));
  for (const relation of getDiplomacyState(world).relations.values()) {
    const aggressorId = relation.crisis?.aggressorId;
    if (aggressorId) threats.push({ aggressorId, defenderId: aggressorId === relation.nationAId ? relation.nationBId : relation.nationAId });
  }
  for (const faction of world.factions.factions) {
    const members = faction.memberIds.filter((id) => active.has(id));
    if (members.length < 2) continue;
    const aggressors = new Set(threats.filter(({ defenderId, aggressorId }) =>
      members.includes(defenderId) && active.has(aggressorId) && !members.includes(aggressorId)).map(({ aggressorId }) => aggressorId));
    for (const aggressor of aggressors) {
      const participants: NationId[] = [];
      for (const member of members) {
        if (hasTreaty(world, member, aggressor, "alliance")) continue;
        const relation = getRelation(world, member, aggressor);
        const renewing = (relation.factionSanctionsUntil ?? 0) > now;
        relation.factionSanctionsUntil = now + 120;
        if (renewing) continue;
        relation.opinion = Math.max(-100, relation.opinion - 10);
        relation.tension = Math.min(100, relation.tension + 14);
        participants.push(member);
      }
      if (participants.length) recordSimulationEvent(world, { category: "trade", nationIds: [...participants, aggressor],
        message: `${faction.name} coordinated trade sanctions against ${aggressor} after aggression against a member.` });
    }
  }
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
