import { getInfluence, getRelation, hasTreaty, spendInfluence } from "./diplomacy";
import { areFactionPartners } from "./factions";
import { isNationActive } from "./nation-active";
import { getNationCharacter } from "./nation-character";
import { getNationIdeology } from "./nation-identity";
import { getNationalPolitics, increasePoliticalSupport } from "./politics";
import { getWarDeclarationMode, recordSimulationEvent } from "./simulation-settings";
import { getAdjacentNationPairs } from "./world-cache";
import type { WorldState } from "./world-state";
import { findWar } from "./war-state";
import type { NationId } from "../worldgen/nation";

export const POLITICAL_CAMPAIGN_COST = 18;
const CAMPAIGN_COOLDOWN = 120;

export function getPoliticalCampaignIssue(world: WorldState, sponsorId: NationId, targetId: NationId): string | null {
  if (getWarDeclarationMode(world) !== "diplomacy" || sponsorId === targetId) return "Select two nations with diplomacy enabled.";
  const sponsor = world.nations.find((nation) => nation.id === sponsorId && isNationActive(nation));
  const target = world.nations.find((nation) => nation.id === targetId && isNationActive(nation));
  if (!sponsor || !target || findWar(world.wars, sponsorId, targetId)) return "Political outreach requires two active nations at peace with each other.";
  const hasContact = getAdjacentNationPairs(world).some(([a, b]) =>
    a === sponsorId && b === targetId || b === sponsorId && a === targetId) ||
    areFactionPartners(world, sponsorId, targetId) ||
    hasTreaty(world, sponsorId, targetId, "trade") || hasTreaty(world, sponsorId, targetId, "alliance");
  if (!hasContact) return "Requires a shared border, trade pact, alliance or faction.";
  if (getRelation(world, sponsorId, targetId).crisis) return "Political outreach is suspended during a diplomatic crisis.";
  const ideology = getNationIdeology(world, sponsorId);
  const sourcePolitics = getNationalPolitics(world, sponsor);
  const targetPolitics = getNationalPolitics(world, target);
  const now = world.time.slowTick;
  if ((sourcePolitics.nextForeignCampaignAt ?? 0) > now || (targetPolitics.nextIncomingCampaignAt ?? 0) > now) {
    return "Wait for the previous campaign to settle.";
  }
  if ((targetPolitics.support.get(ideology.id) ?? 0) >= 90) return "This ideology already dominates local politics.";
  return getInfluence(world, sponsorId) < POLITICAL_CAMPAIGN_COST ? "Insufficient influence." : null;
}

export function launchPoliticalCampaign(world: WorldState, sponsorId: NationId, targetId: NationId): boolean {
  if (getPoliticalCampaignIssue(world, sponsorId, targetId) || !spendInfluence(world, sponsorId, POLITICAL_CAMPAIGN_COST)) return false;
  const sponsor = world.nations.find((nation) => nation.id === sponsorId)!;
  const target = world.nations.find((nation) => nation.id === targetId)!;
  const sourcePolitics = getNationalPolitics(world, sponsor);
  const targetPolitics = getNationalPolitics(world, target);
  const ideology = getNationIdeology(world, sponsorId);
  const agrees = targetPolitics.governingIdeologyId === ideology.id;
  const gained = increasePoliticalSupport(targetPolitics, ideology.id, targetPolitics.system === "democracy" ? 9 : 5);
  sourcePolitics.nextForeignCampaignAt = world.time.slowTick + CAMPAIGN_COOLDOWN;
  targetPolitics.nextIncomingCampaignAt = world.time.slowTick + CAMPAIGN_COOLDOWN;

  const relation = getRelation(world, sponsorId, targetId);
  if (agrees) {
    relation.opinion = Math.min(100, relation.opinion + 4);
    relation.trust = Math.min(100, relation.trust + 2);
  } else {
    relation.tension = Math.min(100, relation.tension + 9);
    relation.trust = Math.max(0, relation.trust - 4);
  }
  recordSimulationEvent(world, { category: "politics", nationIds: [sponsorId, targetId],
    message: `${sponsorId} promoted ${ideology.name} in ${targetId}: support +${gained} points${agrees ? " and closer relations" : " at the cost of diplomatic tension"}.` });
  return true;
}

export function updateForeignPoliticalInfluence(world: WorldState): void {
  const now = world.time.slowTick;
  if (getWarDeclarationMode(world) !== "diplomacy" || now < 180 || now % 60 !== 0) return;
  const contacts = new Map<NationId, Set<NationId>>();
  const addContact = (a: NationId, b: NationId) => {
    const partners = contacts.get(a) ?? new Set<NationId>();
    partners.add(b);
    contacts.set(a, partners);
  };
  for (const [a, b] of getAdjacentNationPairs(world)) {
    addContact(a, b);
    addContact(b, a);
  }
  for (const relation of world.diplomacy?.relations.values() ?? []) {
    if (!relation.treaties.some((treaty) => treaty.expiresAtSlowTick > now &&
      (treaty.type === "trade" || treaty.type === "alliance"))) continue;
    addContact(relation.nationAId, relation.nationBId);
    addContact(relation.nationBId, relation.nationAId);
  }

  for (const sponsor of [...world.nations].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!isNationActive(sponsor) || !contacts.has(sponsor.id) || getInfluence(world, sponsor.id) < POLITICAL_CAMPAIGN_COST + 30) continue;
    if (world.wars.some((war) => war.nationAId === sponsor.id || war.nationBId === sponsor.id)) continue;
    const character = getNationCharacter(world, sponsor.id);
    const ideology = getNationIdeology(world, sponsor.id).id;
    const candidates = [...contacts.get(sponsor.id)!].flatMap((id) => {
      const target = world.nations.find((nation) => nation.id === id && isNationActive(nation));
      if (!target || getPoliticalCampaignIssue(world, sponsor.id, id)) return [];
      const politics = getNationalPolitics(world, target);
      const support = politics.support.get(ideology) ?? 0;
      const relation = getRelation(world, sponsor.id, id);
      const agrees = politics.governingIdeologyId === ideology;
      if (agrees ? character.cooperation < 0.6 || support >= 56 || relation.opinion < 20
        : character.aggression < 0.5 || support < 15 || relation.tension >= 60 || areFactionPartners(world, sponsor.id, id)) return [];
      return [{ id, score: agrees ? 56 - support : support + 10 }];
    }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    if (candidates[0]) launchPoliticalCampaign(world, sponsor.id, candidates[0].id);
  }
}
