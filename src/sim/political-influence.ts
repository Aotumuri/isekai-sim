import { getInfluence, getRelation, hasTreaty, spendInfluence } from "./diplomacy";
import { areFactionPartners } from "./factions";
import { FIRST_FOREIGN_ADVOCACY_TICK, getForeignAdvocacySchedule, takePendingRegionalDemands } from "./foreign-advocacy-schedule";
import { isNationActive } from "./nation-active";
import { getNationCharacter } from "./nation-character";
import { getNationIdeology } from "./nation-identity";
import { liveNegotiations, updateForeignBacking, updatePoliticalAdvocacy } from "./political-advocacy";
import { getNationalPolitics, increasePoliticalSupport } from "./politics";
import { getWarDeclarationMode, hasPoliticalTurbulence, recordSimulationEvent } from "./simulation-settings";
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

/**
 * Bounded contact index for foreign political activity: a shared border, an alliance,
 * a trade pact or a common faction. Built once per evaluation pass. Faction membership
 * is grouped by faction so the index never scans every nation pair.
 */
export function getPoliticalContacts(world: WorldState, targets?: ReadonlySet<NationId>): Map<NationId, Set<NationId>> {
  const contacts = new Map<NationId, Set<NationId>>();
  const addContact = (a: NationId, b: NationId) => {
    if (targets && !targets.has(a)) return;
    const partners = contacts.get(a) ?? new Set<NationId>();
    partners.add(b);
    contacts.set(a, partners);
  };
  for (const [a, b] of getAdjacentNationPairs(world)) {
    addContact(a, b);
    addContact(b, a);
  }
  const now = world.time.slowTick;
  for (const relation of world.diplomacy?.relations.values() ?? []) {
    if (!relation.treaties.some((treaty) => treaty.expiresAtSlowTick > now &&
      (treaty.type === "trade" || treaty.type === "alliance"))) continue;
    addContact(relation.nationAId, relation.nationBId);
    addContact(relation.nationBId, relation.nationAId);
  }
  // Common faction membership is a valid political contact even without a shared border.
  // Group once by faction instead of scanning every nation pair.
  const factionMembers = new Map<string, NationId[]>();
  for (const [nationId, faction] of world.factions?.factionByNationId ?? []) {
    const members = factionMembers.get(faction.id);
    if (members) members.push(nationId);
    else factionMembers.set(faction.id, [nationId]);
  }
  for (const factionId of [...factionMembers.keys()].sort()) {
    const members = factionMembers.get(factionId)!.sort();
    if (targets) {
      for (const a of members) {
        if (!targets.has(a)) continue;
        for (const b of members) if (a !== b) addContact(a, b);
      }
      continue;
    }
    for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) {
      addContact(members[i]!, members[j]!);
      addContact(members[j]!, members[i]!);
    }
  }
  return contacts;
}

function updateIdeologicalCampaigns(world: WorldState, contacts: ReadonlyMap<NationId, ReadonlySet<NationId>>): void {
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

export function updateForeignPoliticalInfluence(world: WorldState): void {
  const now = world.time.slowTick;
  const schedule = getForeignAdvocacySchedule(world);
  // Advocacy runs before this slow tick's governance. A queued demand is from
  // an earlier completed tick, and contacts are read from the current world.
  const pending = schedule === "event" ? takePendingRegionalDemands(world) : undefined;
  if (getWarDeclarationMode(world) !== "diplomacy" || now < 180) return;
  // Support that is not renewed fades, regardless of the campaign cadence.
  if (now % 10 === 0) updateForeignBacking(world);
  const campaignBoundary = now % 60 === 0;
  const campaignContacts = campaignBoundary ? getPoliticalContacts(world) : undefined;
  if (campaignContacts) updateIdeologicalCampaigns(world, campaignContacts);
  if (!hasPoliticalTurbulence(world) || now < FIRST_FOREIGN_ADVOCACY_TICK) return;
  const screen = schedule === "periodic" ? campaignBoundary :
    schedule === "100-day" ? now % 10 === 0 : now === FIRST_FOREIGN_ADVOCACY_TICK || !!pending?.length;
  if (!screen) return;
  const evaluate = () => {
    const negotiations = liveNegotiations(world, schedule === "event" && now !== FIRST_FOREIGN_ADVOCACY_TICK ? pending : undefined);
    if (!negotiations.length) return;
    const contacts = campaignContacts ?? getPoliticalContacts(world, new Set(negotiations.map(([, { owner }]) => owner)));
    updatePoliticalAdvocacy(world, contacts, negotiations);
  };
  const instrumentation = world.instrumentation;
  if (!instrumentation) { evaluate(); return; }
  const start = performance.now();
  const finishMeasurement = instrumentation.startForeignAdvocacyMeasurement?.();
  evaluate();
  finishMeasurement?.();
  instrumentation.recordDuration("politics.foreignAdvocacy", performance.now() - start);
}
