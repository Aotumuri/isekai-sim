import { getDefensePact, getInfluence, getRelation, hasTreaty, spendInfluence } from "./diplomacy";
import { areFactionPartners } from "./factions";
import { isNationActive } from "./nation-active";
import { hasPoliticalTurbulence, recordSimulationEvent } from "./simulation-settings";
import { getSubjectOverlord } from "./subject-governments";
import { buildWarAdjacency, isAtWar } from "./war-state";
import type { WorldState } from "./world-state";

export function updateDefensePacts(world: WorldState): void {
  const now = world.time.slowTick;
  if (!hasPoliticalTurbulence(world) || now < 90 || now % 30 !== 0) return;
  const active = new Set(world.nations.filter(isNationActive).map(({ id }) => id));
  const wars = buildWarAdjacency(world.wars);
  for (const coalition of world.commonThreatCoalitions.coalitions) {
    const threat = coalition.targetNationId;
    if (coalition.pendingDissolutionReason || !active.has(threat) || now - coalition.formedAtSlowTick < 30) continue;
    const members = coalition.memberNationIds.filter((id) => active.has(id) && !getSubjectOverlord(world, id) &&
      !hasTreaty(world, id, threat, "alliance") && !areFactionPartners(world, id, threat));
    const candidates = members.flatMap((a, index) => members.slice(index + 1).flatMap((b) => {
      if (isAtWar(a, b, wars) || areFactionPartners(world, a, b) || hasTreaty(world, a, b, "alliance") ||
        getDefensePact(world, a, b) || getInfluence(world, a) < 10 || getInfluence(world, b) < 10) return [];
      const relation = getRelation(world, a, b);
      return !relation.crisis && relation.opinion >= -15 && relation.trust >= 30 && relation.tension < 55 ? [relation] : [];
    }));
    const partner = candidates.sort((a, b) => (b.opinion + b.trust) - (a.opinion + a.trust))[0];
    if (!partner) continue;
    const { nationAId: a, nationBId: b } = partner;
    spendInfluence(world, a, 10);
    spendInfluence(world, b, 10);
    partner.defensePact = { against: threat, expiresAt: now + 240 };
    partner.trust = Math.min(100, partner.trust + 5);
    recordSimulationEvent(world, { category: "diplomacy", nationIds: [a, b, threat],
      message: `${a} and ${b} signed a temporary mutual defense pact against ${threat}.` });
  }
}
